import type Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import {
  APP_NAME,
  CLIENT_TIMEOUT_MS,
  HEARTBEAT_MS,
  HISTORY_IMAGE_BUDGET,
  HUB_PREFIX,
  MAX_IMAGE_CHARS,
  MAX_MEMBERS,
  MAX_MESSAGES_PER_CHANNEL,
  MAX_TEXT_LENGTH,
  PROTOCOL_VERSION,
  REACTIONS,
  RECONNECT_GRACE_MS,
} from './config';
import { allowFx, validFx, type FxLimits } from './fx';
import { keepSignaling, openPeer } from './peer';
import type {
  AdminAction,
  Attachment,
  ChatMessage,
  ClientMsg,
  HubMsg,
  LiveInfo,
  LiveQuality,
  Member,
  Presence,
  RejectReason,
  RoomState,
} from './protocol';
import { clampText, randomId, sanitizeColor, sanitizeName, sanitizeRoomName } from './util';
import { PeerWire, type Wire } from './wire';

/**
 * O hub roda na aba do host. É a autoridade da sala: aceita quem entra, guarda o estado,
 * o histórico do chat e repassa mensagens. Quando o host muda, outro participante sobe
 * um hub novo com o mesmo ID, a partir da cópia do estado que todo mundo mantém.
 */

interface Client {
  wire: Wire;
  memberId: string | null;
  lastSeen: number;
  helloTimer: number;
}

export interface HubInit {
  state: RoomState;
  messages: ChatMessage[];
}

export const hubPeerId = (code: string) => HUB_PREFIX + code;
/** O ID de membro é `${perfil}.${sessão}`; bans valem para o perfil. */
export const baseId = (memberId: string) => memberId.split('.')[0];

const QUALITIES: LiveQuality[] = ['480p', '720p', '1080p', '1080p60'];
const MEMBER_ID = /^[a-z0-9]{8,32}\.[a-z0-9]{4,12}$/;
const IMAGE_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export function createRoom(code: string, name: string, hostId: string): HubInit {
  const now = Date.now();
  const roomName = sanitizeRoomName(name);
  // uma sala = um chat de texto + uma chamada de voz
  const chat = { id: randomId(8), name: 'chat', type: 'text' as const };
  const call = { id: randomId(8), name: 'Chamada', type: 'voice' as const };
  return {
    state: {
      code,
      name: roomName,
      hostId,
      createdAt: now,
      locked: false,
      epoch: 1,
      banned: [],
      members: [],
      channels: [chat, call],
    },
    messages: [
      {
        id: randomId(14),
        channelId: chat.id,
        authorId: '',
        authorName: APP_NAME,
        authorColor: '',
        text: `🪐 **${roomName}** entrou no ar. Mande o convite pros amigos — tudo aqui é peer-to-peer e some quando a sala fechar.`,
        ts: now,
        system: true,
      },
    ],
  };
}

export class Hub {
  state: RoomState;
  /** true depois de end()/handoff(): o hub está se despedindo. */
  closing = false;
  private messages: ChatMessage[];
  private peer: Peer | null = null;
  private clients = new Set<Client>();
  private byMember = new Map<string, Client>();
  private graceTimers = new Map<string, number>();
  private heartbeat = 0;
  private fxLimits = new Map<string, FxLimits>();
  private statePending = false;
  private stopped = false;

  constructor(init: HubInit) {
    this.state = structuredClone(init.state);
    this.messages = structuredClone(init.messages);
  }

  /** Reserva o ID da sala no servidor de sinalização. Falha com 'unavailable-id' se já houver um host. */
  async start(): Promise<void> {
    const peer = await openPeer(hubPeerId(this.state.code));
    if (this.stopped) {
      peer.destroy();
      return;
    }
    this.peer = peer;
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('error', (err) => console.warn('[hub]', err.type, err.message));
    keepSignaling(peer, () => !this.stopped);
    this.heartbeat = window.setInterval(() => this.tick(), HEARTBEAT_MS);
    // quem veio de uma migração tem um tempo para se reconectar
    for (const member of this.state.members) if (member.reconnecting) this.startGrace(member.id);
  }

  /** Conecta o próprio host (mesma aba) sem passar pela rede. */
  attachLocal(wire: Wire) {
    this.addClient(wire);
  }

  /** Depois de uma migração. Se o host anterior caiu, avisa que ele saiu. */
  announceNewHost(previousHostName?: string) {
    if (previousHostName) this.system(`**${previousHostName}** (host) saiu da órbita.`);
    const host = this.member(this.state.hostId);
    if (host) this.system(`👑 **${host.name}** agora é o host — o novo centro da órbita.`);
  }

  /** Passa o host para outro membro: todo mundo se reconecta ao hub novo. */
  handoff(newHostId: string, leaving = false) {
    if (this.closing) return;
    this.closing = true;
    this.broadcast({ t: 'handoff', newHostId, leaving });
    window.setTimeout(() => this.stop(), 900);
  }

  /** Encerra a sala para todos. */
  end() {
    if (this.closing) return;
    this.closing = true;
    this.broadcast({ t: 'ended' });
    window.setTimeout(() => this.stop(), 900);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.closing = true;
    clearInterval(this.heartbeat);
    this.graceTimers.forEach((timer) => clearTimeout(timer));
    this.graceTimers.clear();
    for (const client of this.clients) {
      clearTimeout(client.helloTimer);
      client.wire.close();
    }
    this.clients.clear();
    this.byMember.clear();
    this.peer?.destroy();
    this.peer = null;
  }

  // ───────────────────────── conexões ─────────────────────────

  private accept(conn: DataConnection) {
    if (this.stopped || this.closing) {
      conn.close();
      return;
    }
    const timer = window.setTimeout(() => conn.close(), 20_000);
    conn.once('open', () => {
      clearTimeout(timer);
      if (this.stopped) conn.close();
      else this.addClient(new PeerWire(conn));
    });
  }

  private addClient(wire: Wire) {
    const client: Client = { wire, memberId: null, lastSeen: Date.now(), helloTimer: 0 };
    client.helloTimer = window.setTimeout(() => {
      if (!client.memberId) this.drop(client, true);
    }, 15_000);
    this.clients.add(client);
    wire.onMessage = (msg: ClientMsg) => {
      client.lastSeen = Date.now();
      this.handle(client, msg);
    };
    wire.onClose = () => this.drop(client, false);
  }

  private drop(client: Client, intentional: boolean) {
    if (!this.clients.delete(client)) return;
    clearTimeout(client.helloTimer);
    client.wire.close();
    const id = client.memberId;
    if (!id || this.byMember.get(id) !== client) return;
    this.byMember.delete(id);
    if (this.stopped || this.closing) return;
    if (intentional) {
      this.removeMember(id, true);
      return;
    }
    const member = this.member(id);
    if (member) {
      member.reconnecting = true;
      this.startGrace(id);
      this.pushState();
    }
  }

  private startGrace(id: string) {
    clearTimeout(this.graceTimers.get(id));
    this.graceTimers.set(
      id,
      window.setTimeout(() => {
        this.graceTimers.delete(id);
        if (this.member(id)?.reconnecting) this.removeMember(id, true);
      }, RECONNECT_GRACE_MS),
    );
  }

  private removeMember(id: string, announce: boolean) {
    const member = this.member(id);
    if (!member) return;
    clearTimeout(this.graceTimers.get(id));
    this.graceTimers.delete(id);
    this.state.members = this.state.members.filter((m) => m.id !== id);
    this.fxLimits.delete(id);
    if (announce) this.system(`**${member.name}** saiu da órbita.`);
    this.pushState();
  }

  private tick() {
    const now = Date.now();
    for (const client of [...this.clients]) {
      if (client.wire.kind === 'local') continue;
      if (now - client.lastSeen > CLIENT_TIMEOUT_MS) {
        this.drop(client, false);
        continue;
      }
      if (client.memberId) client.wire.send({ t: 'ping' } satisfies HubMsg);
    }
  }

  // ───────────────────────── mensagens ─────────────────────────

  private handle(client: Client, msg: ClientMsg) {
    if (this.stopped || !msg || typeof msg !== 'object') return;
    if (!client.memberId) {
      if (msg.t === 'hello') this.hello(client, msg);
      return;
    }
    const me = this.member(client.memberId);
    if (!me) return;
    switch (msg.t) {
      case 'pong':
        return;
      case 'bye':
        this.drop(client, true);
        return;
      case 'chat':
        this.chat(me, msg.channelId, msg.text, msg.attachment);
        return;
      case 'chat:edit':
        this.editMessage(me, msg.id, msg.text);
        return;
      case 'chat:delete':
        this.deleteMessage(me, msg.id);
        return;
      case 'chat:react':
        this.react(me, msg.id, msg.emoji);
        return;
      case 'typing':
        if (this.textChannel(msg.channelId)) this.broadcast({ t: 'typing', memberId: me.id, channelId: msg.channelId }, me.id);
        return;
      case 'speaking':
        this.broadcast({ t: 'speaking', memberId: me.id, on: !!msg.on }, me.id);
        return;
      case 'presence':
        this.applyPresence(me, msg.presence);
        this.pushState();
        return;
      case 'profile':
        me.name = sanitizeName(msg.name);
        me.color = sanitizeColor(msg.color);
        this.pushState();
        return;
      case 'fx': {
        const streamer = this.member(typeof msg.streamerId === 'string' ? msg.streamerId : null);
        const fx = validFx(msg.fx);
        if (!streamer?.live || !streamer.live.effects || !fx) return;
        let limits = this.fxLimits.get(me.id);
        if (!limits) this.fxLimits.set(me.id, (limits = { laser: [], fx: [], nudge: 0 }));
        if (!allowFx(limits, fx, Date.now())) return;
        this.broadcast({ t: 'fx', from: me.id, streamerId: streamer.id, fx }, me.id);
        return;
      }
      case 'live:watch': {
        const streamer = typeof msg.streamerId === 'string' ? this.byMember.get(msg.streamerId) : undefined;
        if (streamer && msg.streamerId !== me.id) {
          streamer.wire.send({ t: 'live:viewer', viewerId: me.id, viewerPeerId: me.peerId, on: !!msg.on } satisfies HubMsg);
        }
        return;
      }
      case 'admin':
        if (me.id === this.state.hostId) this.admin(me, msg.action);
        return;
      default:
        return;
    }
  }

  private hello(client: Client, msg: Extract<ClientMsg, { t: 'hello' }>) {
    clearTimeout(client.helloTimer);
    const reject = (reason: RejectReason) => {
      client.wire.send({ t: 'reject', reason } satisfies HubMsg);
      this.clients.delete(client);
      window.setTimeout(() => client.wire.close(), 1_000);
    };
    if (msg.v !== PROTOCOL_VERSION) return reject('version');
    const info = msg.member;
    const id = info && typeof info.id === 'string' && MEMBER_ID.test(info.id) ? info.id : null;
    if (!id || typeof info.peerId !== 'string' || !info.peerId) return reject('invalid');
    if (this.state.banned.includes(baseId(id))) return reject('banned');
    const prev = this.member(id);
    if (!prev && this.state.locked && id !== this.state.hostId) return reject('locked');
    if (!prev && this.state.members.length >= MAX_MEMBERS) return reject('full');

    const old = this.byMember.get(id);
    if (old && old !== client) {
      this.byMember.delete(id);
      this.clients.delete(old);
      old.wire.close();
    }

    const member: Member = {
      id,
      peerId: info.peerId,
      name: sanitizeName(info.name),
      color: sanitizeColor(info.color),
      joinedAt: prev?.joinedAt ?? this.nextJoinedAt(msg.rejoinAt),
      voiceChannelId: null,
      micOn: true,
      deafened: false,
      cameraOn: false,
      live: null,
      serverMuted: prev?.serverMuted ?? false,
      reconnecting: false,
    };
    this.applyPresence(member, msg.presence);
    clearTimeout(this.graceTimers.get(id));
    this.graceTimers.delete(id);
    this.state.members = [...this.state.members.filter((m) => m.id !== id), member].sort(
      (a, b) => a.joinedAt - b.joinedAt,
    );
    client.memberId = id;
    this.byMember.set(id, client);
    client.wire.send({ t: 'welcome', you: id, state: this.state, messages: this.messages } satisfies HubMsg);
    if (!prev && msg.rejoinAt == null) this.system(`**${member.name}** entrou na órbita.`);
    this.pushState();
  }

  private nextJoinedAt(rejoinAt?: number): number {
    if (typeof rejoinAt === 'number' && rejoinAt >= this.state.createdAt && rejoinAt <= Date.now() + 60_000) {
      return rejoinAt;
    }
    const last = this.state.members.reduce((max, m) => Math.max(max, m.joinedAt), 0);
    return Math.max(Date.now(), last + 1);
  }

  private applyPresence(member: Member, presence: Partial<Presence> | undefined) {
    if (!presence || typeof presence !== 'object') return;
    if ('voiceChannelId' in presence) {
      member.voiceChannelId = this.voiceChannel(presence.voiceChannelId) ? (presence.voiceChannelId as string) : null;
    }
    if (typeof presence.micOn === 'boolean') member.micOn = presence.micOn;
    if (typeof presence.deafened === 'boolean') member.deafened = presence.deafened;
    if (typeof presence.cameraOn === 'boolean') member.cameraOn = presence.cameraOn;
    if ('live' in presence) member.live = validLive(presence.live);
    if (!member.voiceChannelId) {
      member.cameraOn = false;
      member.live = null;
    }
  }

  private chat(me: Member, channelId: unknown, text: unknown, attachment: unknown) {
    const channel = this.textChannel(channelId);
    if (!channel) return;
    const body = clampText(text, MAX_TEXT_LENGTH).trim();
    const image = validAttachment(attachment);
    if (!body && !image) return;
    const message: ChatMessage = {
      id: randomId(14),
      channelId: channel.id,
      authorId: me.id,
      authorName: me.name,
      authorColor: me.color,
      text: body,
      ts: Date.now(),
    };
    if (image) message.attachment = image;
    this.addMessage(message);
    this.broadcast({ t: 'chat', message });
  }

  private findMessage(id: unknown) {
    return typeof id === 'string' ? this.messages.find((m) => m.id === id) : undefined;
  }

  private editMessage(me: Member, id: unknown, text: unknown) {
    const message = this.findMessage(id);
    if (!message || message.system || message.authorId !== me.id) return;
    const body = clampText(text, MAX_TEXT_LENGTH).trim();
    if (!body && !message.attachment) return;
    message.text = body;
    message.editedAt = Date.now();
    this.broadcast({ t: 'chat:update', message });
  }

  private deleteMessage(me: Member, id: unknown) {
    const message = this.findMessage(id);
    if (!message || (message.authorId !== me.id && me.id !== this.state.hostId)) return;
    this.messages = this.messages.filter((m) => m !== message);
    this.broadcast({ t: 'chat:delete', id: message.id, channelId: message.channelId });
  }

  private react(me: Member, id: unknown, emoji: unknown) {
    const message = this.findMessage(id);
    if (!message || typeof emoji !== 'string' || !REACTIONS.includes(emoji)) return;
    const reactions = { ...(message.reactions ?? {}) };
    const list = reactions[emoji] ?? [];
    reactions[emoji] = list.includes(me.id) ? list.filter((x) => x !== me.id) : [...list, me.id];
    if (!reactions[emoji].length) delete reactions[emoji];
    message.reactions = reactions;
    this.broadcast({ t: 'chat:update', message });
  }

  private admin(host: Member, action: AdminAction) {
    if (!action || typeof action !== 'object') return;
    switch (action.kind) {
      case 'kick': {
        const target = this.member(action.memberId);
        if (!target || target.id === host.id) return;
        if (action.ban) this.state.banned = [...new Set([...this.state.banned, baseId(target.id)])];
        const client = this.byMember.get(target.id);
        if (client) {
          client.wire.send({ t: 'kicked', ban: !!action.ban } satisfies HubMsg);
          this.byMember.delete(target.id);
          this.clients.delete(client);
          window.setTimeout(() => client.wire.close(), 1_200);
        }
        this.removeMember(target.id, false);
        this.system(`**${target.name}** foi ${action.ban ? 'banido' : 'removido'} da órbita pelo host.`);
        return;
      }
      case 'mute': {
        const target = this.member(action.memberId);
        if (!target || target.id === host.id) return;
        target.serverMuted = !!action.muted;
        this.pushState();
        return;
      }
      case 'transfer': {
        const target = this.member(action.memberId);
        if (!target || target.id === host.id || target.reconnecting || !this.byMember.has(target.id)) return;
        this.handoff(target.id, !!action.leave);
        return;
      }
      case 'lock':
        this.state.locked = !!action.locked;
        this.system(
          this.state.locked ? '🔒 O host trancou a órbita: ninguém novo pode entrar.' : '🔓 O host destrancou a órbita.',
        );
        this.pushState();
        return;
      case 'rename':
        this.state.name = sanitizeRoomName(action.name);
        this.pushState();
        return;
      case 'end':
        this.end();
        return;
      default:
        return;
    }
  }

  // ───────────────────────── utilidades ─────────────────────────

  private member(id: string | null | undefined) {
    return id ? this.state.members.find((m) => m.id === id) : undefined;
  }

  private textChannel(id: unknown) {
    return this.state.channels.find((c) => c.id === id && c.type === 'text');
  }

  private voiceChannel(id: unknown) {
    return this.state.channels.find((c) => c.id === id && c.type === 'voice');
  }

  private broadcast(msg: HubMsg, exceptId?: string) {
    for (const [id, client] of this.byMember) if (id !== exceptId) client.wire.send(msg);
  }

  /** Junta várias mudanças do mesmo tick em um único envio do estado. */
  private pushState() {
    if (this.statePending || this.stopped) return;
    this.statePending = true;
    queueMicrotask(() => {
      this.statePending = false;
      if (!this.stopped) this.broadcast({ t: 'state', state: this.state });
    });
  }

  private system(text: string) {
    const channel = this.state.channels.find((c) => c.type === 'text');
    if (!channel) return;
    const message: ChatMessage = {
      id: randomId(14),
      channelId: channel.id,
      authorId: '',
      authorName: APP_NAME,
      authorColor: '',
      text,
      ts: Date.now(),
      system: true,
    };
    this.addMessage(message);
    this.broadcast({ t: 'chat', message });
  }

  private addMessage(message: ChatMessage) {
    this.messages.push(message);
    const inChannel = this.messages.filter((m) => m.channelId === message.channelId);
    if (inChannel.length > MAX_MESSAGES_PER_CHANNEL) {
      const drop = new Set(inChannel.slice(0, inChannel.length - MAX_MESSAGES_PER_CHANNEL));
      this.messages = this.messages.filter((m) => !drop.has(m));
    }
    if (message.attachment) this.pruneImages();
  }

  /** Imagens antigas saem do histórico para quem entrar depois não baixar megabytes. */
  private pruneImages() {
    let budget = HISTORY_IMAGE_BUDGET;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const attachment = this.messages[i].attachment;
      if (!attachment?.dataUrl) continue;
      budget -= attachment.dataUrl.length;
      if (budget < 0) this.messages[i] = { ...this.messages[i], attachment: { ...attachment, dataUrl: '' } };
    }
  }
}

function validLive(value: unknown): LiveInfo | null {
  if (!value || typeof value !== 'object') return null;
  const live = value as Partial<LiveInfo>;
  return {
    startedAt: Number(live.startedAt) || Date.now(),
    quality: QUALITIES.find((q) => q === live.quality) ?? '720p',
    audio: !!live.audio,
    viewers: Math.max(0, Math.min(99, Math.floor(Number(live.viewers) || 0))),
    effects: live.effects !== false,
  };
}

function validAttachment(value: unknown): Attachment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const a = value as Partial<Attachment>;
  if (a.kind !== 'image' || typeof a.dataUrl !== 'string' || a.dataUrl.length > MAX_IMAGE_CHARS) return undefined;
  if (!IMAGE_URL.test(a.dataUrl)) return undefined;
  return {
    kind: 'image',
    name: clampText(a.name, 120) || 'imagem',
    dataUrl: a.dataUrl,
    width: Math.max(1, Math.min(10_000, Math.round(Number(a.width) || 1))),
    height: Math.max(1, Math.min(10_000, Math.round(Number(a.height) || 1))),
  };
}
