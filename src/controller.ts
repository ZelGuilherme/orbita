import { APP_NAME, MAX_MESSAGES_PER_CHANNEL } from './lib/config';
import { baseId } from './lib/hub';
import { mentionsName } from './lib/markdown';
import { MediaEngine, type MediaEvents } from './lib/media';
import { PeerOpenError } from './lib/peer';
import type { AdminAction, Attachment, ChannelType, ChatMessage, LiveQuality, Member, Presence, RoomState } from './lib/protocol';
import { JoinError, Session, type EndReason, type SessionHandlers } from './lib/session';
import { setSoundsEnabled, sfx } from './lib/sounds';
import { saveProfile, saveSettings, saveVolumes, type Profile, type Settings } from './lib/storage';
import { copyText, errorMessage, inviteFromHash, inviteLink, parseRoomCode, randomId } from './lib/util';
import { getApp, resetRoomState, setApp, toast, type AppState, type View } from './store';

/**
 * Cola entre a sessão P2P, a mídia e a interface. Os componentes só chamam estas
 * funções e leem o estado do store.
 */

let session: Session | null = null;
let media: MediaEngine | null = null;
let typingSentAt = 0;
let viewersTimer = 0;
let initialized = false;
const liveRetries = new Map<string, number>();
const watchTimers = new Map<string, number>();

function myMember(): Member | undefined {
  const s = getApp();
  return s.room?.members.find((m) => m.id === s.meId);
}

function presence(): Presence {
  const s = getApp();
  return { voiceChannelId: s.voiceChannelId, micOn: s.micOn, deafened: s.deafened, cameraOn: s.cameraOn, live: s.live };
}

function sendPresence(patch: Partial<Presence>) {
  session?.send({ t: 'presence', presence: patch });
}

/** O microfone só transmite se estiver ligado, sem ensurdecer e sem bloqueio do host. */
function effectiveMic(): boolean {
  const s = getApp();
  return s.micOn && !s.deafened && !myMember()?.serverMuted;
}

function byChannel(messages: ChatMessage[]): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {};
  for (const message of messages) (out[message.channelId] ??= []).push(message);
  return out;
}

function syncTitle() {
  const s = getApp();
  const unread = Object.values(s.unread).reduce((a, b) => a + b, 0);
  const mentions = Object.values(s.mentions).reduce((a, b) => a + b, 0);
  const base = s.room ? `${s.room.name} · ${APP_NAME}` : APP_NAME;
  document.title = (mentions ? `(${mentions}) ` : unread ? '• ' : '') + base;
}

// ───────────────────────── eventos da sessão ─────────────────────────

function makeHandlers(meId: string): SessionHandlers {
  return {
    welcome: (state, messages) => {
      setApp({ messages: byChannel(messages) });
      applyState(state, meId, true);
    },
    state: (state) => applyState(state, meId, false),
    chat: onChat,
    chatUpdate: (message) =>
      setApp((s) => ({
        messages: {
          ...s.messages,
          [message.channelId]: (s.messages[message.channelId] ?? []).map((m) => (m.id === message.id ? message : m)),
        },
      })),
    chatDelete: (id, channelId) =>
      setApp((s) => ({
        messages: { ...s.messages, [channelId]: (s.messages[channelId] ?? []).filter((m) => m.id !== id) },
      })),
    typing: (memberId, channelId) =>
      setApp((s) => ({
        typing: { ...s.typing, [channelId]: { ...(s.typing[channelId] ?? {}), [memberId]: Date.now() + 6_000 } },
      })),
    speaking: (memberId, on) =>
      setApp((s) => (s.speaking[memberId] === on ? s : { speaking: { ...s.speaking, [memberId]: on } })),
    liveViewer: (viewerId, viewerPeerId, on) => media?.onLiveViewer(viewerId, viewerPeerId, on),
    status: (status, detail) => {
      if (status === 'reconnecting') setApp({ net: 'reconnecting', netDetail: detail ?? 'loss' });
      else if (status === 'connected') setApp({ net: 'connected', netDetail: '' });
    },
    ended: onEnded,
    becameHost: () => toast('👑 Você virou o host — agora é o centro da órbita.', 'success', 5_000),
  };
}

function applyState(state: RoomState, meId: string, first: boolean) {
  const s = getApp();
  const prev = s.room;
  const mine = state.members.find((m) => m.id === meId);
  const patch: Partial<AppState> = { room: state, meId, isHost: state.hostId === meId };

  if (prev && !first) {
    if (s.voiceChannelId) {
      const inMyChannel = (r: RoomState) =>
        new Set(r.members.filter((m) => m.voiceChannelId === s.voiceChannelId && m.id !== meId).map((m) => m.id));
      const before = inMyChannel(prev);
      const after = inMyChannel(state);
      if ([...after].some((id) => !before.has(id))) sfx.memberJoin();
      else if ([...before].some((id) => !after.has(id))) sfx.memberLeave();
    }
    for (const m of state.members) {
      const was = prev.members.find((p) => p.id === m.id);
      if (m.live && !was?.live && m.id !== meId) {
        toast(`🔴 ${m.name} começou uma live`);
        sfx.live();
      }
    }
    if (prev.hostId !== state.hostId && state.hostId !== meId) {
      const host = state.members.find((m) => m.id === state.hostId);
      if (host) toast(`👑 ${host.name} agora é o host`);
    }
    const wasMuted = !!prev.members.find((m) => m.id === meId)?.serverMuted;
    if (mine?.serverMuted && !wasMuted) toast('O host silenciou seu microfone.', 'error');
    if (mine && !mine.serverMuted && wasMuted) toast('O host liberou seu microfone.', 'success');
  }

  // quem saiu da voz não está mais falando
  const speaking = { ...s.speaking };
  let speakingChanged = false;
  for (const id of Object.keys(speaking)) {
    if (id === meId) continue;
    if (!state.members.find((m) => m.id === id)?.voiceChannelId) {
      delete speaking[id];
      speakingChanged = true;
    }
  }
  if (speakingChanged) patch.speaking = speaking;

  // lives que terminaram
  const watching = { ...s.watching };
  let watchingChanged = false;
  for (const id of Object.keys(watching)) {
    if (!state.members.find((m) => m.id === id)?.live) {
      delete watching[id];
      watchingChanged = true;
    }
  }
  if (watchingChanged) patch.watching = watching;

  if (!s.view || !state.channels.some((c) => c.id === s.view?.channelId)) {
    const firstText = state.channels.find((c) => c.type === 'text');
    patch.view = firstText ? { kind: 'text', channelId: firstText.id } : null;
  }
  setApp(patch);

  if (mine) media?.setMicEnabled(effectiveMic());
  if (s.voiceChannelId && !state.channels.some((c) => c.id === s.voiceChannelId)) leaveVoice();
  media?.update(state);
  syncTitle();
}

function onChat(message: ChatMessage) {
  const s = getApp();
  const list = [...(s.messages[message.channelId] ?? []), message].slice(-MAX_MESSAGES_PER_CHANNEL);
  const viewing =
    s.view?.kind === 'text' && s.view.channelId === message.channelId && document.visibilityState === 'visible';
  const mine = message.authorId === s.meId;
  const mentioned = !mine && !message.system && mentionsName(message.text, s.profile.name);
  const patch: Partial<AppState> = { messages: { ...s.messages, [message.channelId]: list } };
  if (!viewing && !mine && !message.system) {
    patch.unread = { ...s.unread, [message.channelId]: (s.unread[message.channelId] ?? 0) + 1 };
    if (mentioned) patch.mentions = { ...s.mentions, [message.channelId]: (s.mentions[message.channelId] ?? 0) + 1 };
  }
  const typing = s.typing[message.channelId];
  if (typing?.[message.authorId]) {
    const next = { ...typing };
    delete next[message.authorId];
    patch.typing = { ...s.typing, [message.channelId]: next };
  }
  setApp(patch);
  if (!mine && !message.system) {
    if (mentioned) sfx.mention();
    else if (!viewing) sfx.message();
  }
  syncTitle();
}

function onEnded(reason: EndReason) {
  const s = getApp();
  const roomName = s.room?.name ?? '';
  const code = s.code ?? '';
  media?.destroy();
  media = null;
  session = null;
  watchTimers.forEach((timer) => clearTimeout(timer));
  watchTimers.clear();
  liveRetries.clear();
  resetRoomState();
  history.replaceState(null, '', location.pathname + location.search);
  if (reason === 'left') {
    setApp({ phase: 'landing', inviteCode: null });
    toast('Você saiu da órbita.');
  } else {
    setApp({ phase: 'ended', ended: { reason, roomName, code } });
  }
  syncTitle();
}

// ───────────────────────── eventos da mídia ─────────────────────────

function mediaEvents(): MediaEvents {
  return {
    streams: (voice, live) => {
      setApp({ voiceStreams: voice, liveStreams: live });
      for (const id of Object.keys(live)) {
        liveRetries.delete(id);
        clearTimeout(watchTimers.get(id));
        watchTimers.delete(id);
      }
    },
    localSpeaking: (on) => {
      const id = getApp().meId;
      if (!id) return;
      setApp((s) => ({ speaking: { ...s.speaking, [id]: on } }));
      session?.send({ t: 'speaking', on });
    },
    liveViewers: (count) => {
      const s = getApp();
      if (!s.live || s.live.viewers === count) return;
      setApp({ live: { ...s.live, viewers: count } });
      clearTimeout(viewersTimer);
      viewersTimer = window.setTimeout(() => {
        const live = getApp().live;
        if (live) sendPresence({ live });
      }, 500);
    },
    liveEnded: () => {
      setApp({ live: null, localScreen: null });
      sendPresence({ live: null });
      toast('Sua live foi encerrada.');
    },
    liveDropped: (streamerId) => requestLive(streamerId, true),
    cameraEnded: () => {
      setApp({ cameraOn: false, localCamera: null });
      sendPresence({ cameraOn: false });
    },
    micLost: () => toast('O microfone foi desconectado.', 'error'),
  };
}

function requestLive(streamerId: string, retry: boolean) {
  if (!session || !media || !getApp().watching[streamerId]) return;
  const attempts = (liveRetries.get(streamerId) ?? 0) + (retry ? 1 : 0);
  liveRetries.set(streamerId, attempts);
  if (attempts > 3) {
    toast('Não consegui conectar à live. Tente de novo.', 'error');
    unwatchLive(streamerId);
    return;
  }
  const send = () => session?.send({ t: 'live:watch', streamerId, on: true });
  if (retry) window.setTimeout(send, 1_500);
  else send();
  clearTimeout(watchTimers.get(streamerId));
  watchTimers.set(
    streamerId,
    window.setTimeout(() => {
      watchTimers.delete(streamerId);
      if (getApp().watching[streamerId] && !media?.hasLiveStream(streamerId)) requestLive(streamerId, true);
    }, 12_000),
  );
}

// ───────────────────────── entrar / sair ─────────────────────────

function describeError(err: unknown): string {
  if (err instanceof JoinError) {
    switch (err.code) {
      case 'not-found':
        return 'Órbita não encontrada. O host pode ter fechado a sala, ou o código está errado.';
      case 'timeout':
        return 'O host não respondeu a tempo. Tente de novo — conexões P2P às vezes demoram.';
      case 'signaling':
        return 'Sem conexão com o servidor de sinalização. Verifique sua internet.';
      case 'closed':
        return 'A conexão com o host caiu durante a entrada. Tente de novo.';
      case 'rejected': {
        const reasons: Record<string, string> = {
          locked: 'Esta órbita está trancada pelo host.',
          banned: 'Você foi banido desta órbita.',
          full: 'A órbita está cheia.',
          version: 'Sua versão do app é diferente da do host. Atualize a página (Ctrl+F5).',
          invalid: 'Pedido de entrada inválido.',
        };
        return reasons[err.reason ?? ''] ?? 'O host recusou a entrada.';
      }
    }
  }
  if (err instanceof PeerOpenError) {
    if (err.type === 'browser-incompatible') return 'Seu navegador não suporta WebRTC. Use Chrome, Edge, Firefox ou Safari atualizados.';
    if (err.type === 'unavailable-id') return 'Não consegui reservar um código de sala. Tente de novo.';
    return `Não consegui falar com o servidor de sinalização (${err.type}). Verifique sua internet ou o servidor em Configurações › Rede.`;
  }
  return errorMessage(err);
}

async function enterRoom(mode: 'create' | 'join', arg: string) {
  if (session || getApp().phase === 'connecting') return;
  const { profile } = getApp();
  resetRoomState();
  setApp({
    phase: 'connecting',
    landingError: null,
    connectingText: mode === 'create' ? 'Criando sua órbita…' : `Entrando na órbita ${arg}…`,
  });
  const identity = { id: `${profile.id}.${randomId(6)}`, name: profile.name, color: profile.color };
  const handlers = makeHandlers(identity.id);
  try {
    const created =
      mode === 'create'
        ? await Session.create(identity, arg, presence, handlers)
        : await Session.join(identity, arg, presence, handlers);
    session = created;
    media = new MediaEngine(mediaEvents(), () => getApp().settings);
    media.attach(created.peer, created.meId);
    if (created.state) media.update(created.state);
    setApp({ phase: 'room', code: created.code, meId: created.meId, inviteCode: null });
    history.replaceState(null, '', `#/sala/${created.code}`);
    if (mode === 'create') setApp({ modal: { kind: 'invite' } });
    sfx.join();
  } catch (err) {
    resetRoomState();
    setApp({ phase: 'landing', landingError: describeError(err) });
  }
}

export const createRoom = (roomName: string) => enterRoom('create', roomName);

export function joinRoom(input: string) {
  const code = parseRoomCode(input);
  if (!code) {
    setApp({ landingError: 'Código ou link de convite inválido.' });
    return;
  }
  void enterRoom('join', code);
}

export function requestLeave() {
  const s = getApp();
  if (!session) return;
  const others = s.room?.members.filter((m) => m.id !== s.meId && !m.reconnecting) ?? [];
  if (s.isHost && others.length) {
    setApp({ modal: { kind: 'leave' } });
  } else if (s.isHost) {
    setApp({
      modal: {
        kind: 'confirm',
        title: 'Encerrar a órbita?',
        body: 'Você está sozinho aqui. Ao sair, a sala deixa de existir e o convite para de funcionar.',
        confirm: 'Encerrar e sair',
        danger: true,
        action: () => session?.endForAll(),
      },
    });
  } else {
    setApp({
      modal: {
        kind: 'confirm',
        title: 'Sair da órbita?',
        body: 'Você pode voltar pelo mesmo link enquanto a sala existir.',
        confirm: 'Sair',
        danger: true,
        action: () => session?.leave(),
      },
    });
  }
}

export const transferAndLeave = (memberId: string) => session?.transferAndLeave(memberId);
export const endRoom = () => session?.endForAll();

export async function copyInvite() {
  const code = getApp().code;
  if (!code) return;
  const ok = await copyText(inviteLink(code));
  toast(ok ? 'Link do convite copiado!' : 'Não consegui copiar — selecione o link manualmente.', ok ? 'success' : 'error');
}

export async function shareInvite() {
  const s = getApp();
  if (!s.code) return;
  try {
    await navigator.share({ title: `${APP_NAME} · ${s.room?.name ?? ''}`, text: 'Entra na minha órbita!', url: inviteLink(s.code) });
  } catch {
    /* cancelado */
  }
}

// ───────────────────────── chat ─────────────────────────

export function openChannel(view: View) {
  setApp((s) => {
    const unread = { ...s.unread };
    const mentions = { ...s.mentions };
    if (view.kind === 'text') {
      delete unread[view.channelId];
      delete mentions[view.channelId];
    }
    return { view, unread, mentions, navOpen: false };
  });
  syncTitle();
}

export function sendMessage(channelId: string, text: string, attachment?: Attachment) {
  session?.send({ t: 'chat', channelId, text, attachment });
  typingSentAt = 0;
}

export const editMessage = (id: string, text: string) => session?.send({ t: 'chat:edit', id, text });
export const deleteMessage = (id: string) => session?.send({ t: 'chat:delete', id });
export const react = (id: string, emoji: string) => session?.send({ t: 'chat:react', id, emoji });

export function notifyTyping(channelId: string) {
  const now = Date.now();
  if (now - typingSentAt < 2_500) return;
  typingSentAt = now;
  session?.send({ t: 'typing', channelId });
}

// ───────────────────────── voz, câmera e lives ─────────────────────────

export async function joinVoice(channelId: string) {
  const s = getApp();
  if (!media || !session || s.joiningVoice) return;
  if (s.voiceChannelId === channelId) {
    openChannel({ kind: 'voice', channelId });
    return;
  }
  if (s.voiceChannelId) leaveVoice(true);
  setApp({ joiningVoice: true });
  const engine = media;
  const micAvailable = await engine.joinVoice(channelId, effectiveMic());
  if (!session || media !== engine) return;
  const micOn = micAvailable ? getApp().micOn : false;
  if (!micAvailable) toast('Microfone indisponível ou bloqueado — você entrou só para ouvir.', 'error', 5_000);
  setApp({ voiceChannelId: channelId, micOn, joiningVoice: false });
  engine.setMicEnabled(effectiveMic());
  sendPresence({ voiceChannelId: channelId, micOn, deafened: getApp().deafened, cameraOn: false, live: null });
  openChannel({ kind: 'voice', channelId });
  sfx.join();
}

export function leaveVoice(silent = false) {
  if (!getApp().voiceChannelId) return;
  media?.leaveVoice();
  setApp({ voiceChannelId: null, cameraOn: false, live: null, localCamera: null, localScreen: null });
  sendPresence({ voiceChannelId: null, cameraOn: false, live: null });
  if (!silent) sfx.leave();
}

export function toggleMic() {
  const s = getApp();
  if (myMember()?.serverMuted) {
    toast('O host silenciou você.', 'error');
    return;
  }
  if (s.deafened) {
    setApp({ deafened: false, micOn: true });
    media?.setMicEnabled(effectiveMic());
    sendPresence({ deafened: false, micOn: true });
    sfx.unmute();
    return;
  }
  const micOn = !s.micOn;
  setApp({ micOn });
  media?.setMicEnabled(effectiveMic());
  sendPresence({ micOn });
  if (micOn) sfx.unmute();
  else sfx.mute();
}

export function toggleDeafen() {
  const deafened = !getApp().deafened;
  setApp({ deafened });
  media?.setMicEnabled(effectiveMic());
  sendPresence({ deafened });
  if (deafened) sfx.mute();
  else sfx.unmute();
}

export async function toggleCamera() {
  const s = getApp();
  if (!media || !s.voiceChannelId) return;
  try {
    const stream = await media.setCamera(!s.cameraOn);
    setApp({ cameraOn: !!stream, localCamera: stream });
    sendPresence({ cameraOn: !!stream });
  } catch (err) {
    toast(`Não consegui ligar a câmera: ${errorMessage(err)}.`, 'error');
  }
}

export async function startLive(quality: LiveQuality, audio: boolean, motion: boolean) {
  if (!media || !getApp().voiceChannelId) return;
  try {
    const stream = await media.startLive(quality, audio, motion);
    const live = { startedAt: Date.now(), quality, audio: stream.getAudioTracks().length > 0, viewers: 0 };
    setApp({ live, localScreen: stream, modal: null });
    sendPresence({ live });
    sfx.live();
    if (audio && !live.audio) toast('Sem áudio na live: marque “compartilhar áudio” na janela do navegador.', 'info', 6_000);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') toast('Compartilhamento cancelado.');
    else toast(`Não consegui iniciar a live: ${errorMessage(err)}.`, 'error');
  }
}

export function stopLive() {
  media?.stopLive();
  setApp({ live: null, localScreen: null });
  sendPresence({ live: null });
}

export function watchLive(streamerId: string) {
  if (!media || !session || getApp().watching[streamerId]) return;
  media.watch(streamerId);
  liveRetries.set(streamerId, 0);
  setApp((s) => ({ watching: { ...s.watching, [streamerId]: true } }));
  requestLive(streamerId, false);
}

export function unwatchLive(streamerId: string) {
  media?.dropLive(streamerId);
  clearTimeout(watchTimers.get(streamerId));
  watchTimers.delete(streamerId);
  liveRetries.delete(streamerId);
  setApp((s) => {
    const watching = { ...s.watching };
    delete watching[streamerId];
    return { watching, focus: s.focus === `live:${streamerId}` ? null : s.focus };
  });
  session?.send({ t: 'live:watch', streamerId, on: false });
}

/** Abre a live de alguém em destaque (e começa a assistir). */
export function openLive(streamerId: string) {
  const s = getApp();
  const member = s.room?.members.find((m) => m.id === streamerId);
  if (!member?.live || !member.voiceChannelId) return;
  if (streamerId !== s.meId) watchLive(streamerId);
  setApp({ callLayout: 'grid', focus: `live:${streamerId}`, memberCard: null });
  openChannel({ kind: 'voice', channelId: member.voiceChannelId });
}

// ───────────────────────── host ─────────────────────────

const admin = (action: AdminAction) => session?.send({ t: 'admin', action });
export const kick = (memberId: string, ban = false) => admin({ kind: 'kick', memberId, ban });
export const serverMute = (memberId: string, muted: boolean) => admin({ kind: 'mute', memberId, muted });
export const transferHost = (memberId: string) => admin({ kind: 'transfer', memberId });
export const setLocked = (locked: boolean) => admin({ kind: 'lock', locked });
export const renameRoom = (name: string) => admin({ kind: 'rename', name });
export const createChannel = (name: string, type: ChannelType) => admin({ kind: 'channel:create', name, type });
export const renameChannel = (id: string, name: string) => admin({ kind: 'channel:rename', id, name });
export const deleteChannel = (id: string) => admin({ kind: 'channel:delete', id });

// ───────────────────────── perfil e preferências ─────────────────────────

export function updateProfile(patch: Partial<Omit<Profile, 'id'>>) {
  const profile = { ...getApp().profile, ...patch };
  saveProfile(profile);
  setApp({ profile });
  session?.setIdentity({ name: profile.name, color: profile.color });
}

export function updateSettings(patch: Partial<Settings>) {
  const prev = getApp().settings;
  const settings = { ...prev, ...patch };
  saveSettings(settings);
  setApp({ settings });
  setSoundsEnabled(settings.sounds);
  const changed = (key: keyof Settings) => key in patch && patch[key] !== prev[key];
  if (media && (changed('audioInputId') || changed('echoCancellation') || changed('noiseSuppression') || changed('autoGainControl'))) {
    void media.refreshMic();
  }
  if (media && (changed('videoInputId') || changed('cameraQuality'))) {
    void media.refreshCamera().then((stream) => {
      if (stream) setApp({ localCamera: stream });
    });
  }
}

export function setVolume(memberId: string, value: number) {
  const volumes = { ...getApp().volumes, [baseId(memberId)]: value };
  saveVolumes(volumes);
  setApp({ volumes });
}

export function toggleLocalMute(memberId: string) {
  setApp((s) => ({ localMutes: { ...s.localMutes, [memberId]: !s.localMutes[memberId] } }));
}

// ───────────────────────── inicialização ─────────────────────────

export function initController() {
  if (initialized) return;
  initialized = true;
  setSoundsEnabled(getApp().settings.sounds);
  const code = inviteFromHash();
  if (code) setApp({ inviteCode: code });
  window.addEventListener('hashchange', () => {
    if (!session) setApp({ inviteCode: inviteFromHash() });
  });
  window.addEventListener('pagehide', () => session?.destroyNow());
  window.addEventListener('beforeunload', (e) => {
    const s = getApp();
    if (session && s.isHost && (s.room?.members.length ?? 0) > 1) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    const view = getApp().view;
    if (document.visibilityState === 'visible' && view?.kind === 'text' && session) openChannel(view);
  });
  window.addEventListener('keydown', (e) => {
    if (!session || !e.ctrlKey || !e.shiftKey) return;
    if (e.code === 'KeyM') {
      e.preventDefault();
      toggleMic();
    } else if (e.code === 'KeyD') {
      e.preventDefault();
      toggleDeafen();
    }
  });
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__orbita = { getApp, session: () => session };
  }
}
