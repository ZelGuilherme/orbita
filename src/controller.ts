import { APP_NAME, MAX_MESSAGES_PER_CHANNEL } from './lib/config';
import { allowFx, emitFx, type FxLimits } from './lib/fx';
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
import { MediaEngine, type LiveOptions, type LiveSurface, type MediaEvents } from './lib/media';
import { PeerOpenError } from './lib/peer';
import type { AdminAction, Attachment, ChatMessage, LiveFx, LiveInfo, Member, Presence, RoomState } from './lib/protocol';
import { JoinError, Session, type EndReason, type SessionHandlers } from './lib/session';
import { setSoundsEnabled, sfx } from './lib/sounds';
import {
  loadProfile,
  loadSettings,
  saveLiveVolumes,
  saveProfile,
  saveSettings,
  saveUiPrefs,
  saveVolumes,
  SYNCED_KEYS,
  type Profile,
  type Settings,
} from './lib/storage';
import { copyText, errorMessage, inviteFromHash, inviteLink, parseRoomCode, randomId } from './lib/util';
import { getApp, resetRoomState, setApp, textChannelOf, toast, voiceChannelOf, type AppState } from './store';

/**
 * Cola entre a sessão P2P, a mídia e a interface. Os componentes só chamam estas
 * funções e leem o estado do store.
 */

let session: Session | null = null;
let media: MediaEngine | null = null;
let typingSentAt = 0;
let viewersTimer = 0;
let initialized = false;
let pendingJoin: string | null = null;
const liveRetries = new Map<string, number>();
const watchTimers = new Map<string, number>();
const fxLimits: FxLimits = { laser: [], fx: [], nudge: 0 };

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
  media?.destroy();
  media = null;
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
    setApp({ phase: 'room', code: created.code, meId: created.meId, inviteCode: null, unread: 0, mentions: 0 });
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

export function setChatOpen(chatOpen: boolean) {
  setApp((s) => ({ chatOpen, unread: chatOpen ? 0 : s.unread, mentions: chatOpen ? 0 : s.mentions }));
  saveUiPrefs({ chatOpen });
  syncTitle();
}

export const toggleChat = () => setChatOpen(!getApp().chatOpen);

export function sendMessage(text: string, attachment?: Attachment) {
  const channelId = textChannelOf(getApp().room)?.id;
  if (!channelId) return;
  session?.send({ t: 'chat', channelId, text, attachment });
  typingSentAt = 0;
}

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
  setApp({ joiningVoice: true });
  const engine = media;
  const micAvailable = await engine.joinVoice(channelId, effectiveMic());
  if (!session || media !== engine) return;
  const micOn = micAvailable ? getApp().micOn : false;
  if (!micAvailable) toast('Microfone indisponível ou bloqueado — você entrou só para ouvir.', 'error', 5_000);
  else if (engine.voiceFilterFailed) toast('Não consegui carregar a supressão de ruído escolhida. A voz está saindo sem ela.', 'error', 6_000);
  setApp({ inCall: true, micOn, joiningVoice: false, peopleOpen: false });
  engine.setMicEnabled(effectiveMic());
  sendPresence({ voiceChannelId: channelId, micOn, deafened: getApp().deafened, cameraOn: false, live: null });
  sfx.join();
  if (getApp().settings.voiceMode === 'ptt' && !getApp().settings.keybinds.pushToTalk) {
    toast('Seu modo de voz é “Pressionar para falar”, mas falta escolher a tecla em Configurações › Atalhos.', 'info', 7_000);
  }
}

export function leaveCall(silent = false) {
  if (!getApp().inCall) return;
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
    setApp({ live, localScreen: capture.stream, liveSurface: capture.surface, modal: null, callLayout: 'auto' });
    sendPresence({ live });
    sfx.live();
    if (opts.audio && !capture.hasAudio) toast(audioHint(capture.surface), 'info', 8_000);
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

/** Abre a live de alguém em destaque (e começa a assistir). */
export function openLive(streamerId: string) {
  const s = getApp();
  const member = s.room?.members.find((m) => m.id === streamerId);
  if (!member?.live) return;
  if (streamerId !== s.meId) watchLive(streamerId);
  setApp({ callLayout: 'grid', focus: `live:${streamerId}`, memberCard: null, peopleOpen: false });
}

export function setLiveVolume(memberId: string, value: number) {
  const liveVolumes = { ...getApp().liveVolumes, [baseId(memberId)]: value };
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

// ───────────────────────── efeitos ao vivo ─────────────────────────

function onRemoteFx(from: string, streamerId: string, fx: LiveFx) {
  const s = getApp();
  const mine = streamerId === s.meId;
  if (!mine && !s.watching[streamerId]) return;
  emitFx({ streamerId, from, fx });
  if (fx.kind === 'nudge') {
    sfx.nudge();
    if (mine) {
      const who = s.room?.members.find((m) => m.id === from)?.name ?? 'Alguém';
      toast(`📳 ${who} chamou sua atenção!`);
      shake();
    }
  } else if (fx.kind === 'wink') {
    sfx.fx();
  }
}

/** Sacode a janela, como o "chamar atenção" do MSN. */
function shake() {
  const root = document.getElementById('root');
  if (!root) return;
  root.classList.remove('is-nudged');
  void root.offsetWidth;
  root.classList.add('is-nudged');
  window.setTimeout(() => root.classList.remove('is-nudged'), 700);
}

/** Manda um efeito para a live de alguém (e mostra na hora para quem mandou). */
export function sendFx(streamerId: string, fx: LiveFx) {
  const s = getApp();
  if (!session || !s.meId) return;
  const streamer = s.room?.members.find((m) => m.id === streamerId);
  if (!streamer?.live?.effects) return;
  if (!allowFx(fxLimits, fx, Date.now())) {
    if (fx.kind === 'nudge') toast('Espere uns segundos para chamar a atenção de novo.');
    else if (fx.kind !== 'laser') toast('Calma! Muitos efeitos de uma vez.');
    return;
  }
  session.send({ t: 'fx', streamerId, fx });
  emitFx({ streamerId, from: s.meId, fx });
  if (fx.kind === 'nudge' || fx.kind === 'wink') sfx.fx();
}

let laserSentAt = 0;
let laserTimer = 0;
let laserPending: { streamerId: string; x: number; y: number } | null = null;

/** Laser: a posição local aparece na hora; para a rede, no máximo ~22 por segundo. */
export function moveLaser(streamerId: string, x: number, y: number) {
  const s = getApp();
  if (!session || !s.meId) return;
  emitFx({ streamerId, from: s.meId, fx: { kind: 'laser', x, y } });
  laserPending = { streamerId, x, y };
  const flush = () => {
    laserTimer = 0;
    if (!laserPending) return;
    laserSentAt = Date.now();
    session?.send({ t: 'fx', streamerId: laserPending.streamerId, fx: { kind: 'laser', x: laserPending.x, y: laserPending.y } });
    laserPending = null;
  };
  const wait = 45 - (Date.now() - laserSentAt);
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
  session?.send({ t: 'fx', streamerId, fx: { kind: 'laser-off' } });
}

export const toggleLaser = () => setApp((s) => ({ laser: !s.laser }));

// ───────────────────────── host ─────────────────────────

const admin = (action: AdminAction) => session?.send({ t: 'admin', action });
export const kick = (memberId: string, ban = false) => admin({ kind: 'kick', memberId, ban });
export const serverMute = (memberId: string, muted: boolean) => admin({ kind: 'mute', memberId, muted });
export const transferHost = (memberId: string) => admin({ kind: 'transfer', memberId });
export const setLocked = (locked: boolean) => admin({ kind: 'lock', locked });
export const renameRoom = (name: string) => admin({ kind: 'rename', name });

// ───────────────────────── perfil e preferências ─────────────────────────

function applyProfile(profile: Profile) {
  setApp({ profile });
  session?.setIdentity({ name: profile.name, color: profile.color });
}

export function updateProfile(patch: Partial<Omit<Profile, 'id'>>) {
  const profile = { ...getApp().profile, ...patch };
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
    (changed('noiseFilter') || changed('highpass') || changed('compressor') || changed('noiseGate') || changed('inputGain') || changed('vadThreshold'))
  ) {
    void media.updateVoice().then(() => {
      if (changed('noiseFilter') && media?.voiceFilterFailed) toast('Não consegui carregar essa supressão de ruído.', 'error');
    });
  }
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
  const volumes = { ...getApp().volumes, [baseId(memberId)]: value };
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
    default:
      return;
  }
}

const TOGGLES: KeyAction[] = ['toggleMic', 'toggleDeafen', 'toggleCamera', 'toggleLive', 'toggleChat'];

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
    if (profile.name !== current.name || profile.color !== current.color) applyProfile(profile);
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

  const fromApp = cleanProtocolParam();
  const code = fromApp ?? inviteFromHash();
  if (code) setApp({ inviteCode: code });
  onAppLaunch((url) => receiveInvite(codeFromUrl(url)));
  if (code && !fromApp && canHandOff() && appLikelyInstalled() && !wantsBrowser(code)) void handOff(code);

  window.addEventListener('hashchange', () => {
    if (!session && getApp().phase !== 'handoff') setApp({ inviteCode: inviteFromHash() });
  });
  window.addEventListener('storage', syncFromOtherWindow);
  window.addEventListener('pagehide', () => session?.destroyNow());
  window.addEventListener('beforeunload', (e) => {
    const s = getApp();
    if (session && s.isHost && (s.room?.members.length ?? 0) > 1) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && chatVisible() && getApp().unread) setChatOpen(true);
  });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', () => setPushToTalk(false));
  // o navegador só libera áudio depois de um gesto: retoma os filtros de voz no primeiro clique/tecla
  const resume = () => media?.resumeAudio();
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__orbita = { getApp, session: () => session };
  }
}
