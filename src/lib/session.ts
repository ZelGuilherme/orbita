import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { APP_BUILD } from './build';
import { HUB_TIMEOUT_MS, MAX_MESSAGES_PER_CHANNEL, MIGRATION_GIVE_UP_MS, PROTOCOL_VERSION } from './config';
import { Hub, createRoom, hubPeerId } from './hub';
import { keepSignaling, openPeer, PeerOpenError } from './peer';
import type { OrbitStyle } from './orbitPath';
import type { PlanetStyle } from './planet';
import type { ChatMessage, ClientMsg, FxStroke, HubMsg, LiveFx, Presence, RejectReason, RoomState } from './protocol';
import { roomCode } from './util';
import { createLocalPair, PeerWire, type Wire } from './wire';

/**
 * A sessão de um participante numa sala: o peer de mídia, a conexão com o hub e a
 * migração de host. Se o hub some, o membro mais antigo assume (os outros esperam a
 * vez dele com atrasos crescentes). O servidor de sinalização garante que só um
 * consegue reservar o ID da sala, então nunca existem dois hosts.
 */

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type EndReason = 'left' | 'ended' | 'kicked' | 'banned' | 'lost';

export class JoinError extends Error {
  constructor(
    readonly code: 'not-found' | 'timeout' | 'closed' | 'signaling' | 'rejected',
    readonly reason?: RejectReason,
  ) {
    super(code);
  }
}

export interface SessionHandlers {
  welcome(state: RoomState, messages: ChatMessage[]): void;
  state(state: RoomState): void;
  chat(message: ChatMessage): void;
  chatUpdate(message: ChatMessage): void;
  chatDelete(id: string, channelId: string): void;
  typing(memberId: string, channelId: string): void;
  speaking(memberId: string, on: boolean): void;
  sound(from: string, id: string): void;
  liveViewer(viewerId: string, viewerPeerId: string, on: boolean): void;
  fx(from: string, streamerId: string, fx: LiveFx): void;
  fxSync(streamerId: string, strokes: FxStroke[]): void;
  avatars(avatars: Record<string, string>): void;
  avatar(memberId: string, avatar: string | null): void;
  status(status: SessionStatus, detail?: 'loss' | 'transfer'): void;
  ended(reason: EndReason): void;
  becameHost(): void;
}

export interface Identity {
  id: string;
  name: string;
  color: string;
  avatar?: string;
  planet?: PlanetStyle;
  orbit?: OrbitStyle;
}

interface Migration {
  startedAt: number;
  /** A partir de quando é a minha vez de tentar virar host. */
  claimAt: number;
  /** Próxima tentativa de reservar o ID da sala (depois de uma tentativa falhar). */
  nextClaim: number;
  previousHostId: string;
  reason: 'loss' | 'transfer';
  /** O host anterior não volta (caiu ou saiu): o hub novo já começa sem ele. */
  dropPrevious: boolean;
  timer: number;
  busy: boolean;
}

const SIGNALING_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'];

/** Log de depuração: ative com localStorage.setItem('orbita.debug', '1'). */
const DEBUG = (() => {
  try {
    return !!localStorage.getItem('orbita.debug');
  } catch {
    return false;
  }
})();
const dbg = (...args: unknown[]) => {
  if (DEBUG) console.info('[órbita]', ...args);
};

export class Session {
  readonly meId: string;
  hub: Hub | null = null;
  status: SessionStatus = 'connecting';
  state: RoomState | null = null;
  messages: ChatMessage[] = [];
  private wire: Wire | null = null;
  private lastHubMsg = 0;
  private watchdog = 0;
  private migration: Migration | null = null;
  private leaving = false;
  private outbox: ClientMsg[] = [];

  private constructor(
    readonly peer: Peer,
    readonly code: string,
    private identity: Identity,
    private presence: () => Presence,
    private h: SessionHandlers,
  ) {
    this.meId = identity.id;
    keepSignaling(peer, () => this.status !== 'ended');
    peer.on('error', (err) => {
      if (err.type !== 'peer-unavailable') console.warn('[peer]', err.type, err.message);
    });
  }

  /** Cria uma sala nova: esta aba vira o host. */
  static async create(identity: Identity, roomName: string, presence: () => Presence, h: SessionHandlers) {
    const peer = await openPeer();
    try {
      for (let attempt = 0; ; attempt++) {
        const code = roomCode();
        const hub = new Hub(createRoom(code, roomName, identity.id));
        try {
          await hub.start();
        } catch (err) {
          hub.stop();
          if (err instanceof PeerOpenError && err.type === 'unavailable-id' && attempt < 4) continue;
          throw err;
        }
        const session = new Session(peer, code, identity, presence, h);
        session.hub = hub;
        await session.connectLocal(false);
        return session;
      }
    } catch (err) {
      peer.destroy();
      throw err;
    }
  }

  /** Entra numa sala existente pelo código. */
  static async join(identity: Identity, code: string, presence: () => Presence, h: SessionHandlers) {
    const peer = await openPeer();
    const session = new Session(peer, code, identity, presence, h);
    try {
      await session.connectRemote(12_000, false);
      return session;
    } catch (err) {
      session.status = 'ended';
      peer.destroy();
      throw err;
    }
  }

  get isHost() {
    return !!this.hub && !this.hub.closing;
  }

  send(msg: ClientMsg) {
    if (this.status === 'connected' && this.wire) {
      this.wire.send(msg);
      return;
    }
    // mensagens de chat escritas durante uma reconexão saem quando a órbita voltar
    if (this.status === 'reconnecting' && msg.t === 'chat' && this.outbox.length < 20) this.outbox.push(msg);
  }

  setIdentity(identity: Omit<Identity, 'id'>) {
    this.identity = { ...identity, id: this.meId };
    this.send({ t: 'profile', name: identity.name, color: identity.color, avatar: identity.avatar ?? null, planet: identity.planet, orbit: identity.orbit ?? null });
  }

  leave() {
    if (this.status === 'ended') return;
    this.leaving = true;
    if (this.wire && this.status === 'connected') {
      this.wire.send({ t: 'bye' } satisfies ClientMsg);
      window.setTimeout(() => this.end('left'), 250);
    } else {
      this.end('left');
    }
  }

  /** Host: entrega a coroa para outro membro e sai. */
  transferAndLeave(memberId: string) {
    this.leaving = true;
    this.send({ t: 'admin', action: { kind: 'transfer', memberId, leave: true } });
    window.setTimeout(() => this.end('left'), 3_000);
  }

  /** Host: encerra a sala para todo mundo. */
  endForAll() {
    this.leaving = true;
    this.send({ t: 'admin', action: { kind: 'end' } });
    window.setTimeout(() => this.end('left'), 3_000);
  }

  /** Página fechando: libera os IDs no servidor na hora, para a migração ser rápida. */
  destroyNow() {
    if (this.status === 'ended') return;
    this.leaving = true;
    try {
      this.wire?.send({ t: 'bye' } satisfies ClientMsg);
    } catch {
      /* indo embora mesmo */
    }
    this.hub?.stop();
    this.end('left');
  }

  end(reason: EndReason) {
    if (this.status === 'ended') return;
    this.status = 'ended';
    clearInterval(this.watchdog);
    if (this.migration) clearTimeout(this.migration.timer);
    this.migration = null;
    this.wire?.close();
    this.wire = null;
    if (this.hub) {
      // durante end()/handoff() o hub se desliga sozinho depois de avisar todo mundo
      if (!this.hub.closing) this.hub.stop();
      this.hub = null;
    }
    try {
      this.peer.destroy();
    } catch {
      /* já destruído */
    }
    this.h.status('ended');
    this.h.ended(reason);
  }

  // ───────────────────────── conexão com o hub ─────────────────────────

  private hello(rejoin: boolean): ClientMsg {
    const me = this.state?.members.find((m) => m.id === this.meId);
    return {
      t: 'hello',
      v: PROTOCOL_VERSION,
      member: {
        id: this.meId,
        peerId: this.peer.id,
        name: this.identity.name,
        color: this.identity.color,
        avatar: this.identity.avatar,
        planet: this.identity.planet,
        orbit: this.identity.orbit,
        build: APP_BUILD,
      },
      presence: this.presence(),
      rejoinAt: rejoin ? me?.joinedAt : undefined,
    };
  }

  private connectLocal(rejoin: boolean): Promise<void> {
    const hub = this.hub;
    if (!hub) return Promise.reject(new JoinError('closed'));
    const [mine, theirs] = createLocalPair();
    return new Promise<void>((resolve, reject) => {
      mine.onMessage = (msg: HubMsg) => {
        if (msg.t === 'welcome') {
          this.adopt(mine, msg.state, msg.messages);
          resolve();
        } else if (msg.t === 'reject') {
          reject(new JoinError('rejected', msg.reason));
        }
      };
      hub.attachLocal(theirs);
      mine.send(this.hello(rejoin));
    });
  }

  /**
   * @param patient durante a migração: o servidor segura o pedido por ~5 s esperando o hub
   *   aparecer e o "não existe" chega atrasado (às vezes da tentativa anterior), então só
   *   desistimos pelo tempo limite.
   */
  private connectRemote(timeoutMs: number, rejoin: boolean, patient = false): Promise<void> {
    const hubId = hubPeerId(this.code);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let conn: DataConnection | undefined;
      const finish = (err?: JoinError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.peer.off('error', onPeerError);
        if (err) {
          try {
            conn?.close();
          } catch {
            /* ignora */
          }
          reject(err);
        } else {
          resolve();
        }
      };
      const onPeerError = (err: { type: string; message: string }) => {
        if (err.type === 'peer-unavailable' && err.message.includes(hubId)) {
          if (!patient) finish(new JoinError('not-found'));
        } else if (SIGNALING_ERRORS.includes(err.type)) {
          finish(new JoinError('signaling'));
        }
      };
      const timer = window.setTimeout(() => finish(new JoinError('timeout')), timeoutMs);
      this.peer.on('error', onPeerError);
      // connect() devolve undefined se o peer estiver desconectado do servidor
      conn = this.peer.connect(hubId, { reliable: true, serialization: 'raw' }) as DataConnection | undefined;
      if (!conn) {
        finish(new JoinError('signaling'));
        return;
      }
      const connection = conn;
      connection.on('close', () => finish(new JoinError('closed')));
      connection.on('open', () => {
        if (settled) {
          connection.close();
          return;
        }
        const wire: Wire = new PeerWire(connection);
        wire.onClose = () => finish(new JoinError('closed'));
        wire.onMessage = (msg: HubMsg) => {
          if (msg.t === 'welcome') {
            if (settled) return;
            finish();
            this.adopt(wire, msg.state, msg.messages);
          } else if (msg.t === 'reject') {
            finish(new JoinError('rejected', msg.reason));
          }
        };
        wire.send(this.hello(rejoin));
      });
    });
  }

  private adopt(wire: Wire, state: RoomState, messages: ChatMessage[]) {
    this.wire = wire;
    this.state = state;
    this.messages = messages;
    if (this.migration) clearTimeout(this.migration.timer);
    this.migration = null;
    this.lastHubMsg = Date.now();
    wire.onMessage = (msg: HubMsg) => this.onHub(msg);
    wire.onClose = () => this.onWireLost();
    this.status = 'connected';
    this.h.status('connected');
    this.h.welcome(state, messages);
    if (!this.watchdog) this.watchdog = window.setInterval(() => this.checkHub(), 2_000);
    for (const queued of this.outbox.splice(0)) wire.send(queued);
  }

  private onHub(msg: HubMsg) {
    this.lastHubMsg = Date.now();
    switch (msg.t) {
      case 'ping':
        this.wire?.send({ t: 'pong' } satisfies ClientMsg);
        return;
      case 'state':
        this.state = msg.state;
        this.h.state(msg.state);
        return;
      case 'chat': {
        this.messages.push(msg.message);
        const inChannel = this.messages.filter((m) => m.channelId === msg.message.channelId);
        if (inChannel.length > MAX_MESSAGES_PER_CHANNEL) {
          const oldest = inChannel[0];
          this.messages = this.messages.filter((m) => m !== oldest);
        }
        this.h.chat(msg.message);
        return;
      }
      case 'chat:update':
        this.messages = this.messages.map((m) => (m.id === msg.message.id ? msg.message : m));
        this.h.chatUpdate(msg.message);
        return;
      case 'chat:delete':
        this.messages = this.messages.filter((m) => m.id !== msg.id);
        this.h.chatDelete(msg.id, msg.channelId);
        return;
      case 'typing':
        this.h.typing(msg.memberId, msg.channelId);
        return;
      case 'speaking':
        this.h.speaking(msg.memberId, msg.on);
        return;
      case 'sound':
        this.h.sound(msg.from, msg.id);
        return;
      case 'live:viewer':
        this.h.liveViewer(msg.viewerId, msg.viewerPeerId, msg.on);
        return;
      case 'fx':
        this.h.fx(msg.from, msg.streamerId, msg.fx);
        return;
      case 'fx:sync':
        this.h.fxSync(msg.streamerId, msg.strokes);
        return;
      case 'avatars':
        this.h.avatars(msg.avatars);
        return;
      case 'avatar':
        this.h.avatar(msg.memberId, msg.avatar);
        return;
      case 'kicked':
        this.end(msg.ban ? 'banned' : 'kicked');
        return;
      case 'ended':
        this.end(this.leaving ? 'left' : 'ended');
        return;
      case 'handoff':
        if (this.leaving) {
          this.end('left');
          return;
        }
        this.wire?.close();
        this.wire = null;
        this.beginMigration(msg.newHostId, !!msg.leaving);
        return;
      default:
        return;
    }
  }

  private checkHub() {
    if (this.status !== 'connected' || !this.wire || this.wire.kind === 'local') return;
    if (Date.now() - this.lastHubMsg > HUB_TIMEOUT_MS) {
      this.wire.close();
      this.onWireLost();
    }
  }

  private onWireLost() {
    if (this.status === 'ended') return;
    this.wire = null;
    if (this.leaving) {
      this.end('left');
      return;
    }
    this.beginMigration(null);
  }

  // ───────────────────────── migração de host ─────────────────────────

  private beginMigration(designated: string | null, previousLeft = false) {
    if (this.migration || this.status === 'ended') return;
    const state = this.state;
    if (!state) {
      this.end('lost');
      return;
    }
    if (this.hub) {
      if (!this.hub.closing) this.hub.stop();
      this.hub = null;
    }
    const previousHostId = state.hostId;
    if (designated) state.hostId = designated;
    const candidates = state.members
      .filter((m) => m.id !== previousHostId && !m.reconnecting)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => m.id);
    const order = designated ? [designated, ...candidates.filter((id) => id !== designated)] : candidates;
    let rank = order.indexOf(this.meId);
    if (rank < 0) rank = order.length;
    const now = Date.now();
    // o primeiro da fila tenta logo depois do hub antigo se desligar (~0,9 s); os outros
    // esperam a vez, escutando se um hub novo aparece nesse meio-tempo
    const claimDelay = designated ? (rank === 0 ? 1_200 : 15_000 + rank * 3_000) : 1_200 + rank * 3_500;
    this.migration = {
      startedAt: now,
      claimAt: now + claimDelay,
      nextClaim: 0,
      previousHostId,
      reason: designated ? 'transfer' : 'loss',
      dropPrevious: !designated || previousLeft,
      timer: 0,
      busy: false,
    };
    this.status = 'reconnecting';
    dbg('migração', { designated, rank, claimDelay, order });
    this.h.status('reconnecting', designated ? 'transfer' : 'loss');
    this.h.state(state);
    this.scheduleMigration(rank === 0 ? claimDelay : 1_600);
  }

  private scheduleMigration(ms: number) {
    const migration = this.migration;
    if (!migration) return;
    clearTimeout(migration.timer);
    migration.timer = window.setTimeout(() => void this.migrationStep(), ms);
  }

  private async migrationStep() {
    const migration = this.migration;
    if (!migration || this.status === 'ended' || migration.busy) return;
    if (Date.now() - migration.startedAt > MIGRATION_GIVE_UP_MS) {
      this.end('lost');
      return;
    }
    migration.busy = true;
    try {
      const now = Date.now();
      if (now >= migration.claimAt && now >= migration.nextClaim) {
        migration.nextClaim = now + 2_000;
        dbg('tentando virar host');
        if (await this.tryBecomeHub(migration)) return;
      }
      if (this.migration !== migration) return;
      try {
        // escuta um hub novo até a minha próxima vez de tentar virar host
        const until = Math.max(migration.claimAt, migration.nextClaim);
        const wait = Math.min(4_000, Math.max(2_500, until - Date.now()));
        dbg('tentando reconectar ao hub por', wait, 'ms');
        await this.connectRemote(wait, true, true);
        dbg('reconectado');
        return;
      } catch (err) {
        dbg('reconexão falhou:', err instanceof JoinError ? err.code : err);
        if (err instanceof JoinError && err.code === 'rejected') {
          this.end(err.reason === 'banned' ? 'banned' : 'lost');
          return;
        }
      }
    } finally {
      migration.busy = false;
    }
    if (this.migration === migration) this.scheduleMigration(250);
  }

  private async tryBecomeHub(migration: Migration): Promise<boolean> {
    const base = this.state;
    if (!base) return false;
    const members = base.members
      .filter((m) => !migration.dropPrevious || m.id !== migration.previousHostId)
      .map((m) => ({ ...m, reconnecting: m.id !== this.meId }));
    const hub = new Hub({
      state: { ...base, hostId: this.meId, epoch: base.epoch + 1, members },
      messages: this.messages,
    });
    try {
      await hub.start();
    } catch (err) {
      dbg('não consegui reservar o ID da sala:', err instanceof PeerOpenError ? err.type : err);
      hub.stop();
      return false;
    }
    dbg('ID da sala reservado: sou o novo host');
    if (this.migration !== migration || this.status === 'ended') {
      hub.stop();
      return false;
    }
    this.hub = hub;
    await this.connectLocal(true);
    const previousHost = base.members.find((m) => m.id === migration.previousHostId);
    hub.announceNewHost(migration.dropPrevious ? previousHost?.name : undefined);
    this.h.becameHost();
    return true;
  }
}
