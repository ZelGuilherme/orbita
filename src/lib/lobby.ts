import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { APP_SLUG, PROTOCOL_VERSION, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './config';
import { keepSignaling, openPeer } from './peer';
import { clampText, randomId, sanitizeColor, sanitizeName, sanitizeRoomName } from './util';
import { createLocalPair, PeerWire, type Wire } from './wire';

/**
 * Lista de órbitas abertas ("saguão"), sem servidor próprio.
 *
 * O primeiro Órbita aberto reserva um ID fixo no servidor de sinalização e vira o ponto de
 * encontro; os outros se conectam a ele. Se ele fecha, todo mundo tenta de novo depois de um
 * atraso aleatório e o primeiro a reservar o ID vira o novo ponto (o servidor de sinalização
 * garante que só um consegue). Os hosts anunciam a sala (nome, host, quantas pessoas), nunca o
 * código. "Pedir para entrar" passa pelo ponto de encontro até o host; se ele aceitar, o código
 * vai DIRETO do host para quem pediu (conexão P2P própria), sem passar pelo ponto de encontro.
 */

export interface Listing {
  id: string;
  name: string;
  hostName: string;
  hostColor: string;
  members: number;
  locked: boolean;
}

export type ListingInfo = Omit<Listing, 'id'>;

export interface Knock {
  knockId: string;
  name: string;
  color: string;
  /** Peer de quem pediu (para entregar o código direto). */
  peerId: string;
}

type ToServer =
  | { t: 'hello'; v: number }
  | { t: 'pong' }
  | { t: 'announce'; room: ListingInfo | null }
  | { t: 'knock'; listingId: string; name: string; color: string }
  | { t: 'answer'; knockId: string; accept: boolean };

type ToClient =
  | { t: 'rooms'; rooms: Listing[] }
  | { t: 'ping' }
  | { t: 'knock'; knock: Knock }
  | { t: 'knocked'; knockId: string; listingId: string }
  | { t: 'answer'; knockId: string; accept: boolean }
  | { t: 'gone'; listingId: string };

const LOBBY_VERSION = 1;
const MAX_CLIENTS = 300;
const MAX_LISTINGS = 200;
const PING_MS = 10_000;
const CLIENT_TIMEOUT_MS = 35_000;
const SERVER_TIMEOUT_MS = 30_000;
const KNOCK_GAP_MS = 4_000;
const KNOCK_TTL_MS = 90_000;
const CODE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** ID do ponto de encontro. Em desenvolvimento dá para trocar (os testes usam um só deles). */
export function lobbyPeerId(): string {
  if (import.meta.env.DEV) {
    try {
      const custom = localStorage.getItem('orbita.lobbyId');
      if (custom && /^[a-z0-9-]{6,60}$/.test(custom)) return custom;
    } catch {
      /* sem armazenamento */
    }
  }
  return `${APP_SLUG}-v${PROTOCOL_VERSION}-saguao`;
}

function validListing(value: unknown): ListingInfo | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<ListingInfo>;
  return {
    name: sanitizeRoomName(v.name),
    hostName: sanitizeName(v.hostName),
    hostColor: sanitizeColor(v.hostColor),
    members: Math.max(1, Math.min(99, Math.floor(Number(v.members) || 1))),
    locked: v.locked === true,
  };
}

interface ServerClient {
  wire: Wire;
  peerId: string;
  listing: Listing | null;
  lastSeen: number;
  knockAt: number;
  hello: boolean;
}

/** O ponto de encontro: roda na aba que conseguiu reservar o ID. */
class LobbyServer {
  private clients = new Map<Wire, ServerClient>();
  private knocks = new Map<string, { from: Wire; to: Wire; at: number }>();
  private heartbeat: number;
  private pending = 0;
  private stopped = false;

  constructor(private peer: Peer) {
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('error', (err) => {
      if (err.type !== 'peer-unavailable') console.warn('[saguão]', err.type, err.message);
    });
    keepSignaling(peer, () => !this.stopped);
    this.heartbeat = window.setInterval(() => this.tick(), PING_MS);
  }

  attachLocal(wire: Wire, peerId: string) {
    this.add(wire, peerId);
  }

  private accept(conn: DataConnection) {
    if (this.stopped || this.clients.size >= MAX_CLIENTS) {
      conn.close();
      return;
    }
    const timer = window.setTimeout(() => conn.close(), 15_000);
    conn.once('open', () => {
      clearTimeout(timer);
      if (this.stopped) conn.close();
      else this.add(new PeerWire(conn), conn.peer);
    });
  }

  private add(wire: Wire, peerId: string) {
    const client: ServerClient = { wire, peerId, listing: null, lastSeen: Date.now(), knockAt: 0, hello: false };
    this.clients.set(wire, client);
    wire.onMessage = (msg: ToServer) => {
      client.lastSeen = Date.now();
      this.handle(client, msg);
    };
    wire.onClose = () => this.drop(client);
  }

  private drop(client: ServerClient) {
    if (!this.clients.delete(client.wire)) return;
    client.wire.close();
    for (const [id, knock] of this.knocks) {
      if (knock.to === client.wire) {
        // o host sumiu: quem pediu fica sabendo
        this.send(knock.from, { t: 'answer', knockId: id, accept: false });
        this.knocks.delete(id);
      } else if (knock.from === client.wire) {
        this.knocks.delete(id);
      }
    }
    if (client.listing) this.publishSoon();
  }

  private handle(client: ServerClient, msg: ToServer) {
    if (!msg || typeof msg !== 'object' || this.stopped) return;
    switch (msg.t) {
      case 'hello':
        if (msg.v !== LOBBY_VERSION) {
          client.wire.close();
          this.drop(client);
          return;
        }
        client.hello = true;
        this.send(client.wire, { t: 'rooms', rooms: this.listings() });
        return;
      case 'pong':
        return;
      case 'announce': {
        if (!client.hello) return;
        const info = msg.room === null ? null : validListing(msg.room);
        if (!info) {
          if (client.listing) {
            client.listing = null;
            this.publishSoon();
          }
          return;
        }
        if (!client.listing && this.listings().length >= MAX_LISTINGS) return;
        client.listing = { id: client.listing?.id ?? randomId(10), ...info };
        this.publishSoon();
        return;
      }
      case 'knock': {
        if (!client.hello || typeof msg.listingId !== 'string') return;
        const now = Date.now();
        if (now - client.knockAt < KNOCK_GAP_MS) return;
        client.knockAt = now;
        const host = [...this.clients.values()].find((c) => c.listing?.id === msg.listingId);
        if (!host || host === client) {
          this.send(client.wire, { t: 'gone', listingId: msg.listingId });
          return;
        }
        // um pedido por vez para cada pessoa
        for (const [id, knock] of this.knocks) if (knock.from === client.wire || now - knock.at > KNOCK_TTL_MS) this.knocks.delete(id);
        const knockId = randomId(12);
        this.knocks.set(knockId, { from: client.wire, to: host.wire, at: now });
        this.send(host.wire, { t: 'knock', knock: { knockId, name: sanitizeName(msg.name), color: sanitizeColor(msg.color), peerId: client.peerId } });
        this.send(client.wire, { t: 'knocked', knockId, listingId: msg.listingId });
        return;
      }
      case 'answer': {
        const knock = typeof msg.knockId === 'string' ? this.knocks.get(msg.knockId) : undefined;
        if (!knock || knock.to !== client.wire) return;
        this.knocks.delete(msg.knockId);
        this.send(knock.from, { t: 'answer', knockId: msg.knockId, accept: !!msg.accept });
        return;
      }
      default:
        return;
    }
  }

  private listings(): Listing[] {
    return [...this.clients.values()].flatMap((c) => (c.listing ? [c.listing] : [])).sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
  }

  /** Junta várias mudanças seguidas num único envio da lista. */
  private publishSoon() {
    if (this.pending || this.stopped) return;
    this.pending = window.setTimeout(() => {
      this.pending = 0;
      const rooms = this.listings();
      for (const c of this.clients.values()) if (c.hello) this.send(c.wire, { t: 'rooms', rooms });
    }, 300);
  }

  private tick() {
    const now = Date.now();
    for (const client of [...this.clients.values()]) {
      if (client.wire.kind === 'local') continue;
      if (now - client.lastSeen > CLIENT_TIMEOUT_MS) this.drop(client);
      else this.send(client.wire, { t: 'ping' });
    }
  }

  private send(wire: Wire, msg: ToClient) {
    wire.send(msg);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.pending);
    for (const c of this.clients.values()) c.wire.close();
    this.clients.clear();
    this.knocks.clear();
    this.peer.destroy();
  }
}

export interface LobbyEvents {
  rooms(rooms: Listing[]): void;
  online(online: boolean): void;
  /** (host) alguém quer entrar. */
  knock(knock: Knock): void;
  /** (quem pediu) o pedido chegou ao host. */
  knocked(knockId: string, listingId: string): void;
  /** (quem pediu) o host respondeu; aceitando, o código chega em seguida por invite(). */
  answer(knockId: string, accept: boolean): void;
  /** (quem pediu) o código da sala, entregue direto pelo host. */
  invite(knockId: string, code: string): void;
  /** (quem pediu) a sala saiu da lista antes do pedido chegar. */
  gone(listingId: string): void;
}

/** Cada aba do Órbita: conecta ao ponto de encontro (ou vira ele) e mantém a lista. */
export class LobbyClient {
  private peer: Peer | null = null;
  private wire: Wire | null = null;
  private server: LobbyServer | null = null;
  private announced: ListingInfo | null = null;
  private announceTimer = 0;
  private lastAnnounce = 0;
  private lastPing = 0;
  private watchdog = 0;
  private retryTimer = 0;
  private attempts = 0;
  private connecting = false;
  private stopped = false;
  /** Pedidos que eu fiz e ainda esperam o código. */
  private waiting = new Set<string>();
  /** Pedidos recebidos (sou host): para entregar o código ao peer certo. */
  private received = new Map<string, Knock>();

  constructor(private ev: LobbyEvents) {}

  get isServer() {
    return !!this.server;
  }

  async start() {
    try {
      const peer = await openPeer();
      if (this.stopped) {
        peer.destroy();
        return;
      }
      this.peer = peer;
      peer.on('connection', (conn) => {
        if ((conn.metadata as { kind?: string } | undefined)?.kind === 'orbita-invite') this.receiveInvite(conn);
      });
      peer.on('error', (err) => {
        if (err.type !== 'peer-unavailable') console.warn('[saguão]', err.type, err.message);
      });
      keepSignaling(peer, () => !this.stopped);
      this.watchdog = window.setInterval(() => this.check(), 5_000);
      void this.connect();
    } catch {
      this.scheduleRetry();
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    clearTimeout(this.announceTimer);
    this.wire?.close();
    this.wire = null;
    this.server?.stop();
    this.server = null;
    this.peer?.destroy();
    this.peer = null;
  }

  /** (host) Anuncia a minha sala (null = tira da lista). Mudanças seguidas saem juntas. */
  announce(room: ListingInfo | null) {
    if (JSON.stringify(room) === JSON.stringify(this.announced)) return;
    this.announced = room;
    clearTimeout(this.announceTimer);
    const wait = Math.max(0, this.lastAnnounce + 1_500 - Date.now());
    this.announceTimer = window.setTimeout(() => {
      this.lastAnnounce = Date.now();
      this.wire?.send({ t: 'announce', room: this.announced } satisfies ToServer);
    }, wait);
  }

  knock(listingId: string, name: string, color: string): boolean {
    if (!this.wire) return false;
    this.wire.send({ t: 'knock', listingId, name, color } satisfies ToServer);
    return true;
  }

  cancelKnock(knockId: string) {
    this.waiting.delete(knockId);
  }

  /** (host) Responde a um pedido; aceitando, entrega o código direto para quem pediu. */
  answer(knockId: string, accept: boolean, code?: string) {
    const knock = this.received.get(knockId);
    this.received.delete(knockId);
    this.wire?.send({ t: 'answer', knockId, accept } satisfies ToServer);
    if (accept && knock && code && this.peer) this.deliver(knock, code);
  }

  private deliver(knock: Knock, code: string) {
    const conn = this.peer?.connect(knock.peerId, { reliable: true, serialization: 'raw', metadata: { kind: 'orbita-invite' } }) as DataConnection | undefined;
    if (!conn) return;
    const close = window.setTimeout(() => conn.close(), 20_000);
    conn.on('open', () => {
      conn.send(JSON.stringify({ knockId: knock.knockId, code }));
      window.setTimeout(() => {
        clearTimeout(close);
        conn.close();
      }, 3_000);
    });
  }

  private receiveInvite(conn: DataConnection) {
    const timer = window.setTimeout(() => conn.close(), 20_000);
    conn.on('data', (data) => {
      clearTimeout(timer);
      conn.close();
      if (typeof data !== 'string' || data.length > 200) return;
      let msg: { knockId?: unknown; code?: unknown };
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      // só aceita o código de um pedido que eu fiz (e que o ponto de encontro disse que foi aceito ou ainda espera)
      if (typeof msg.knockId !== 'string' || !this.waiting.has(msg.knockId) || typeof msg.code !== 'string' || !CODE.test(msg.code)) return;
      this.waiting.delete(msg.knockId);
      this.ev.invite(msg.knockId, msg.code);
    });
  }

  // ───────────────────────── conexão com o ponto de encontro ─────────────────────────

  private async connect() {
    if (this.stopped || this.connecting || this.wire || !this.peer) return;
    this.connecting = true;
    try {
      if (await this.reach()) return;
      if (await this.claim()) return;
    } finally {
      this.connecting = false;
    }
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.attempts++;
    // atraso aleatório: se o ponto de encontro caiu, nem todo mundo tenta ao mesmo tempo
    const base = Math.min(20_000, 600 * 2 ** Math.min(this.attempts, 5));
    this.retryTimer = window.setTimeout(() => {
      if (!this.peer) void this.start();
      else void this.connect();
    }, base * (0.5 + Math.random()));
  }

  /** Tenta se conectar ao ponto de encontro. */
  private reach(): Promise<boolean> {
    const peer = this.peer;
    const id = lobbyPeerId();
    if (!peer || peer.disconnected) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean, conn?: DataConnection) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        peer.off('error', onError);
        if (!ok) {
          try {
            conn?.close();
          } catch {
            /* ignora */
          }
        }
        resolve(ok);
      };
      const onError = (err: { type: string; message: string }) => {
        if (err.type === 'peer-unavailable' && err.message.includes(id)) finish(false, conn);
      };
      const timer = window.setTimeout(() => finish(false, conn), 9_000);
      peer.on('error', onError);
      const conn = peer.connect(id, { reliable: true, serialization: 'raw' }) as DataConnection | undefined;
      if (!conn) {
        finish(false);
        return;
      }
      conn.on('open', () => {
        if (done || this.stopped) {
          conn.close();
          return;
        }
        finish(true);
        this.adopt(new PeerWire(conn));
      });
      conn.on('close', () => finish(false));
    });
  }

  /** Ninguém no ponto de encontro: tenta virar ele. */
  private async claim(): Promise<boolean> {
    if (!this.peer || this.stopped) return false;
    let serverPeer: Peer;
    try {
      serverPeer = await openPeer(lobbyPeerId(), 10_000);
    } catch {
      // outra aba ganhou a corrida: na próxima tentativa conecta a ela
      return false;
    }
    if (this.stopped || !this.peer) {
      serverPeer.destroy();
      return false;
    }
    this.server = new LobbyServer(serverPeer);
    const [mine, theirs] = createLocalPair();
    this.server.attachLocal(theirs, this.peer.id);
    this.adopt(mine);
    return true;
  }

  private adopt(wire: Wire) {
    this.wire = wire;
    this.attempts = 0;
    this.lastPing = Date.now();
    wire.onMessage = (msg: ToClient) => this.handle(msg);
    wire.onClose = () => this.lost();
    wire.send({ t: 'hello', v: LOBBY_VERSION } satisfies ToServer);
    if (this.announced) {
      this.lastAnnounce = Date.now();
      wire.send({ t: 'announce', room: this.announced } satisfies ToServer);
    }
    this.ev.online(true);
  }

  private lost() {
    if (!this.wire) return;
    this.wire = null;
    this.received.clear();
    this.ev.online(false);
    this.ev.rooms([]);
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.scheduleRetry();
  }

  private check() {
    if (this.stopped) return;
    if (this.wire && this.wire.kind === 'peer' && Date.now() - this.lastPing > SERVER_TIMEOUT_MS) {
      this.wire.close();
      this.lost();
    }
  }

  private handle(msg: ToClient) {
    if (!msg || typeof msg !== 'object') return;
    this.lastPing = Date.now();
    switch (msg.t) {
      case 'ping':
        this.wire?.send({ t: 'pong' } satisfies ToServer);
        return;
      case 'rooms':
        if (Array.isArray(msg.rooms)) {
          this.ev.rooms(
            msg.rooms.slice(0, MAX_LISTINGS).flatMap((r) => {
              const info = validListing(r);
              return info && typeof r.id === 'string' && /^[a-z0-9]{6,16}$/.test(r.id) ? [{ id: r.id, ...info }] : [];
            }),
          );
        }
        return;
      case 'knock': {
        const k = msg.knock;
        if (!k || typeof k.knockId !== 'string' || typeof k.peerId !== 'string') return;
        const knock: Knock = { knockId: k.knockId, peerId: k.peerId, name: sanitizeName(k.name), color: sanitizeColor(k.color) };
        this.received.set(knock.knockId, knock);
        this.ev.knock(knock);
        return;
      }
      case 'knocked':
        if (typeof msg.knockId !== 'string') return;
        this.waiting.clear();
        this.waiting.add(msg.knockId);
        this.ev.knocked(msg.knockId, clampText(msg.listingId, 16));
        return;
      case 'answer':
        if (typeof msg.knockId !== 'string') return;
        if (!msg.accept) this.waiting.delete(msg.knockId);
        this.ev.answer(msg.knockId, !!msg.accept);
        return;
      case 'gone':
        this.ev.gone(clampText(msg.listingId, 16));
        return;
      default:
        return;
    }
  }
}
