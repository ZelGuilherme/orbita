import { APP_NAME, MAX_MESSAGES_PER_CHANNEL } from './lib/config';
import { canDownloadSize, FileShare, saveBlob, type TransferEvents } from './lib/files';
import { forgetFixedRoom, getFixedRoom, listFixedRooms, saveFixedRoom } from './lib/fixedRooms';
import { LobbyClient, type Knock } from './lib/lobby';
import { allowFx, clearDrawing, drawStroke, dropDrawing, emitFx, eraseDrawing, newFxLimits, setDrawing, validStrokes } from './lib/fx';
import { baseId } from './lib/hub';
import {
  appLikelyInstalled,
  canHandOff,
  cleanProtocolParam,
  codeFromUrl,
  forgetInstalled,
  markInstalled,
  onAppLaunch,
  openInApp,
  stayInBrowser,
  trackInstallation,
  wantsBrowser,
} from './lib/install';
import {
  comboFromMouse,
  hasModifier,
  isMouseCombo,
  loadKeyboardLayout,
  mainKey,
  matchesKeyboard,
  sameMainKey,
  type KeyAction,
} from './lib/keybinds';
import { mentionsName } from './lib/markdown';
import { randomOrbit, type OrbitStyle } from './lib/orbitPath';
import { MediaEngine, type LiveOptions, type LiveSurface, type MediaEvents } from './lib/media';
import { openPeer, PeerOpenError } from './lib/peer';
import { peekRoom } from './lib/fixedPeek';
import { activity } from './lib/activity';
import type Peer from 'peerjs';
import { clampVolume, resumePlayback } from './lib/playback';
import type { AdminAction, Attachment, ChatMessage, FileAttachment, LiveFx, LiveInfo, Member, PenLook, Presence, RoomState } from './lib/protocol';
import { JoinError, Session, type EndReason, type SessionHandlers } from './lib/session';
import { CallRecording, canRecord, ClipBuffer, extensionOf, Mixer } from './lib/recorder';
import { setSoundsEnabled, sfx } from './lib/sounds';
import { watchForUpdates } from './lib/update';
import {
  loadProfile,
  loadSettings,
  saveLiveVolumes,
  saveProfile,
  saveSettings,
  saveUiPrefs,
  saveVolumes,
  SYNCED_KEYS,
  validAvatar,
  type OrbitView,
  type Profile,
  type Settings,
  savePen,
  type PenPrefs,
} from './lib/storage';
import { copyText, errorMessage, inviteFromHash, inviteLink, parseRoomCode, randomId } from './lib/util';
import { getApp, resetRoomState, setApp, textChannelOf, toast, useApp, voiceChannelOf, type AppState, type FxTool } from './store';

/**
 * Cola entre a sessão P2P, a mídia e a interface. Os componentes só chamam estas
 * funções e leem o estado do store.
 */

let session: Session | null = null;
let media: MediaEngine | null = null;
let files: FileShare | null = null;
let lobby: LobbyClient | null = null;
let typingSentAt = 0;
let viewersTimer = 0;
let initialized = false;
let pendingJoin: string | null = null;
const liveRetries = new Map<string, number>();
const watchTimers = new Map<string, number>();
const fxLimits = newFxLimits();

function myMember(): Member | undefined {
  const s = getApp();
  return s.room?.members.find((m) => m.id === s.meId);
}

function voiceChannelId(): string | null {
  return voiceChannelOf(getApp().room)?.id ?? null;
}

function presence(): Presence {
  const s = getApp();
  return {
    voiceChannelId: s.inCall ? voiceChannelId() : null,
    micOn: s.micOn,
    deafened: s.deafened,
    cameraOn: s.cameraOn,
    live: s.live,
    recording: !!s.recording,
  };
}

function sendPresence(patch: Partial<Presence>) {
  session?.send({ t: 'presence', presence: patch });
}

/** O microfone só transmite ligado, sem ensurdecer, sem bloqueio do host e (no modo PTT) com a tecla pressionada. */
function effectiveMic(): boolean {
  const s = getApp();
  return s.micOn && !s.deafened && !myMember()?.serverMuted && (s.settings.voiceMode !== 'ptt' || s.pttDown);
}

/** O chat está à vista: aberto e com a janela visível. */
function chatVisible(): boolean {
  return getApp().chatOpen && document.visibilityState === 'visible';
}

function syncTitle() {
  const s = getApp();
  const base = s.room ? `${s.room.name} · ${APP_NAME}` : APP_NAME;
  document.title = (s.mentions ? `(${s.mentions}) ` : s.unread ? '• ' : '') + base;
}

// ───────────────────────── eventos da sessão ─────────────────────────

function chatOnly(messages: ChatMessage[], room: RoomState | null): ChatMessage[] {
  const textId = textChannelOf(room)?.id;
  return messages.filter((m) => m.channelId === textId);
}

function makeHandlers(meId: string): SessionHandlers {
  return {
    welcome: (state, messages) => {
      setApp({ messages: chatOnly(messages, state).slice(-MAX_MESSAGES_PER_CHANNEL) });
      applyState(state, meId, true);
    },
    state: (state) => applyState(state, meId, false),
    chat: onChat,
    chatUpdate: (message) => setApp((s) => ({ messages: s.messages.map((m) => (m.id === message.id ? message : m)) })),
    chatDelete: (id) => setApp((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
    typing: (memberId, channelId) => {
      if (channelId !== textChannelOf(getApp().room)?.id) return;
      setApp((s) => ({ typing: { ...s.typing, [memberId]: Date.now() + 6_000 } }));
    },
    speaking: (memberId, on) =>
      setApp((s) => (s.speaking[memberId] === on ? s : { speaking: { ...s.speaking, [memberId]: on } })),
    liveViewer: (viewerId, viewerPeerId, on) => media?.onLiveViewer(viewerId, viewerPeerId, on),
    fx: onRemoteFx,
    fxSync: (streamerId, strokes) => setDrawing(streamerId, validStrokes(strokes)),
    avatars: (avatars) => setApp({ avatars: Object.fromEntries(Object.entries(avatars).filter(([, url]) => validAvatar(url))) }),
    avatar: (memberId, avatar) =>
      setApp((s) => {
        const avatars = { ...s.avatars };
        if (validAvatar(avatar)) avatars[memberId] = avatar;
        else delete avatars[memberId];
        return { avatars };
      }),
    status: (status, detail) => {
      if (status === 'reconnecting') setApp({ net: 'reconnecting', netDetail: detail ?? 'loss' });
      else if (status === 'connected') setApp({ net: 'connected', netDetail: '' });
    },
    ended: onEnded,
    becameHost: () => toast('👑 Você virou o host — agora é o centro da órbita.', 'success', 5_000),
  };
}

/**
 * O estado da sala chega inteiro (e novo) a cada mudança. Quem não mudou continua sendo o mesmo
 * objeto de antes: assim a tela só redesenha o que mudou (e não cada planetinha e cada mensagem).
 */
function shareUnchanged(state: RoomState, prev: RoomState | null): RoomState {
  if (!prev) return state;
  const old = new Map(prev.members.map((m) => [m.id, m]));
  let same = state.members.length === prev.members.length;
  const members = state.members.map((m, i) => {
    const before = old.get(m.id);
    if (!before) {
      same = false;
      return m;
    }
    const keep = JSON.stringify(before) === JSON.stringify(m) ? before : { ...m, planet: JSON.stringify(before.planet) === JSON.stringify(m.planet) ? before.planet : m.planet };
    if (keep !== before || prev.members[i] !== before) same = false;
    return keep;
  });
  const next = { ...state, members: same ? prev.members : members };
  return JSON.stringify({ ...next, members: 0 }) === JSON.stringify({ ...prev, members: 0 }) && next.members === prev.members ? prev : next;
}

function applyState(incoming: RoomState, meId: string, first: boolean) {
  const s = getApp();
  const prev = s.room;
  const state = first ? incoming : shareUnchanged(incoming, prev);
  const mine = state.members.find((m) => m.id === meId);
  const callId = voiceChannelOf(state)?.id ?? null;
  const patch: Partial<AppState> = { room: state, meId, isHost: state.hostId === meId };

  if (prev && !first) {
    if (s.inCall) {
      const inCall = (r: RoomState) =>
        new Set(r.members.filter((m) => m.voiceChannelId && m.voiceChannelId === callId && m.id !== meId).map((m) => m.id));
      const before = inCall(prev);
      const after = inCall(state);
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
    for (const m of state.members) {
      const was = prev.members.find((p) => p.id === m.id);
      if (m.recording && !was?.recording && m.id !== meId) toast(`🔴 ${m.name} começou a gravar a chamada`, 'info', 5_000);
    }
    if (prev.hostId !== state.hostId && state.hostId !== meId) {
      const host = state.members.find((m) => m.id === state.hostId);
      if (host) toast(`👑 ${host.name} agora é o host`);
    }
    const wasMuted = !!prev.members.find((m) => m.id === meId)?.serverMuted;
    if (mine?.serverMuted && !wasMuted) toast('O host silenciou seu microfone.', 'error');
    if (mine && !mine.serverMuted && wasMuted) toast('O host liberou seu microfone.', 'success');
  }

  // quem saiu da chamada não está mais falando
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

  // lives que terminaram (e os desenhos delas)
  if (prev) for (const m of prev.members) if (m.live && !state.members.find((n) => n.id === m.id)?.live) dropDrawing(m.id);
  const watching = { ...s.watching };
  let watchingChanged = false;
  for (const id of Object.keys(watching)) {
    if (!state.members.find((m) => m.id === id)?.live) {
      delete watching[id];
      watchingChanged = true;
    }
  }
  if (watchingChanged) patch.watching = watching;
  setApp(patch);

  if (mine) media?.setMicEnabled(effectiveMic());
  if (s.inCall && !callId) leaveCall();
  media?.update(state);
  syncTitle();
}

function onChat(message: ChatMessage) {
  const s = getApp();
  if (message.channelId !== textChannelOf(s.room)?.id) return;
  const viewing = chatVisible();
  const mine = message.authorId === s.meId;
  const mentioned = !mine && !message.system && mentionsName(message.text, s.profile.name);
  const patch: Partial<AppState> = { messages: [...s.messages, message].slice(-MAX_MESSAGES_PER_CHANNEL) };
  if (!viewing && !mine && !message.system) {
    patch.unread = s.unread + 1;
    if (mentioned) patch.mentions = s.mentions + 1;
  }
  if (s.typing[message.authorId]) {
    const typing = { ...s.typing };
    delete typing[message.authorId];
    patch.typing = typing;
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
  // órbita fixa: guarda a última cópia antes de limpar (quem foi banido não guarda)
  if (reason === 'banned' && code) forgetFixed(code);
  else persistFixed(true);
  stopCapture(true);
  media?.destroy();
  media = null;
  files?.stop();
  files = null;
  session = null;
  watchTimers.forEach((timer) => clearTimeout(timer));
  watchTimers.clear();
  liveRetries.clear();
  resetRoomState();
  history.replaceState(null, '', location.pathname + location.search);
  const next = pendingJoin;
  pendingJoin = null;
  if (next) {
    setApp({ phase: 'landing', inviteCode: next });
    history.replaceState(null, '', `#/sala/${next}`);
    void enterRoom('join', next);
  } else if (reason === 'left') {
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
      setApp({ live: null, localScreen: null, liveSurface: null, floating: false });
      sendPresence({ live: null });
      toast('Sua live foi encerrada.');
    },
    liveDropped: (streamerId) => requestLive(streamerId, true),
    liveStalled: (streamerId) => {
      const name = getApp().room?.members.find((m) => m.id === streamerId)?.name ?? 'alguém';
      toast(`A live de ${name} travou. Reconectando…`);
      requestLive(streamerId, true);
    },
    cameraEnded: () => {
      setApp({ cameraOn: false, localCamera: null });
      sendPresence({ cameraOn: false });
    },
    micLost: () => toast('O microfone foi desconectado.', 'error'),
    quality: (links) => {
      // só atualiza a tela quando algo mudou
      if (JSON.stringify(links) !== JSON.stringify(getApp().quality)) setApp({ quality: links });
    },
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
        return 'Órbita não encontrada (ou fechada agora). O host pode ter fechado a sala, ou o código está errado.';
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

async function enterRoom(mode: 'create' | 'join' | 'reopen', arg: string, fixed = false) {
  if (session || getApp().phase === 'connecting') return;
  const { profile } = getApp();
  const saved = mode === 'reopen' ? getFixedRoom(arg) : undefined;
  if (mode === 'reopen' && !saved) return;
  if (saved?.banned.includes(profile.id)) {
    setApp({ landingError: 'Você foi banido desta órbita.' });
    return;
  }
  resetRoomState();
  setApp({
    phase: 'connecting',
    landingError: null,
    connectingText: mode === 'create' ? 'Criando sua órbita…' : mode === 'reopen' ? `Abrindo a órbita ${saved?.name ?? arg}…` : `Entrando na órbita ${arg}…`,
  });
  const memberId = `${profile.id}.${randomId(6)}`;
  // cada entrada sorteia uma órbita nova em volta do host (arrastando o planeta, dá para mudar)
  const orbit = randomOrbit(memberId);
  updateProfile({ orbit });
  const identity = { id: memberId, name: profile.name, color: profile.color, avatar: profile.avatar, planet: profile.planet, orbit };
  const handlers = makeHandlers(identity.id);
  try {
    let created: Session;
    if (mode === 'create') created = await Session.create(identity, arg, presence, handlers, fixed);
    else if (saved) created = await Session.reopen(identity, saved, presence, handlers);
    else {
      try {
        created = await Session.join(identity, arg, presence, handlers);
      } catch (err) {
        // órbita fixa vazia que eu já conheço: reabro (e viro o host)
        const known = getFixedRoom(arg);
        if (!(err instanceof JoinError && err.code === 'not-found' && known && !known.banned.includes(profile.id))) throw err;
        setApp({ connectingText: `A órbita ${known.name} estava vazia: reabrindo…` });
        created = await Session.reopen(identity, known, presence, handlers);
      }
    }
    session = created;
    media = new MediaEngine(mediaEvents(), () => getApp().settings);
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__orbitaMedia = media;
    media.attach(created.peer, created.meId);
    files = new FileShare(
      created.peer,
      (peerId) => !!getApp().room?.members.some((m) => m.peerId === peerId),
      (ownerId) => getApp().room?.members.find((m) => m.id === ownerId && !m.reconnecting)?.peerId ?? null,
      transferEvents(),
    );
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__orbitaFiles = files;
    if (created.state) media.update(created.state);
    setApp({ phase: 'room', code: created.code, meId: created.meId, inviteCode: null, unread: 0, mentions: 0 });
    history.replaceState(null, '', `#/sala/${created.code}`);
    if (mode === 'create') setApp({ modal: { kind: 'invite' } });
    // quem cria a sala e quem entra (pelo link ou pelo código) já cai na chamada, com o microfone como as configurações mandam
    void joinCall();
  } catch (err) {
    resetRoomState();
    setApp({ phase: 'landing', landingError: describeError(err) });
  }
}

export const createRoom = (roomName: string, fixed = false) => enterRoom('create', roomName, fixed);

/** Reabre (ou entra, se alguém já abriu) uma órbita fixa guardada. */
export const reopenRoom = (code: string) => enterRoom('reopen', code);

// ───────────────────────── órbitas fixas ─────────────────────────

let fixedTimer = 0;

/** Guarda a cópia da órbita fixa em que estou (nome, configurações, banidos, histórico e fixadas). */
function persistFixed(now = false) {
  const run = () => {
    clearTimeout(fixedTimer);
    fixedTimer = 0;
    const s = getApp();
    const room = s.room;
    if (!room?.fixed || !s.code) return;
    saveFixedRoom({
      code: room.code,
      name: room.name,
      ownerId: room.ownerId ?? '',
      ownerKey: room.ownerKey,
      channels: room.channels,
      banned: room.banned,
      bannedKeys: room.bannedKeys,
      locked: room.locked,
      listed: room.listed !== false,
      messages: s.messages,
      savedAt: Date.now(),
    });
    setApp({ fixedRooms: listFixedRooms() });
  };
  // salva no máximo 4 s depois da primeira mudança (numa sala movimentada o relógio não recomeça)
  if (now) run();
  else if (!fixedTimer) fixedTimer = window.setTimeout(run, 4_000);
}

function forgetFixed(code: string) {
  forgetFixedRoom(code);
  setApp({ fixedRooms: listFixedRooms() });
}

/** Tira uma órbita fixa da lista deste navegador. */
export const forgetRoom = (code: string) => forgetFixed(code);

let fixedWatching = false;
function watchFixed() {
  if (fixedWatching) return;
  fixedWatching = true;
  useApp.subscribe((s, prev) => {
    if (s.room !== prev.room || s.messages !== prev.messages) {
      // o host desligou "fixa": esta cópia não serve mais
      if (prev.room?.fixed && s.room && !s.room.fixed && s.room.code === prev.room.code) forgetFixed(s.room.code);
      else if (s.room?.fixed) persistFixed();
    }
  });
}

/** Host: liga/desliga a órbita fixa (mesmo link sempre). */
export const setFixed = (fixed: boolean) => admin({ kind: 'fixed', fixed });

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
    // a coroa passa sozinha para quem está há mais tempo (de preferência quem está na chamada)
    const callId = voiceChannelOf(s.room)?.id;
    const next = [...others].sort((a, b) => Number(b.voiceChannelId === callId) - Number(a.voiceChannelId === callId) || a.joinedAt - b.joinedAt)[0];
    setApp({
      modal: {
        kind: 'confirm',
        title: 'Sair da órbita?',
        body: `A sala e a chamada continuam: ${next.name} vira o host. (Para fechar a sala para todo mundo, use “Encerrar a órbita” no menu da sala.)`,
        confirm: 'Sair',
        danger: true,
        action: () => session?.transferAndLeave(next.id),
      },
    });
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

/** Host: fechar a sala para todo mundo (com confirmação). */
export function requestEnd() {
  setApp({
    modal: {
      kind: 'confirm',
      title: 'Encerrar a órbita para todos?',
      body: 'Todo mundo sai, a chamada acaba e o convite para de funcionar (numa órbita fixa, dá para reabrir depois).',
      confirm: 'Encerrar para todos',
      danger: true,
      action: () => session?.endForAll(),
    },
  });
}
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

/** Grava as preferências da interface (chat, lista de pessoas, faixa de planetas, 3D). */
function persistUi() {
  const s = getApp();
  saveUiPrefs({ chatOpen: s.chatOpen, chatWidth: s.chatWidth, orbitHidden: s.orbitHidden, orbitView: s.orbitView, peopleWidth: s.peopleWidth, peopleHidden: s.peopleHidden, fxBarHidden: s.fxBarHidden });
}

/** Minimiza ou mostra a barra de laser/lápis da live (fica salvo). Minimizando, a ferramenta desliga. */
export function setFxBarHidden(fxBarHidden: boolean) {
  setApp(fxBarHidden ? { fxBarHidden, tool: null } : { fxBarHidden });
  persistUi();
}

/** Como a órbita aparece: 3D, 2D (órbita plana) ou todos numa linha (fica salvo). */
export function setOrbitView(orbitView: OrbitView) {
  setApp({ orbitView });
  persistUi();
}

/** Arrastei o meu planeta: a órbita nova fica no perfil e vai para todo mundo. */
export const setMyOrbit = (orbit: OrbitStyle) => updateProfile({ orbit });

export function setChatOpen(chatOpen: boolean) {
  setApp((s) => ({ chatOpen, unread: chatOpen ? 0 : s.unread, mentions: chatOpen ? 0 : s.mentions }));
  persistUi();
  syncTitle();
}

/** Largura do chat arrastando a borda (null = volta ao padrão). */
/** Recarrega para a versão nova (sai da sala; o convite continua no endereço). */
export function applyUpdate() {
  session?.destroyNow();
  location.reload();
}

export function setChatWidth(chatWidth: number | null, save = true) {
  setApp({ chatWidth });
  if (save) persistUi();
}

/** Largura da lista de pessoas arrastando a borda (null = volta ao padrão). */
export function setPeopleWidth(peopleWidth: number | null, save = true) {
  setApp({ peopleWidth });
  if (save) persistUi();
}

/** Minimiza ou mostra a lista de pessoas da esquerda (fica salvo). */
export function setPeopleHidden(peopleHidden: boolean) {
  setApp({ peopleHidden });
  persistUi();
}

/** Esconde ou mostra a faixa de planetas embaixo da live (fica salvo). */
export function setOrbitHidden(orbitHidden: boolean) {
  setApp({ orbitHidden });
  persistUi();
}

/** Abre a câmera de alguém grande no centro (null = volta para a órbita ou para a live). */
export const showCamera = (memberId: string | null) => setApp({ focus: memberId ? `cam:${memberId}` : null, memberCard: null, peopleOpen: false });

export const toggleChat = () => setChatOpen(!getApp().chatOpen);

export function sendMessage(text: string, attachment?: Attachment) {
  const s = getApp();
  const channelId = textChannelOf(s.room)?.id;
  if (!channelId) return;
  const replyTo = s.replyTo && s.messages.some((m) => m.id === s.replyTo) ? s.replyTo : undefined;
  session?.send({ t: 'chat', channelId, text, attachment, replyTo });
  if (s.replyTo) setApp({ replyTo: null });
  typingSentAt = 0;
}

/** Responder a uma mensagem (null cancela). */
export const setReply = (id: string | null) => setApp({ replyTo: id });

/** Host: fixa ou solta uma mensagem. */
export const pinMessage = (id: string, pinned: boolean) => session?.send({ t: 'chat:pin', id, pinned });

// ───────────────────────── arquivos ─────────────────────────

function setTransfer(fileId: string, patch: Partial<AppState['transfers'][string]> | null) {
  setApp((s) => {
    const transfers = { ...s.transfers };
    if (!patch) delete transfers[fileId];
    else transfers[fileId] = { ...(transfers[fileId] ?? { received: 0, size: 0, status: 'downloading' }), ...patch };
    return { transfers };
  });
}

function transferEvents(): TransferEvents {
  return {
    progress: (fileId, received, size, speed) => setTransfer(fileId, { received, size, speed, status: 'downloading' }),
    retrying: (fileId) => setTransfer(fileId, { status: 'retrying' }),
    done: (fileId) => setTransfer(fileId, { status: 'done' }),
    failed: (fileId, reason) => {
      setTransfer(fileId, { status: 'error', reason });
      toast(
        reason === 'gone'
          ? 'Esse arquivo não está mais disponível.'
          : reason === 'disk'
            ? 'Não consegui gravar o arquivo no disco (sem espaço ou sem permissão).'
            : 'A transferência do arquivo caiu e não voltou. Tente de novo.',
        'error',
      );
    },
  };
}

/** Guarda um arquivo para mandar no chat (ele fica no meu computador; quem baixa busca daqui). */
export function shareFile(file: File): FileAttachment {
  const meId = getApp().meId;
  if (!files || !meId) throw new Error('Entre numa órbita para mandar arquivos.');
  return files.share(file, meId);
}

/** Baixar (chamado no clique: arquivos grandes perguntam onde salvar). */
export async function downloadFile(attachment: FileAttachment) {
  const s = getApp();
  if (!files) return;
  const mine = files.local(attachment.fileId);
  if (mine) {
    saveBlob(mine, attachment.name);
    return;
  }
  const owner = s.room?.members.find((m) => m.id === attachment.ownerId && !m.reconnecting);
  if (!owner) {
    setTransfer(attachment.fileId, { status: 'error', reason: 'gone' });
    return;
  }
  if (!canDownloadSize(attachment.size)) {
    toast('Arquivo grande demais para este navegador: abra o Órbita no Chrome, Edge ou Brave para baixar.', 'error', 6_000);
    return;
  }
  const started = await files.download(attachment);
  if (started) setTransfer(attachment.fileId, { received: 0, size: attachment.size, status: 'downloading', reason: undefined, speed: 0 });
}

export function cancelDownload(fileId: string) {
  files?.cancel(fileId);
  setTransfer(fileId, null);
}

/** Tenho esse arquivo aqui (fui eu que mandei, nesta sessão)? */
export const hasLocalFile = (fileId: string) => !!files?.local(fileId);

export const editMessage = (id: string, text: string) => session?.send({ t: 'chat:edit', id, text });
export const deleteMessage = (id: string) => session?.send({ t: 'chat:delete', id });
export const react = (id: string, emoji: string) => session?.send({ t: 'chat:react', id, emoji });

export function notifyTyping() {
  const now = Date.now();
  const channelId = textChannelOf(getApp().room)?.id;
  if (!channelId || now - typingSentAt < 2_500) return;
  typingSentAt = now;
  session?.send({ t: 'typing', channelId });
}

// ───────────────────────── chamada, câmera e microfone ─────────────────────────

export async function joinCall() {
  const s = getApp();
  const channelId = voiceChannelId();
  if (!media || !session || s.joiningVoice || s.inCall || !channelId) return;
  setApp(s.settings.joinMuted ? { joiningVoice: true, micOn: false } : { joiningVoice: true });
  const engine = media;
  const micAvailable = await engine.joinVoice(channelId, effectiveMic());
  if (!session || media !== engine) return;
  const micOn = micAvailable ? getApp().micOn : false;
  if (!micAvailable) toast('Microfone indisponível ou bloqueado — você entrou só para ouvir.', 'error', 5_000);
  else if (engine.voiceFilterFailed) toast('Não consegui carregar a supressão de ruído escolhida. A voz está saindo sem ela.', 'error', 6_000);
  setApp({ inCall: true, micOn, joiningVoice: false, peopleOpen: false });
  engine.setMicEnabled(effectiveMic());
  syncClips();
  sendPresence({ voiceChannelId: channelId, micOn, deafened: getApp().deafened, cameraOn: false, live: null });
  sfx.join();
  if (getApp().settings.voiceMode === 'ptt' && !getApp().settings.keybinds.pushToTalk) {
    toast('Seu modo de voz é “Pressionar para falar”, mas falta escolher a tecla em Configurações › Atalhos.', 'info', 7_000);
  }
}

export function leaveCall(silent = false) {
  const s = getApp();
  if (!s.inCall) return;
  // o host saindo da chamada: a coroa passa para quem está nela (a órbita não fica sem centro)
  if (s.isHost && s.room) {
    const callId = voiceChannelOf(s.room)?.id;
    const next = s.room.members.filter((m) => m.id !== s.meId && !m.reconnecting && callId && m.voiceChannelId === callId).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) admin({ kind: 'transfer', memberId: next.id });
  }
  stopCapture(false);
  media?.leaveVoice();
  setApp({ inCall: false, cameraOn: false, live: null, liveSurface: null, localCamera: null, localScreen: null, floating: false, pttDown: false });
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

function setPushToTalk(down: boolean) {
  const s = getApp();
  if (s.pttDown === down) return;
  setApp({ pttDown: down });
  media?.setMicEnabled(effectiveMic());
  if (s.inCall && s.micOn && !s.deafened) {
    if (down) sfx.pttOn();
    else sfx.pttOff();
  }
}

export async function toggleCamera() {
  const s = getApp();
  if (!media || !s.inCall) return;
  try {
    const stream = await media.setCamera(!s.cameraOn);
    setApp({ cameraOn: !!stream, localCamera: stream });
    sendPresence({ cameraOn: !!stream });
  } catch (err) {
    toast(`Não consegui ligar a câmera: ${errorMessage(err)}.`, 'error');
  }
}

// ───────────────────────── gravação e clipes ─────────────────────────

let mixer: Mixer | null = null;
let mixerTimer = 0;
let mixerUnsub: (() => void) | null = null;
let recorder: CallRecording | null = null;
let recordName = '';
let clipBuffer: ClipBuffer | null = null;

/** A live em destaque (a escolhida ou, sem escolha, a que estiver no ar; a dos outros primeiro). */
function featuredLive(s: AppState): { id: string; name: string; stream: MediaStream | null } | null {
  const callId = voiceChannelOf(s.room)?.id;
  const members = s.room?.members.filter((m) => m.voiceChannelId && m.voiceChannelId === callId) ?? [];
  const chosen = s.focus?.startsWith('live:') ? members.find((m) => m.id === s.focus!.slice(5) && m.live) : undefined;
  const live = chosen ?? members.find((m) => m.live && m.id !== s.meId) ?? members.find((m) => m.live);
  if (!live) return null;
  const stream = live.id === s.meId ? s.localScreen : (s.liveStreams[live.id] ?? null);
  return { id: live.id, name: live.name, stream };
}

/** Atualiza o que entra na gravação: vozes, a minha voz, o som e a imagem da live em destaque. */
function syncMixer() {
  if (!mixer) return;
  const s = getApp();
  const tracks: MediaStreamTrack[] = [];
  for (const stream of Object.values(s.voiceStreams)) tracks.push(...stream.getAudioTracks());
  const mine = media?.localVoiceTrack();
  if (mine) tracks.push(mine);
  const live = featuredLive(s);
  if (live?.stream) tracks.push(...live.stream.getAudioTracks());
  mixer.setAudio(tracks);
  mixer.setVideo(live?.stream ?? null, live ? `Live de ${live.name} (conectando…)` : 'Sem live no momento');
}

function ensureMixer(): Mixer {
  if (!mixer) {
    mixer = new Mixer();
    mixerUnsub = useApp.subscribe((s, prev) => {
      if (s.voiceStreams !== prev.voiceStreams || s.liveStreams !== prev.liveStreams || s.focus !== prev.focus || s.room !== prev.room || s.localScreen !== prev.localScreen) syncMixer();
    });
    // a minha voz muda de faixa quando troco de microfone: confere de tempos em tempos
    mixerTimer = window.setInterval(syncMixer, 3_000);
  }
  syncMixer();
  return mixer;
}

function releaseMixer() {
  if (recorder || clipBuffer || !mixer) return;
  mixerUnsub?.();
  mixerUnsub = null;
  clearInterval(mixerTimer);
  mixer.dispose();
  mixer = null;
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const roomSlug = () =>
  (getApp().room?.name ?? 'orbita')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'orbita';
/** Começo do nome dos arquivos: "orbita-nome-da-sala" (sem repetir quando a sala já se chama Órbita…). */
const fileBase = () => {
  const slug = roomSlug();
  return slug.startsWith('orbita') ? slug : `orbita-${slug}`;
};

type SavePicker = (opts: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{
  createWritable(): Promise<FileSystemWritableFileStream>;
}>;

/** Grava a chamada: o som de todo mundo e, se houver, a live em destaque. Todo mundo vê o aviso. */
export async function toggleRecording() {
  if (recorder) {
    await stopRecording();
    return;
  }
  const s = getApp();
  if (!s.inCall || !media) return;
  if (!canRecord()) {
    toast('Este navegador não consegue gravar.', 'error');
    return;
  }
  const video = !!featuredLive(s);
  const ext = 'webm';
  recordName = `${fileBase()}-${stamp()}.${ext}`;
  // no Chrome/Edge/Brave dá para gravar direto num arquivo (sem limite de memória)
  let sink: FileSystemWritableFileStream | null = null;
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: recordName,
        types: [video ? { description: 'Vídeo WebM', accept: { 'video/webm': ['.webm'] } } : { description: 'Áudio WebM', accept: { 'audio/webm': ['.webm'] } }],
      });
      sink = await handle.createWritable();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      sink = null;
    }
  }
  if (!getApp().inCall || recorder) {
    void sink?.close();
    return;
  }
  const m = ensureMixer();
  const stream = new MediaStream(video ? [m.audio, m.videoTrack()] : [m.audio]);
  try {
    recorder = new CallRecording(stream, video, sink);
  } catch (err) {
    void sink?.close();
    releaseMixer();
    toast(`Não consegui começar a gravar: ${errorMessage(err)}.`, 'error');
    return;
  }
  setApp({ recording: { since: Date.now(), video } });
  sendPresence({ recording: true });
  toast(video ? 'Gravando: vozes e a live em destaque.' : 'Gravando o áudio da chamada.', 'success');
}

async function stopRecording(quiet = false) {
  const rec = recorder;
  if (!rec) return;
  recorder = null;
  setApp({ recording: null });
  sendPresence({ recording: false });
  const blob = await rec.stop();
  releaseMixer();
  if (blob) {
    const name = recordName.replace(/\.webm$/, `.${extensionOf(rec.mime)}`);
    saveBlob(blob, name);
  }
  if (!quiet) toast(blob ? 'Gravação salva nos downloads.' : 'Gravação salva no arquivo escolhido.', 'success');
}

/** Liga/desliga o "último minuto" conforme as configurações e se estou na chamada. */
function syncClips() {
  const s = getApp();
  const want = s.settings.clips && s.inCall && canRecord();
  if (want && !clipBuffer) {
    const m = ensureMixer();
    clipBuffer = new ClipBuffer(() => {
      const video = !!featuredLive(getApp());
      return { stream: new MediaStream(video ? [m.audio, m.videoTrack()] : [m.audio]), video };
    });
  } else if (!want && clipBuffer) {
    clipBuffer.stop();
    clipBuffer = null;
    releaseMixer();
  }
}

export async function saveClip() {
  const s = getApp();
  if (!s.inCall) return;
  if (!clipBuffer) {
    toast('Ligue os clipes em Configurações › Voz e vídeo para salvar o último minuto.', 'info', 5_000);
    return;
  }
  const clip = await clipBuffer.clip();
  if (!clip || clip.blob.size === 0) {
    toast('Ainda não há nada para o clipe.', 'error');
    return;
  }
  saveBlob(clip.blob, `${fileBase()}-clipe-${stamp()}.${extensionOf(clip.mime)}`);
  session?.send({ t: 'clip' });
  toast(`🎬 Clipe salvo (${clip.seconds} s).`, 'success');
}

/** Saindo da chamada ou da sala: termina a gravação (salvando) e os clipes. */
function stopCapture(leavingRoom: boolean) {
  if (clipBuffer) {
    clipBuffer.stop();
    clipBuffer = null;
  }
  // a gravação solta o mixer sozinha depois de terminar de salvar
  if (recorder) void stopRecording(leavingRoom);
  else releaseMixer();
}

// ───────────────────────── lives ─────────────────────────

/** Dica para quando a pessoa pediu som, mas o navegador entregou a captura sem áudio. */
function audioHint(surface: LiveSurface): string {
  if (surface === 'window') return 'A live está sem som: na janela de escolha, ative a opção de compartilhar o áudio do app.';
  if (surface === 'browser') return 'A live está sem som: na janela de escolha, ative “compartilhar áudio da guia”.';
  if (surface === 'monitor') return 'A live está sem som: na janela de escolha, ative “compartilhar áudio do sistema”.';
  return 'A live está sem som: este navegador não entregou o áudio da captura.';
}

function liveOptions(): LiveOptions {
  const s = getApp().settings;
  return { quality: s.liveQuality, audio: s.liveAudio, motion: s.liveMotion };
}

export async function startLive() {
  if (!media || !getApp().inCall) return;
  const opts = liveOptions();
  try {
    const capture = await media.startLive(opts);
    const live: LiveInfo = {
      startedAt: Date.now(),
      quality: opts.quality,
      audio: capture.hasAudio && opts.audio,
      viewers: 0,
      effects: getApp().settings.liveEffects,
    };
    setApp({ live, localScreen: capture.stream, liveSurface: capture.surface, modal: null, floatTipClosed: false, ownPreview: false });
    sendPresence({ live });
    sfx.live();
    if (opts.audio && !capture.hasAudio) toast(audioHint(capture.surface), 'info', 8_000);
    else if (capture.hasAudio && capture.surface !== 'browser' && !capture.ownAudioRemoved) {
      // navegador sem a remoção do próprio som: as vozes da chamada iriam junto
      toast('Este navegador não tira as vozes da chamada do som da live: quem assiste pode ouvir eco. Use Chrome, Edge ou Brave atualizados.', 'error', 9_000);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') toast('Compartilhamento cancelado.');
    else toast(`Não consegui iniciar a live: ${errorMessage(err)}.`, 'error');
  }
}

export function stopLive() {
  media?.stopLive();
  setApp({ live: null, localScreen: null, liveSurface: null, floating: false });
  sendPresence({ live: null });
}

/** Troca a tela/janela/aba com a live no ar (os espectadores continuam conectados). */
export async function switchLiveSource(audio = getApp().settings.liveAudio) {
  const s = getApp();
  if (!media || !s.live) return;
  const opts = { ...liveOptions(), audio };
  try {
    const capture = await media.switchLiveSource(opts);
    const current = getApp().live;
    if (!current) return;
    const live = { ...current, audio: capture.hasAudio && audio };
    if (audio !== s.settings.liveAudio) updateSettings({ liveAudio: audio });
    setApp({ live, localScreen: capture.stream, liveSurface: capture.surface });
    sendPresence({ live });
    if (audio && !capture.hasAudio) toast(audioHint(capture.surface), 'info', 8_000);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotAllowedError')) toast(`Não consegui trocar a fonte: ${errorMessage(err)}.`, 'error');
  }
}

/** Muda as opções da live sem encerrar (qualidade, movimento, som e efeitos). */
export async function updateLiveOptions(patch: Partial<LiveOptions> & { effects?: boolean }) {
  const s = getApp();
  const settingsPatch: Partial<Settings> = {};
  if (patch.quality) settingsPatch.liveQuality = patch.quality;
  if (patch.motion !== undefined) settingsPatch.liveMotion = patch.motion;
  if (patch.effects !== undefined) settingsPatch.liveEffects = patch.effects;
  if (patch.audio !== undefined) settingsPatch.liveAudio = patch.audio;
  updateSettings(settingsPatch);
  if (!media || !s.live) return;

  let live: LiveInfo = { ...s.live };
  if (patch.quality || patch.motion !== undefined) {
    const quality = patch.quality ?? s.live.quality;
    await media.updateLive({ quality, motion: patch.motion ?? s.settings.liveMotion });
    live.quality = quality;
  }
  if (patch.audio !== undefined) {
    if (!media.setLiveAudio(patch.audio)) {
      // a captura veio sem som: para ligar, é preciso escolher a fonte de novo com o áudio marcado
      await switchLiveSource(true);
      return;
    }
    live.audio = patch.audio;
  }
  if (patch.effects !== undefined) live.effects = patch.effects;
  live = { ...live, viewers: getApp().live?.viewers ?? live.viewers };
  setApp({ live });
  sendPresence({ live });
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

/** Botão "Reconectar": refaz a conexão da live sem deixar de assistir. */
export function reconnectLive(streamerId: string) {
  if (!media || !getApp().watching[streamerId]) return;
  media.resetLive(streamerId);
  liveRetries.set(streamerId, 0);
  requestLive(streamerId, false);
}

/** Abre a live de alguém em destaque (e começa a assistir). */
export function openLive(streamerId: string) {
  const s = getApp();
  const member = s.room?.members.find((m) => m.id === streamerId);
  if (!member?.live) return;
  if (streamerId !== s.meId) watchLive(streamerId);
  setApp({ focus: `live:${streamerId}`, memberCard: null, peopleOpen: false });
}

export function setLiveVolume(memberId: string, value: number) {
  const liveVolumes = { ...getApp().liveVolumes, [baseId(memberId)]: clampVolume(value) };
  saveLiveVolumes(liveVolumes);
  setApp((s) => ({ liveVolumes, liveMutes: { ...s.liveMutes, [memberId]: value === 0 } }));
}

export function toggleLiveMute(memberId: string) {
  setApp((s) => {
    const muted = !s.liveMutes[memberId];
    // desmutar com o volume em 0 volta para um volume audível
    if (!muted && (s.liveVolumes[baseId(memberId)] ?? 100) === 0) {
      const liveVolumes = { ...s.liveVolumes, [baseId(memberId)]: 60 };
      saveLiveVolumes(liveVolumes);
      return { liveVolumes, liveMutes: { ...s.liveMutes, [memberId]: false } };
    }
    return { liveMutes: { ...s.liveMutes, [memberId]: muted } };
  });
}

// ───────────────────────── laser e lápis ─────────────────────────

function onRemoteFx(from: string, streamerId: string, fx: LiveFx) {
  const s = getApp();
  if (streamerId !== s.meId && !s.watching[streamerId]) return;
  if (fx.kind === 'stroke') drawStroke(streamerId, from, fx.id, fx.points, fx);
  else if (fx.kind === 'erase') eraseDrawing(streamerId, fx.points, fx.size, fx.aspect);
  else if (fx.kind === 'clear') clearDrawing(streamerId);
  else emitFx({ streamerId, from, fx });
}

function sendFx(streamerId: string, fx: LiveFx): boolean {
  const s = getApp();
  if (!session || !s.meId) return false;
  const streamer = s.room?.members.find((m) => m.id === streamerId);
  if (!streamer?.live || (!streamer.live.effects && streamerId !== s.meId)) return false;
  if (!allowFx(fxLimits, fx, Date.now())) return false;
  session.send({ t: 'fx', streamerId, fx });
  return true;
}

let laserSentAt = 0;
let laserTimer = 0;
let laserPending: { streamerId: string; x: number; y: number } | null = null;

/** Laser: a posição local aparece na hora; para a rede vão ~60 posições por segundo. */
export function moveLaser(streamerId: string, x: number, y: number) {
  const s = getApp();
  if (!session || !s.meId) return;
  emitFx({ streamerId, from: s.meId, fx: { kind: 'laser', x, y } });
  laserPending = { streamerId, x, y };
  const flush = () => {
    laserTimer = 0;
    if (!laserPending) return;
    laserSentAt = Date.now();
    sendFx(laserPending.streamerId, { kind: 'laser', x: laserPending.x, y: laserPending.y });
    laserPending = null;
  };
  const wait = 16 - (Date.now() - laserSentAt);
  if (wait <= 0) flush();
  else if (!laserTimer) laserTimer = window.setTimeout(flush, wait);
}

export function hideLaser(streamerId: string) {
  const s = getApp();
  clearTimeout(laserTimer);
  laserTimer = 0;
  laserPending = null;
  if (!s.meId) return;
  emitFx({ streamerId, from: s.meId, fx: { kind: 'laser-off' } });
  sendFx(streamerId, { kind: 'laser-off' });
}

let stroke: { streamerId: string; id: string; pending: number[]; timer: number; look: PenLook } | null = null;

const roundPoint = (x: number, y: number) => [Math.round(x * 10_000) / 10_000, Math.round(y * 10_000) / 10_000];

/** Cor, tamanho e estilo do pincel agora (sem cor escolhida, a do meu planeta). */
function penLook(): PenLook {
  const s = getApp();
  return { color: s.pen.color ?? s.profile.color, size: s.pen.size, style: s.pen.style };
}

function flushStroke() {
  if (!stroke) return;
  clearTimeout(stroke.timer);
  stroke.timer = 0;
  while (stroke.pending.length) {
    const points = stroke.pending.splice(0, 200);
    sendFx(stroke.streamerId, { kind: 'stroke', id: stroke.id, points, ...stroke.look });
  }
}

/** Lápis: começa um traço novo. */
export function beginStroke(streamerId: string, x: number, y: number) {
  endStroke();
  stroke = { streamerId, id: randomId(10), pending: [], timer: 0, look: penLook() };
  extendStroke(x, y);
}

/** Lápis: mais um ponto do traço atual (aparece na hora; vai para a rede a cada 30 ms). */
export function extendStroke(x: number, y: number) {
  const s = getApp();
  if (!stroke || !s.meId) return;
  const point = roundPoint(x, y);
  drawStroke(stroke.streamerId, s.meId, stroke.id, point, stroke.look);
  stroke.pending.push(...point);
  if (!stroke.timer) stroke.timer = window.setTimeout(flushStroke, 30);
}

export function endStroke() {
  flushStroke();
  stroke = null;
}

let erasing: { streamerId: string; aspect: number; size: number; last: number[] | null; sentTail: number[] | null; pending: number[]; timer: number } | null = null;

function flushErase() {
  if (!erasing) return;
  clearTimeout(erasing.timer);
  erasing.timer = 0;
  while (erasing.pending.length) {
    // cada pedaço começa no último ponto do anterior: o caminho chega inteiro, sem buracos
    const chunk = erasing.pending.splice(0, 200);
    const points = erasing.sentTail ? [...erasing.sentTail, ...chunk] : chunk;
    erasing.sentTail = chunk.slice(-2);
    sendFx(erasing.streamerId, { kind: 'erase', points, size: erasing.size, aspect: erasing.aspect });
  }
}

/** Borracha: começa a apagar (aspect = largura / altura da imagem da live). */
export function beginErase(streamerId: string, x: number, y: number, aspect: number) {
  endErase();
  erasing = { streamerId, aspect: Math.round(aspect * 1000) / 1000, size: getApp().pen.eraserSize, last: null, sentTail: null, pending: [], timer: 0 };
  extendErase(x, y);
}

/** Borracha: mais um ponto do caminho (apaga na hora aqui; vai para a rede a cada 30 ms). */
export function extendErase(x: number, y: number) {
  if (!erasing) return;
  const point = roundPoint(x, y);
  eraseDrawing(erasing.streamerId, erasing.last ? [...erasing.last, ...point] : point, erasing.size, erasing.aspect);
  erasing.last = point;
  erasing.pending.push(...point);
  if (!erasing.timer) erasing.timer = window.setTimeout(flushErase, 30);
}

export function endErase() {
  flushErase();
  erasing = null;
}

/** Muda cor, tamanho ou estilo do pincel, ou o tamanho da borracha (fica salvo). */
export function setPen(patch: Partial<PenPrefs>) {
  const pen = { ...getApp().pen, ...patch };
  savePen(pen);
  setApp({ pen });
}

/** Apaga todos os desenhos da live (qualquer pessoa pode). */
export function clearDrawings(streamerId: string) {
  if (sendFx(streamerId, { kind: 'clear' })) clearDrawing(streamerId);
}

export const setTool = (tool: FxTool | null) => setApp((s) => ({ tool: s.tool === tool ? null : tool }));

// ───────────────────────── host ─────────────────────────

const admin = (action: AdminAction) => session?.send({ t: 'admin', action });
export const kick = (memberId: string, ban = false) => admin({ kind: 'kick', memberId, ban });
export const serverMute = (memberId: string, muted: boolean) => admin({ kind: 'mute', memberId, muted });
export const transferHost = (memberId: string) => admin({ kind: 'transfer', memberId });
export const setLocked = (locked: boolean) => admin({ kind: 'lock', locked });
/** Host: mostra ou esconde a órbita na lista de órbitas abertas. */
export const setListed = (listed: boolean) => admin({ kind: 'listed', listed });

// ───────────────────────── lista de órbitas (saguão) ─────────────────────────

let lobbyWatching = false;

/**
 * A conexão com a lista de órbitas só fica aberta na tela inicial, para o host (que anuncia a
 * sala e recebe pedidos) e para quem está segurando o ponto de encontro. Quem está numa sala
 * como membro não precisa dela: menos uma conexão com o servidor de sinalização por pessoa.
 */
function lobbyWanted(): boolean {
  const s = getApp();
  return s.phase !== 'room' || s.isHost || !!lobby?.isServer;
}

function syncLobby() {
  const want = lobbyWanted();
  if (want && !lobby) {
    lobby = new LobbyClient({
      rooms: (lobbyRooms) => setApp({ lobbyRooms }),
      online: (lobbyOnline) => setApp({ lobbyOnline }),
      knock: onKnock,
      knockGone: (knockId) => setApp((s) => ({ knocks: s.knocks.filter((k) => k.knockId !== knockId) })),
    });
    void lobby.start();
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__orbitaLobby = lobby;
  } else if (!want && lobby) {
    lobby.stop();
    lobby = null;
    setApp({ lobbyRooms: [], lobbyOnline: false });
  }
  syncAnnounce();
}

// ───────────────────────── quem está nas órbitas fixas ─────────────────────────

let peekPeer: Peer | null = null;
let peekRunning = false;
let peekTimer = 0;

/** Na tela inicial, confere de tempos em tempos quem está em cada órbita fixa. */
function watchFixedPeek() {
  syncFixedPeek();
  useApp.subscribe((s, prev) => {
    if (s.phase !== prev.phase || s.fixedRooms !== prev.fixedRooms) syncFixedPeek();
  });
}

function syncFixedPeek() {
  const s = getApp();
  const want = s.phase === 'landing' && s.fixedRooms.length > 0;
  if (want && !peekRunning) {
    peekRunning = true;
    void runFixedPeek();
  } else if (!want && peekRunning) {
    peekRunning = false;
    clearTimeout(peekTimer);
    peekPeer?.destroy();
    peekPeer = null;
  }
}

async function runFixedPeek() {
  if (!peekRunning) return;
  if (!peekPeer || peekPeer.destroyed) {
    try {
      const peer = await openPeer();
      if (!peekRunning) {
        peer.destroy();
        return;
      }
      peekPeer = peer;
    } catch {
      peekTimer = window.setTimeout(() => void runFixedPeek(), 30_000);
      return;
    }
  }
  for (const room of getApp().fixedRooms) {
    const result = await peekRoom(peekPeer, room.code);
    if (!peekRunning) return;
    if (result) setApp((s) => ({ fixedPeek: { ...s.fixedPeek, [room.code]: result } }));
  }
  // com a aba escondida, confere bem menos
  peekTimer = window.setTimeout(() => void runFixedPeek(), activity() === 'hidden' ? 90_000 : 20_000);
}

function startLobby() {
  if (lobbyWatching) return;
  lobbyWatching = true;
  syncLobby();
  useApp.subscribe((s, prev) => {
    if (s.phase !== prev.phase || s.isHost !== prev.isHost) syncLobby();
    else if (s.room !== prev.room || s.profile !== prev.profile) syncAnnounce();
  });
}

/** Host: a minha órbita na lista (sem o código), a menos que eu tenha escondido. */
function syncAnnounce() {
  const s = getApp();
  if (!lobby) return;
  const listed = s.phase === 'room' && s.isHost && !!s.room && s.room.listed !== false;
  lobby.announce(
    listed && s.room
      ? { name: s.room.name, hostName: s.profile.name, hostColor: s.profile.color, members: s.room.members.filter((m) => !m.reconnecting).length, locked: s.room.locked }
      : null,
  );
}

/** Pedir para entrar numa órbita da lista: conversa direto com o host; o código só vem se ele aceitar. */
export async function knockRoom(listingId: string) {
  const s = getApp();
  const room = s.lobbyRooms.find((r) => r.id === listingId);
  if (!lobby || !room || s.knocking || session) return;
  setApp({ knocking: { listingId, roomName: room.name } });
  const result = await lobby.knock(room, s.profile.name, s.profile.color);
  if (getApp().knocking?.listingId !== listingId) return;
  setApp({ knocking: null });
  if (result.accept) {
    if (session || getApp().phase !== 'landing') return;
    toast('Pedido aceito! Entrando na órbita…', 'success');
    void enterRoom('join', result.code);
    return;
  }
  const why = {
    refused: 'O host recusou o pedido.',
    unreachable: 'Não consegui falar com o host dessa órbita. Tente de novo.',
    timeout: 'O host não respondeu. Tente de novo mais tarde.',
    cancelled: '',
  }[result.reason];
  if (why) toast(why, 'error');
}

export function cancelKnock() {
  setApp({ knocking: null });
  lobby?.cancelKnock();
}

function onKnock(knock: Knock) {
  const s = getApp();
  if (!s.isHost || !s.room || s.knocks.length >= 8 || s.knocks.some((k) => k.knockId === knock.knockId)) {
    lobby?.answer(knock.knockId, false);
    return;
  }
  setApp({ knocks: [...s.knocks, { ...knock, at: Date.now() }] });
  sfx.mention();
  // sem resposta em 80 s, recusa (quem pediu desiste em 90 s)
  window.setTimeout(() => {
    if (getApp().knocks.some((k) => k.knockId === knock.knockId)) answerKnock(knock.knockId, false);
  }, 80_000);
}

/** Host: aceitar entrega o código direto para quem pediu; recusar só avisa. */
export function answerKnock(knockId: string, accept: boolean) {
  const s = getApp();
  if (accept && s.room?.locked) {
    toast('A órbita está trancada: destranque para a pessoa conseguir entrar.', 'error');
    return;
  }
  setApp({ knocks: s.knocks.filter((k) => k.knockId !== knockId) });
  lobby?.answer(knockId, accept && s.isHost, accept && s.isHost ? (s.code ?? undefined) : undefined);
}
export const renameRoom = (name: string) => admin({ kind: 'rename', name });

// ───────────────────────── perfil e preferências ─────────────────────────

function applyProfile(profile: Profile) {
  setApp((s) => {
    // a minha foto aparece na hora, sem esperar o hub
    const avatars = { ...s.avatars };
    if (s.meId && profile.avatar) avatars[s.meId] = profile.avatar;
    else if (s.meId) delete avatars[s.meId];
    return { profile, avatars };
  });
  session?.setIdentity({ name: profile.name, color: profile.color, avatar: profile.avatar, planet: profile.planet, orbit: profile.orbit });
}

export function updateProfile(patch: Partial<Omit<Profile, 'id'>>) {
  const profile = { ...getApp().profile, ...patch };
  if (!profile.avatar) delete profile.avatar;
  saveProfile(profile);
  applyProfile(profile);
}

/** Aplica configurações novas (daqui ou de outra janela) e reage ao que mudou. */
function applySettings(settings: Settings) {
  const prev = getApp().settings;
  setApp({ settings });
  setSoundsEnabled(settings.sounds);
  const changed = (key: keyof Settings) => JSON.stringify(settings[key]) !== JSON.stringify(prev[key]);
  if (media && (changed('audioInputId') || changed('echoCancellation') || changed('autoGainControl') || browserNsChanged(prev, settings))) {
    void media.refreshMic();
  } else if (
    media &&
    (changed('noiseFilter') || changed('highpass') || changed('compressor') || changed('noiseGate') || changed('inputGain') || changed('vadThreshold') || changed('vadAuto') || changed('voiceEffect'))
  ) {
    void media.updateVoice().then(() => {
      if (changed('noiseFilter') && media?.voiceFilterFailed) toast('Não consegui carregar essa supressão de ruído.', 'error');
    });
  }
  if (changed('clips')) syncClips();
  if (changed('voiceMode')) {
    setApp({ pttDown: false });
    media?.setMicEnabled(effectiveMic());
  }
  if (media && (changed('videoInputId') || changed('cameraQuality'))) {
    void media.refreshCamera().then((stream) => {
      if (stream) setApp({ localCamera: stream });
    });
  }
}

/** A supressão do navegador é aplicada na captura: ligar/desligar exige reabrir o microfone. */
const browserNsChanged = (a: Settings, b: Settings) => (a.noiseFilter === 'browser') !== (b.noiseFilter === 'browser');

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...getApp().settings, ...patch };
  saveSettings(settings);
  applySettings(settings);
}

export function setVolume(memberId: string, value: number) {
  const volumes = { ...getApp().volumes, [baseId(memberId)]: clampVolume(value) };
  saveVolumes(volumes);
  setApp({ volumes });
}

export function toggleLocalMute(memberId: string) {
  setApp((s) => ({ localMutes: { ...s.localMutes, [memberId]: !s.localMutes[memberId] } }));
}

// ───────────────────────── atalhos ─────────────────────────

/** Enquanto a tela de atalhos está gravando uma tecla, os atalhos ficam pausados. */
let shortcutsPaused = false;
export const pauseShortcuts = (paused: boolean) => {
  shortcutsPaused = paused;
};

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

function runAction(action: KeyAction) {
  const s = getApp();
  switch (action) {
    case 'toggleMic':
      if (s.inCall) toggleMic();
      return;
    case 'toggleDeafen':
      if (s.inCall) toggleDeafen();
      return;
    case 'toggleCamera':
      if (s.inCall) void toggleCamera();
      return;
    case 'toggleLive':
      if (s.inCall) setApp({ modal: s.modal?.kind === 'live' ? null : { kind: 'live' } });
      return;
    case 'toggleChat':
      toggleChat();
      return;
    case 'saveClip':
      if (s.inCall) void saveClip();
      return;
    default:
      return;
  }
}

const TOGGLES: KeyAction[] = ['toggleMic', 'toggleDeafen', 'toggleCamera', 'toggleLive', 'toggleChat', 'saveClip'];

function onKeyDown(e: KeyboardEvent) {
  if (!session || shortcutsPaused) return;
  const s = getApp();
  const binds = s.settings.keybinds;
  const editable = isEditable(e.target);
  const ptt = binds.pushToTalk;
  if (ptt && !isMouseCombo(ptt) && s.settings.voiceMode === 'ptt' && sameMainKey(ptt, e.code) && (!editable || hasModifier(ptt))) {
    if (s.pttDown || matchesKeyboard(ptt, e)) {
      e.preventDefault();
      setPushToTalk(true);
      return;
    }
  }
  if (e.repeat) return;
  for (const action of TOGGLES) {
    const combo = binds[action];
    if (!combo || isMouseCombo(combo) || !matchesKeyboard(combo, e)) continue;
    if (editable && !hasModifier(combo)) continue;
    e.preventDefault();
    runAction(action);
    return;
  }
}

function onKeyUp(e: KeyboardEvent) {
  const ptt = getApp().settings.keybinds.pushToTalk;
  if (ptt && getApp().pttDown && !isMouseCombo(ptt) && sameMainKey(ptt, e.code)) setPushToTalk(false);
}

function onMouseDown(e: MouseEvent) {
  if (!session || shortcutsPaused) return;
  const combo = comboFromMouse(e);
  if (!combo) return;
  const s = getApp();
  const binds = s.settings.keybinds;
  if (binds.pushToTalk && s.settings.voiceMode === 'ptt' && isMouseCombo(binds.pushToTalk) && mainKey(binds.pushToTalk) === mainKey(combo)) {
    e.preventDefault();
    setPushToTalk(true);
    return;
  }
  for (const action of TOGGLES) {
    if (binds[action] === combo) {
      e.preventDefault();
      runAction(action);
      return;
    }
  }
}

function onMouseUp(e: MouseEvent) {
  const combo = comboFromMouse(e);
  if (!combo) return;
  const binds = getApp().settings.keybinds;
  const bound = Object.values(binds).some((c) => c && isMouseCombo(c) && mainKey(c) === mainKey(combo));
  // os botões laterais voltam/avançam a página: se estão em uso como atalho, não deixa
  if (bound) e.preventDefault();
  if (binds.pushToTalk && isMouseCombo(binds.pushToTalk) && mainKey(binds.pushToTalk) === mainKey(combo)) setPushToTalk(false);
}

// ───────────────────────── extensão de atalhos ─────────────────────────

/** Atalho vindo da extensão (funciona com o navegador em segundo plano). Devolve se cuidou dele. */
function runExtensionAction(action: string): boolean {
  const s = getApp();
  if (!s.inCall) return false;
  switch (action) {
    case 'microfone':
      toggleMic();
      return true;
    case 'ensurdecer':
      toggleDeafen();
      return true;
    case 'clipe':
      void saveClip();
      return true;
    default:
      return false;
  }
}

function onExtensionMessage(e: MessageEvent) {
  if (e.source !== window || e.origin !== location.origin) return;
  const data = e.data as { source?: unknown; action?: unknown; id?: unknown; version?: unknown } | null;
  if (!data || data.source !== 'orbita-extension' || typeof data.action !== 'string') return;
  if (data.action === 'hello') {
    setApp({ extension: typeof data.version === 'string' ? data.version.slice(0, 20) : '1' });
    return;
  }
  const handled = runExtensionAction(data.action);
  window.postMessage({ source: 'orbita-app', id: data.id, handled }, location.origin);
}

// ───────────────────────── app instalado ─────────────────────────

async function handOff(code: string) {
  setApp({ phase: 'handoff', handoff: { code, status: 'opening' } });
  const opened = await openInApp(code);
  if (getApp().phase !== 'handoff') return;
  if (opened) {
    markInstalled();
    setApp({ handoff: { code, status: 'opened' } });
  } else {
    // o app provavelmente foi desinstalado: só tenta de novo quando ele rodar outra vez
    forgetInstalled();
    setApp({ handoff: { code, status: 'failed' } });
  }
}

/** Botão "Abrir no app" da tela de entrega (com clique, o navegador sempre deixa). */
export const retryHandOff = () => {
  const code = getApp().handoff?.code;
  if (code) void handOff(code);
};

export function continueInBrowser() {
  const code = getApp().handoff?.code;
  if (code) stayInBrowser(code);
  setApp({ phase: 'landing', handoff: null, inviteCode: code ?? getApp().inviteCode });
}

/** Chegou um convite com o app já aberto. */
function receiveInvite(code: string | null) {
  if (!code) return;
  const s = getApp();
  if (session) {
    if (s.code === code) {
      toast('Você já está nessa órbita.');
      return;
    }
    if (s.isHost && (s.room?.members.length ?? 0) > 1) {
      toast('Passe a coroa para alguém antes de ir para outra órbita.', 'info', 5_000);
      setApp({ modal: { kind: 'leave' } });
      return;
    }
    setApp({
      modal: {
        kind: 'confirm',
        title: 'Ir para outra órbita?',
        body: `Você vai sair de “${s.room?.name ?? ''}” e entrar na órbita ${code}.`,
        confirm: 'Trocar de órbita',
        action: () => {
          pendingJoin = code;
          if (getApp().isHost) session?.endForAll();
          else session?.leave();
        },
      },
    });
    return;
  }
  setApp({ inviteCode: code, phase: s.phase === 'connecting' ? s.phase : 'landing', ended: null, handoff: null });
  history.replaceState(null, '', `#/sala/${code}`);
}

// ───────────────────────── inicialização ─────────────────────────

function syncFromOtherWindow(e: StorageEvent) {
  if (e.storageArea !== localStorage) return;
  if (e.key === SYNCED_KEYS.profile) {
    const profile = loadProfile();
    const current = getApp().profile;
    if (profile.name !== current.name || profile.color !== current.color || profile.avatar !== current.avatar || JSON.stringify(profile.planet) !== JSON.stringify(current.planet) || JSON.stringify(profile.orbit) !== JSON.stringify(current.orbit)) applyProfile(profile);
  } else if (e.key === SYNCED_KEYS.settings) {
    applySettings(loadSettings());
  }
}

export function initController() {
  if (initialized) return;
  initialized = true;
  setSoundsEnabled(getApp().settings.sounds);
  void loadKeyboardLayout();
  trackInstallation();
  watchForUpdates(() => {
    // fora de uma sala, recarrega na hora; dentro, só avisa (recarregar derruba a chamada)
    if (!session && getApp().phase !== 'connecting') location.reload();
    else setApp({ updateReady: true });
  });

  const fromApp = cleanProtocolParam();
  const code = fromApp ?? inviteFromHash();
  if (code) setApp({ inviteCode: code });
  onAppLaunch((url) => receiveInvite(codeFromUrl(url)));
  if (code && !fromApp && canHandOff() && appLikelyInstalled() && !wantsBrowser(code)) void handOff(code);

  window.addEventListener('hashchange', () => {
    if (!session && getApp().phase !== 'handoff') setApp({ inviteCode: inviteFromHash() });
  });
  window.addEventListener('storage', syncFromOtherWindow);
  window.addEventListener('pagehide', () => {
    persistFixed(true);
    session?.destroyNow();
    lobby?.stop();
  });
  startLobby();
  watchFixed();
  watchFixedPeek();
  window.addEventListener('message', onExtensionMessage);
  // a extensão responde se estiver instalada
  window.postMessage({ source: 'orbita-app', action: 'ping' }, location.origin);
  // fechar a aba sendo host não pergunta nada: a coroa passa para o próximo e a sala continua
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && chatVisible() && getApp().unread) setChatOpen(true);
  });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', () => setPushToTalk(false));
  // o navegador só libera áudio depois de um gesto: retoma os filtros de voz no primeiro clique/tecla
  const resume = () => {
    media?.resumeAudio();
    resumePlayback();
  };
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__orbita = { getApp, setApp, session: () => session };
  }
}
