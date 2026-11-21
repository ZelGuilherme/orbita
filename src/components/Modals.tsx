import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AppWindow,
  AudioLines,
  Copy,
  Crown,
  Download,
  ExternalLink,
  Info,
  Keyboard,
  Lightbulb,
  Lock,
  Mic,
  Monitor,
  MonitorUp,
  Radio,
  RefreshCw,
  Share2,
  Square,
  SquareArrowOutUpRight,
  User,
  UserPlus,
  Wifi,
  X,
  Puzzle,
  Orbit,
} from 'lucide-react';
import {
  copyInvite,
  endRoom,
  pauseShortcuts,
  renameRoom,
  setLocked,
  shareInvite,
  startLive,
  stopLive,
  switchLiveSource,
  transferAndLeave,
  updateLiveOptions,
  updateProfile,
  updateSettings,
} from '../controller';
import { APP_VERSION, REPO_URL } from '../lib/config';
import {
  comboFromKeyboard,
  comboFromMouse,
  comboParts,
  DEFAULT_KEYBINDS,
  hasModifier,
  isMouseCombo,
  KEY_ACTIONS,
  mainKey,
  reservedCombo,
  type KeyAction,
} from '../lib/keybinds';
import { availableCodecs } from '../lib/liveQuality';
import { LIVE_PRESETS, type LiveSurface } from '../lib/media';
import { parseIceServers } from '../lib/peer';
import type { LiveQuality } from '../lib/protocol';
import { DEFAULT_NETWORK, type NoiseFilter } from '../lib/storage';
import { errorMessage, inviteLink, sanitizeName } from '../lib/util';
import { VoiceProcessor, voiceOptions } from '../lib/voice';
import { getApp, setApp, toast, useApp, type Modal as ModalState, type SettingsTab } from '../store';
import { canFloat, openFloating } from './Floating';
import { OrbitLogo } from './OrbitLogo';
import { Planet } from './Planet';
import { PlanetStudio } from './PlanetStudio';
import { VoiceEffectPicker } from './SoundPanel';
import { cx, IconButton, Modal, Switch } from './ui';

export function Modals() {
  const modal = useApp((s) => s.modal);
  const close = useCallback(() => setApp({ modal: null }), []);
  if (!modal) return null;
  switch (modal.kind) {
    case 'invite':
      return <InviteModal onClose={close} />;
    case 'settings':
      return <SettingsModal initial={modal.tab} onClose={close} />;
    case 'live':
      return <LiveModal onClose={close} />;
    case 'leave':
      return <LeaveModal onClose={close} />;
    case 'room':
      return <RoomModal onClose={close} />;
    case 'image':
      return <ImageModal src={modal.src} name={modal.name} onClose={close} />;
    case 'confirm':
      return <ConfirmModal modal={modal} onClose={close} />;
    default:
      return null;
  }
}

// ───────────────────────── convite ─────────────────────────

function InviteModal({ onClose }: { onClose: () => void }) {
  const code = useApp((s) => s.code);
  const roomName = useApp((s) => s.room?.name ?? '');
  const locked = useApp((s) => !!s.room?.locked);
  if (!code) return null;
  const link = inviteLink(code);
  const canShare = typeof navigator.share === 'function';
  return (
    <Modal
      title={
        <>
          <UserPlus size={20} /> Convidar para {roomName}
        </>
      }
      onClose={onClose}
    >
      <div className="invite-modal">
        <OrbitLogo size={112} animated />
        <p>Mande este link para os amigos. Eles entram direto na sua órbita — a conexão é P2P, sem servidor no meio.</p>
      </div>
      <div className="copy-field">
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Link do convite" />
        <button type="button" className="btn btn--primary" onClick={() => void copyInvite()}>
          <Copy size={16} /> Copiar
        </button>
      </div>
      <div className="invite-meta">
        <span>
          Código da sala: <code className="code-pill">{code}</code>
        </span>
        {canShare && (
          <button type="button" className="link-btn" onClick={() => void shareInvite()}>
            <Share2 size={14} /> Compartilhar…
          </button>
        )}
      </div>
      {locked && (
        <p className="notice notice--warn">
          <Lock size={16} /> A órbita está trancada: ninguém novo consegue entrar.
        </p>
      )}
      <p className="muted small">
        O convite funciona enquanto houver alguém na sala. Se o host sair, outro membro assume sozinho e o link continua valendo.
      </p>
    </Modal>
  );
}

// ───────────────────────── configurações ─────────────────────────

const TABS: Array<[SettingsTab, string, ReactNode]> = [
  ['perfil', 'Perfil', <User size={17} key="u" />],
  ['planeta', 'Planeta', <Orbit size={17} key="p" />],
  ['voz', 'Voz e vídeo', <Mic size={17} key="m" />],
  ['live', 'Lives', <Radio size={17} key="r" />],
  ['atalhos', 'Atalhos', <Keyboard size={17} key="k" />],
  ['rede', 'Rede', <Wifi size={17} key="w" />],
  ['sobre', 'Sobre', <Info size={17} key="i" />],
];

function SettingsModal({ initial, onClose }: { initial?: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initial ?? 'perfil');
  return (
    <Modal onClose={onClose} wide bodyClass="modal__body--flush">
      <div className="settings">
        <nav className="settings__nav" aria-label="Seções">
          <span className="settings__brand">
            <OrbitLogo size={28} /> Configurações
          </span>
          {TABS.map(([key, label, icon]) => (
            <button key={key} type="button" className={cx(tab === key && 'is-on')} aria-current={tab === key} onClick={() => setTab(key)}>
              {icon}
              {label}
            </button>
          ))}
        </nav>
        <div className="settings__content">
          <button type="button" className="modal__close settings__close" onClick={onClose} aria-label="Fechar">
            <X size={20} />
          </button>
          {tab === 'perfil' && <ProfileTab goTo={setTab} />}
          {tab === 'planeta' && <PlanetTab />}
          {tab === 'voz' && <VoiceTab goTo={setTab} />}
          {tab === 'live' && <LiveTab />}
          {tab === 'atalhos' && <KeybindsTab />}
          {tab === 'rede' && <NetworkTab />}
          {tab === 'sobre' && <AboutTab />}
        </div>
      </div>
    </Modal>
  );
}

function ProfileTab({ goTo }: { goTo: (tab: SettingsTab) => void }) {
  const profile = useApp((s) => s.profile);
  const isHost = useApp((s) => s.isHost);
  const [name, setName] = useState(profile.name);
  // o nome pode mudar em outra janela (o app instalado e o navegador dividem o perfil)
  useEffect(() => setName(profile.name), [profile.name]);
  const commit = () => {
    const clean = sanitizeName(name);
    setName(clean);
    if (clean !== profile.name) updateProfile({ name: clean });
  };
  return (
    <>
      <h3 className="settings__title">Perfil</h3>
      <div className="profile-preview">
        <div className="avatar-edit">
          <Planet name={name || '?'} color={profile.color} avatar={profile.avatar} planet={profile.planet} size={92} host={isHost} />
        </div>
        <label className="field">
          <span>Seu nome</span>
          <input
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>
      </div>
      <div className="planet-card">
        <Planet name={profile.name} color={profile.color} avatar={profile.avatar} planet={profile.planet} size={46} />
        <span className="planet-card__text">
          <b>Seu planeta</b>
          <small>Cor, textura e as cores dela, anéis, luas, brilho e enfeites.</small>
        </span>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => goTo('planeta')}>
          <Orbit size={15} /> Editar planeta
        </button>
      </div>
      <p className="muted small">
        Seu perfil fica salvo neste navegador (e no app do Órbita instalado por ele). Mudou aqui, muda lá também. Não existe conta nem servidor
        guardando nada.
      </p>
    </>
  );
}

/** Textura, anéis, luas e brilho do planeta (a prévia lá em cima mostra na hora). */
function PlanetTab() {
  return (
    <>
      <h3 className="settings__title">Seu planeta</h3>
      <PlanetStudio />
    </>
  );
}

function DeviceSelect({
  label,
  value,
  devices,
  onChange,
}: {
  label: string;
  value: string;
  devices: MediaDeviceInfo[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Padrão do sistema</option>
        {devices
          .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
      </select>
    </label>
  );
}

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
      setNeedsPermission(list.some((d) => !d.label));
    } catch {
      setDevices([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener('devicechange', refresh);
    return () => md?.removeEventListener('devicechange', refresh);
  }, [refresh]);
  const grant = async () => {
    for (const constraints of [{ audio: true, video: true }, { audio: true }]) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getTracks().forEach((t) => t.stop());
        break;
      } catch {
        /* tenta só o áudio */
      }
    }
    void refresh();
  };
  return { devices, needsPermission, grant };
}

function VoiceTab({ goTo }: { goTo: (tab: SettingsTab) => void }) {
  const settings = useApp((s) => s.settings);
  const { devices, needsPermission, grant } = useDevices();
  const canPickOutput = 'setSinkId' in HTMLMediaElement.prototype;
  const ptt = settings.keybinds.pushToTalk;
  return (
    <>
      <h3 className="settings__title">Voz e vídeo</h3>
      {needsPermission && (
        <div className="notice">
          <Info size={16} />
          <span>Permita o acesso ao microfone e à câmera para ver o nome dos dispositivos.</span>
          <button type="button" className="btn btn--sm" onClick={() => void grant()}>
            Permitir
          </button>
        </div>
      )}
      <div className="grid-2">
        <DeviceSelect
          label="Microfone"
          value={settings.audioInputId}
          devices={devices.filter((d) => d.kind === 'audioinput')}
          onChange={(audioInputId) => updateSettings({ audioInputId })}
        />
        {canPickOutput && (
          <DeviceSelect
            label="Saída de áudio"
            value={settings.audioOutputId}
            devices={devices.filter((d) => d.kind === 'audiooutput')}
            onChange={(audioOutputId) => updateSettings({ audioOutputId })}
          />
        )}
      </div>

      <div className="field">
        <span>Modo de voz</span>
        <div className="choice-grid choice-grid--2">
          <button type="button" className={cx('choice', settings.voiceMode === 'vad' && 'is-on')} onClick={() => updateSettings({ voiceMode: 'vad' })}>
            <AudioLines size={20} />
            <span>
              <b>Detecção de voz</b>
              <small>Transmite quando você fala</small>
            </span>
          </button>
          <button type="button" className={cx('choice', settings.voiceMode === 'ptt' && 'is-on')} onClick={() => updateSettings({ voiceMode: 'ptt' })}>
            <Keyboard size={20} />
            <span>
              <b>Pressionar para falar</b>
              <small>Só enquanto segura a tecla</small>
            </span>
          </button>
        </div>
      </div>
      {settings.voiceMode === 'vad' ? (
        <div className="field">
          <span>Sensibilidade da voz</span>
          <Switch
            label="Ajustar automaticamente"
            hint="O Órbita mede o ruído do seu ambiente e decide sozinho a partir de quando é voz."
            checked={settings.vadAuto}
            onChange={(vadAuto) => updateSettings({ vadAuto })}
          />
          <MicMeter threshold monitor />
          <span className="hint">
            {settings.vadAuto
              ? 'O marcador branco mostra o limiar automático: acima dele você aparece falando (o anel verde) e, com o portão de ruído, abaixo dele nada é transmitido.'
              : 'Arraste o marcador branco: acima dele você aparece falando (o anel verde). Com o portão de ruído ligado, abaixo dele nada é transmitido.'}
          </span>
        </div>
      ) : (
        <div className="field">
          <span>Tecla de falar</span>
          <div className="ptt-row">
            {ptt ? <Keys combo={ptt} /> : <span className="muted">Nenhuma tecla escolhida</span>}
            <button type="button" className="btn btn--sm" onClick={() => goTo('atalhos')}>
              <Keyboard size={14} /> {ptt ? 'Trocar' : 'Escolher tecla'}
            </button>
          </div>
          <span className="hint">Funciona com a janela do Órbita em foco (o navegador não deixa sites ouvirem o teclado em segundo plano).</span>
        </div>
      )}

      <VoiceFilters testMeter={settings.voiceMode !== 'vad'} />

      <h4 className="settings__subtitle">Efeitos de voz</h4>
      <div className="field">
        <span>Efeito na sua voz</span>
        <VoiceEffectPicker />
        <span className="hint">Só muda o que sai para a chamada. Para ouvir como fica, use “Testar microfone” e marque “Ouvir” (com fones).</span>
      </div>

      <h4 className="settings__subtitle">Gravação e clipes</h4>
      <Switch
        label="Clipes do último minuto"
        hint="Guarda sempre o último minuto da chamada (com a live em destaque, se houver) para salvar com o botão ✂️ ou um atalho. Usa um pouco mais do computador; fica tudo só no seu navegador."
        checked={settings.clips}
        onChange={(clips) => updateSettings({ clips })}
      />
      <p className="hint">O botão ⏺ da barra da chamada grava a chamada inteira até você parar. Todo mundo vê um aviso vermelho enquanto alguém grava.</p>

      <h4 className="settings__subtitle">Câmera e outros</h4>
      <div className="grid-2">
        <DeviceSelect
          label="Câmera"
          value={settings.videoInputId}
          devices={devices.filter((d) => d.kind === 'videoinput')}
          onChange={(videoInputId) => updateSettings({ videoInputId })}
        />
        <label className="field">
          <span>Qualidade da câmera</span>
          <select value={settings.cameraQuality} onChange={(e) => updateSettings({ cameraQuality: e.target.value as 'sd' | 'hd' })}>
            <option value="sd">360p — leve</option>
            <option value="hd">720p — HD</option>
          </select>
        </label>
      </div>
      <Switch
        label="Entrar na chamada com o microfone desligado"
        hint="Você liga quando quiser falar."
        checked={settings.joinMuted}
        onChange={(joinMuted) => updateSettings({ joinMuted })}
      />
      <Switch
        label="Sons da interface"
        hint="Entrar e sair da chamada, mensagens, menções e lives."
        checked={settings.sounds}
        onChange={(sounds) => updateSettings({ sounds })}
      />
    </>
  );
}

const NOISE_OPTIONS: Array<{ id: NoiseFilter; title: string; hint: string }> = [
  { id: 'off', title: 'Desligada', hint: 'Som cru do microfone' },
  { id: 'browser', title: 'Padrão', hint: 'A do navegador, leve' },
  { id: 'rnnoise', title: 'IA (RNNoise)', hint: 'Recomendado: corta teclado, ventilador e rua' },
  { id: 'gtcrn', title: 'IA forte (GTCRN)', hint: 'Mais limpa, usa mais processador' },
];

/** Filtros do microfone (dentro de "Voz e vídeo"). */
function VoiceFilters({ testMeter }: { testMeter: boolean }) {
  const settings = useApp((s) => s.settings);
  return (
    <>
      <h4 className="settings__subtitle">Filtros de som</h4>
      <p className="muted">Rodam no seu computador antes da voz sair. Teste e ouça o resultado no medidor.</p>
      <div className="field">
        <span>Supressão de ruído</span>
        <div className="choice-grid choice-grid--4">
          {NOISE_OPTIONS.map((o) => (
            <button key={o.id} type="button" className={cx('choice choice--stack', settings.noiseFilter === o.id && 'is-on')} onClick={() => updateSettings({ noiseFilter: o.id })}>
              <b>{o.title}</b>
              <small>{o.hint}</small>
            </button>
          ))}
        </div>
      </div>
      <Switch
        label="Portão de ruído"
        hint="Fecha o microfone entre as falas: só transmite acima da sensibilidade."
        checked={settings.noiseGate}
        onChange={(noiseGate) => updateSettings({ noiseGate })}
      />
      <Switch
        label="Cortar graves"
        hint="Tira ronco, vento, ar-condicionado e batidas na mesa."
        checked={settings.highpass}
        onChange={(highpass) => updateSettings({ highpass })}
      />
      <Switch
        label="Compressor de voz"
        hint="Deixa o volume da sua voz mais uniforme (sussurro e grito ficam parecidos)."
        checked={settings.compressor}
        onChange={(compressor) => updateSettings({ compressor })}
      />
      <Switch
        label="Cancelamento de eco"
        hint="Evita que o som das caixas volte pelo microfone."
        checked={settings.echoCancellation}
        onChange={(echoCancellation) => updateSettings({ echoCancellation })}
      />
      <Switch
        label="Ganho automático"
        hint="O navegador ajusta o volume da sua voz sozinho."
        checked={settings.autoGainControl}
        onChange={(autoGainControl) => updateSettings({ autoGainControl })}
      />
      <label className="field">
        <span>Volume do microfone — {settings.inputGain}%</span>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={settings.inputGain}
          style={{ '--fill': `${settings.inputGain / 2}%` } as CSSProperties}
          onChange={(e) => updateSettings({ inputGain: Number(e.target.value) })}
        />
      </label>
      {testMeter && (
        <div className="field">
          <span>Testar</span>
          <MicMeter monitor />
        </div>
      )}
    </>
  );
}

/** Medidor do microfone com os filtros aplicados (e, opcionalmente, ouvindo o resultado). */
function MicMeter({ threshold, monitor }: { threshold?: boolean; monitor?: boolean }) {
  const settings = useApp((s) => s.settings);
  const [on, setOn] = useState(false);
  const [listen, setListen] = useState(false);
  const [level, setLevel] = useState(0);
  const [liveThreshold, setLiveThreshold] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const proc = useRef<VoiceProcessor | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const { audioInputId, echoCancellation, autoGainControl, audioOutputId } = settings;
  const browserNs = settings.noiseFilter === 'browser';

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let p: VoiceProcessor | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: audioInputId ? { ideal: audioInputId } : undefined,
            echoCancellation,
            noiseSuppression: browserNs,
            autoGainControl,
            channelCount: 1,
          },
        });
        if (cancelled) return;
        p = await VoiceProcessor.create(stream.getAudioTracks()[0], voiceOptions(getApp().settings));
        if (cancelled) return;
        p.onLevel = (l, t) => {
          setLevel(l);
          setLiveThreshold(t);
        };
        p.onSpeaking = setOpen;
        proc.current = p;
        setTrack(p.track);
        if (p.suppressorFailed) toast('Não consegui carregar essa supressão de ruído.', 'error');
      } catch (err) {
        if (!cancelled) {
          toast(`Não consegui abrir o microfone: ${errorMessage(err)}.`, 'error');
          setOn(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      proc.current = null;
      p?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      setTrack(null);
      setLevel(0);
      setLiveThreshold(null);
      setOpen(false);
    };
  }, [on, audioInputId, echoCancellation, autoGainControl, browserNs]);

  const { noiseFilter, highpass, compressor, noiseGate, inputGain, vadThreshold, vadAuto, voiceEffect } = settings;
  useEffect(() => {
    void proc.current?.update(voiceOptions(getApp().settings));
  }, [noiseFilter, highpass, compressor, noiseGate, inputGain, vadThreshold, vadAuto, voiceEffect]);
  // no automático, o marcador acompanha o limiar calculado (sem teste ligado, fica no valor de partida)
  const shownThreshold = vadAuto ? (liveThreshold ?? 0.22) : vadThreshold;

  useEffect(() => {
    const el = audio.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el) return;
    if (listen && track) {
      el.srcObject = new MediaStream([track]);
      if (el.setSinkId) void el.setSinkId(audioOutputId).catch(() => {});
      void el.play().catch(() => {});
    } else {
      el.srcObject = null;
    }
  }, [listen, track, audioOutputId]);

  return (
    <div className="mic-test">
      <div className="meter">
        <div className={cx('meter__fill', open && 'is-hot')} style={{ width: `${Math.round(level * 100)}%` }} />
        {threshold && (
          <input
            className="meter__range"
            type="range"
            min={0.05}
            max={0.9}
            step={0.01}
            value={shownThreshold}
            disabled={vadAuto}
            onChange={(e) => updateSettings({ vadThreshold: Number(e.target.value) })}
            aria-label="Sensibilidade da voz"
          />
        )}
      </div>
      {monitor && on && (
        <label className="mic-test__listen" title="Use fones para não dar microfonia">
          <input type="checkbox" checked={listen} onChange={(e) => setListen(e.target.checked)} /> Ouvir
        </label>
      )}
      <button type="button" className="btn btn--sm" onClick={() => setOn(!on)}>
        {on ? 'Parar teste' : 'Testar microfone'}
      </button>
      <audio ref={audio} hidden />
    </div>
  );
}

function Keys({ combo }: { combo: string }) {
  return (
    <span className="keys">
      {comboParts(combo).map((part, i) => (
        <kbd key={i}>{part}</kbd>
      ))}
    </span>
  );
}

function KeybindsTab() {
  const binds = useApp((s) => s.settings.keybinds);
  const voiceMode = useApp((s) => s.settings.voiceMode);
  const [recording, setRecording] = useState<KeyAction | null>(null);
  const [notice, setNotice] = useState<{ error?: boolean; text: string } | null>(null);

  const assign = useCallback((action: KeyAction, combo: string | null) => {
    if (combo) {
      const reserved = reservedCombo(combo);
      if (reserved) {
        setNotice({ error: true, text: reserved });
        return;
      }
    }
    const current = getApp().settings.keybinds;
    const next = { ...current, [action]: combo };
    let moved = '';
    if (combo) {
      for (const other of KEY_ACTIONS) {
        if (other.id !== action && next[other.id] === combo) {
          next[other.id] = null;
          moved = other.label;
        }
      }
    }
    updateSettings({ keybinds: next });
    setRecording(null);
    if (moved) setNotice({ text: `Esse atalho era de “${moved}” e agora é só deste.` });
    else if (combo && !hasModifier(combo) && !isMouseCombo(combo) && action !== 'pushToTalk' && /^(Key|Digit)/.test(mainKey(combo))) {
      setNotice({ text: 'Atalhos de uma tecla só funcionam fora da caixa de mensagem.' });
    } else setNotice(null);
  }, []);

  useEffect(() => {
    if (!recording) return;
    pauseShortcuts(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if (e.code === 'Escape' && plain) {
        setRecording(null);
        return;
      }
      if ((e.code === 'Backspace' || e.code === 'Delete') && plain) {
        assign(recording, null);
        return;
      }
      const combo = comboFromKeyboard(e);
      if (combo) assign(recording, combo);
    };
    const onMouse = (e: MouseEvent) => {
      const combo = comboFromMouse(e);
      if (!combo) return;
      e.preventDefault();
      e.stopPropagation();
      assign(recording, combo);
    };
    const stopNav = (e: MouseEvent) => {
      if (comboFromMouse(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('mouseup', stopNav, true);
    return () => {
      pauseShortcuts(false);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('mouseup', stopNav, true);
    };
  }, [recording, assign]);

  return (
    <>
      <h3 className="settings__title">Atalhos</h3>
      <p className="muted">
        Clique num atalho e aperte a combinação nova (dá para usar os botões laterais do mouse). <kbd>Backspace</kbd> apaga, <kbd>Esc</kbd>{' '}
        cancela. Os atalhos funcionam com a janela do Órbita em foco.
      </p>
      <div className="keybinds">
        {KEY_ACTIONS.map((action) => {
          const combo = binds[action.id];
          const active = recording === action.id;
          return (
            <div key={action.id} className="keybind">
              <span className="keybind__label">
                <b>{action.label}</b>
                {action.hint && <small>{action.hint}</small>}
              </span>
              <button
                type="button"
                className={cx('keybind__value', active && 'is-recording')}
                onClick={() => {
                  setNotice(null);
                  setRecording(active ? null : action.id);
                }}
              >
                {active ? 'Aperte as teclas…' : combo ? <Keys combo={combo} /> : <span className="muted">Nenhum</span>}
              </button>
              <IconButton label="Remover atalho" disabled={!combo} onClick={() => assign(action.id, null)}>
                <X size={16} />
              </IconButton>
            </div>
          );
        })}
      </div>
      {notice && <p className={cx('notice', notice.error && 'notice--warn')}>{notice.text}</p>}
      {voiceMode !== 'ptt' && binds.pushToTalk && (
        <p className="muted small">A tecla de falar só vale com o modo de voz “Pressionar para falar” (em Voz e vídeo).</p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            updateSettings({ keybinds: DEFAULT_KEYBINDS });
            setNotice(null);
          }}
        >
          <RefreshCw size={15} /> Restaurar padrões
        </button>
      </div>
      <ExtensionHelp />
    </>
  );
}

/** Extensão de atalhos: funciona com o navegador minimizado ou em outro programa. */
function ExtensionHelp() {
  const version = useApp((s) => s.extension);
  const browser = /Edg\//.test(navigator.userAgent) ? 'edge' : (navigator as Navigator & { brave?: unknown }).brave ? 'brave' : 'chrome';
  return (
    <>
      <h4 className="settings__subtitle">Atalhos em segundo plano (extensão)</h4>
      <p className="muted">
        O navegador só deixa o Órbita ouvir o teclado com a janela dele em foco. Com a extensão, estes atalhos funcionam mesmo jogando ou com o navegador
        minimizado:
      </p>
      <div className="ext-keys">
        <span>
          <Keys combo="Ctrl+Shift+Digit1" /> abrir o Órbita
        </span>
        <span>
          <Keys combo="Ctrl+Shift+Digit2" /> microfone
        </span>
        <span>
          <Keys combo="Ctrl+Shift+Digit3" /> ensurdecer
        </span>
        <span>
          <Keys combo="Ctrl+Shift+Digit4" /> clipe
        </span>
      </div>
      {version ? (
        <p className="notice">
          <Puzzle size={16} /> Extensão instalada (versão {version}). Para trocar as teclas, abra <code>{browser}://extensions/shortcuts</code>.
        </p>
      ) : (
        <>
          <a className="btn btn--primary" href="./orbita-atalhos.zip" download="orbita-atalhos.zip">
            <Download size={15} /> Baixar a extensão
          </a>
          <ol className="ext-steps">
            <li>Descompacte o arquivo baixado (fica uma pasta “orbita-atalhos”).</li>
            <li>
              Abra <code>{browser}://extensions</code> numa aba nova.
            </li>
            <li>Ligue o “Modo do desenvolvedor” (no canto da página).</li>
            <li>Clique em “Carregar sem compactação” e escolha a pasta “orbita-atalhos”.</li>
            <li>Recarregue o Órbita. Os atalhos acima já funcionam; dá para trocar as teclas em <code>{browser}://extensions/shortcuts</code>.</li>
          </ol>
          <p className="muted small">A extensão é leve: só acorda quando você aperta um dos atalhos e só tem acesso ao site do Órbita.</p>
        </>
      )}
    </>
  );
}

function LiveTab() {
  const settings = useApp((s) => s.settings);
  return (
    <>
      <h3 className="settings__title">Lives</h3>
      <p className="muted">
        Na live, sua tela vai direto para cada espectador. Cada pessoa assistindo usa um pouco do seu upload — com internet fraca, prefira
        720p ou 480p. Tudo isso também dá para mudar com a live no ar.
      </p>
      <div className="field">
        <span>Qualidade padrão</span>
        <QualityPicker value={settings.liveQuality} onChange={(liveQuality) => updateSettings({ liveQuality })} />
      </div>
      <Switch
        label="Transmitir o som"
        hint="Som da janela, da aba ou do sistema. O som da chamada fica de fora."
        checked={settings.liveAudio}
        onChange={(liveAudio) => updateSettings({ liveAudio })}
      />
      <Switch
        label="Otimizar para movimento"
        hint="Ligado: jogos e vídeos (prioriza fluidez). Desligado: textos e código (prioriza nitidez)."
        checked={settings.liveMotion}
        onChange={(liveMotion) => updateSettings({ liveMotion })}
      />
      <Switch
        label="Laser e lápis dos espectadores"
        hint="Quem assiste pode apontar e desenhar por cima da sua live."
        checked={settings.liveEffects}
        onChange={(liveEffects) => updateSettings({ liveEffects })}
      />
      <label className="field">
        <span>Codec de vídeo (avançado)</span>
        <select value={settings.liveCodec} onChange={(e) => updateSettings({ liveCodec: e.target.value as typeof settings.liveCodec })}>
          <option value="auto">Automático (VP8) — recomendado</option>
          {availableCodecs()
            .filter((c) => c !== 'VP8')
            .map((c) => (
              <option key={c} value={c}>
                {c === 'H264' ? 'H.264' : c}
              </option>
            ))}
        </select>
        <span className="hint">Vale na próxima live. Codecs com aceleração por hardware gastam menos processador, mas em algumas placas de vídeo a imagem fica pior.</span>
      </label>
    </>
  );
}

function QualityPicker({ value, onChange }: { value: LiveQuality; onChange: (q: LiveQuality) => void }) {
  return (
    <div className="quality-grid">
      {(Object.keys(LIVE_PRESETS) as LiveQuality[]).map((key) => {
        const preset = LIVE_PRESETS[key];
        return (
          <button key={key} type="button" className={cx('quality', value === key && 'is-on')} aria-pressed={value === key} onClick={() => onChange(key)}>
            <b>{preset.label}</b>
            <span>{preset.hint}</span>
            <small>~{(preset.bitrate / 1e6).toFixed(1).replace('.', ',')} Mbps por espectador</small>
          </button>
        );
      })}
    </div>
  );
}

function NetworkTab() {
  const network = useApp((s) => s.settings.network);
  const [draft, setDraft] = useState(network);
  const iceValid = !draft.iceServersJson.trim() || !!parseIceServers(draft.iceServersJson);
  const save = () => {
    updateSettings({ network: { ...draft, host: draft.host.trim(), port: Number(draft.port) || 443 } });
    toast('Rede salva. Vale para a próxima órbita que você criar ou entrar.', 'success');
  };
  return (
    <>
      <h3 className="settings__title">Rede</h3>
      <p className="muted">
        O servidor de sinalização só apresenta os participantes (troca de “endereços” WebRTC). Mensagens, voz e vídeo nunca passam por
        ele. Todos na mesma órbita precisam usar o <b>mesmo</b> servidor.
      </p>
      <div className="grid-2">
        <label className="field">
          <span>Servidor PeerJS</span>
          <input placeholder="vazio = 0.peerjs.com (público)" value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
        </label>
        <label className="field">
          <span>Porta</span>
          <input type="number" value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Caminho</span>
          <input value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
        </label>
        <label className="field">
          <span>Chave</span>
          <input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
        </label>
      </div>
      <Switch label="Conexão segura (wss / https)" checked={draft.secure} onChange={(secure) => setDraft({ ...draft, secure })} />
      <label className="field">
        <span>Servidores STUN/TURN (JSON)</span>
        <textarea
          rows={4}
          spellCheck={false}
          className={cx(!iceValid && 'is-invalid')}
          placeholder={'[{"urls":"stun:stun.l.google.com:19302"},\n {"urls":"turn:seu-servidor:3478","username":"u","credential":"s"}]'}
          value={draft.iceServersJson}
          onChange={(e) => setDraft({ ...draft, iceServersJson: e.target.value })}
        />
      </label>
      {!iceValid && <p className="form-error">JSON inválido — precisa ser uma lista de servidores ICE.</p>}
      <p className="muted small">
        Vazio = STUN do Google + TURN público do PeerJS. Em redes muito fechadas (4G, empresas, faculdades), um TURN próprio melhora a
        conexão.
      </p>
      <div className="row row--end">
        <button type="button" className="btn btn--ghost" onClick={() => setDraft(DEFAULT_NETWORK)}>
          Restaurar padrão
        </button>
        <button type="button" className="btn btn--primary" disabled={!iceValid} onClick={save}>
          Salvar
        </button>
      </div>
    </>
  );
}

function AboutTab() {
  const binds = useApp((s) => s.settings.keybinds);
  return (
    <>
      <div className="about-hero">
        <OrbitLogo size={120} animated />
        <div>
          <h3 className="settings__title">
            Órbita <span className="muted small">v{APP_VERSION}</span>
          </h3>
          <p className="muted">Chat, voz, vídeo e lives peer-to-peer, direto no navegador.</p>
        </div>
      </div>
      <ul className="about-list">
        <li>
          <b>Quem cria a sala é o host</b> — o centro da órbita. O navegador dele mantém a sala viva: membros e histórico do chat.
        </li>
        <li>
          <b>Voz, vídeo e lives</b> vão direto de pessoa para pessoa (WebRTC, criptografado). O host não vê nem retransmite sua mídia.
        </li>
        <li>
          <b>Se o host sair</b>, o membro mais antigo assume sozinho e a sala continua.
        </li>
        <li>
          <b>Nada fica salvo:</b> quando a última pessoa sai, a órbita some.
        </li>
        <li>O servidor PeerJS só serve para as pessoas se encontrarem (sinalização).</li>
      </ul>
      <h4 className="settings__subtitle">Atalhos</h4>
      <div className="shortcuts">
        {KEY_ACTIONS.filter((a) => binds[a.id]).map((a) => (
          <span key={a.id}>
            <Keys combo={binds[a.id] as string} /> {a.label.toLowerCase()}
          </span>
        ))}
        <span>
          <kbd>Enter</kbd> envia · <kbd>Shift</kbd> + <kbd>Enter</kbd> nova linha
        </span>
      </div>
      <a className="btn btn--ghost" href={REPO_URL} target="_blank" rel="noreferrer">
        <ExternalLink size={16} /> Código no GitHub
      </a>
    </>
  );
}

// ───────────────────────── live ─────────────────────────

const SURFACE_LABEL: Record<LiveSurface, { label: string; icon: ReactNode }> = {
  monitor: { label: 'Tela inteira', icon: <Monitor size={15} /> },
  window: { label: 'Janela', icon: <AppWindow size={15} /> },
  browser: { label: 'Aba do navegador', icon: <AppWindow size={15} /> },
  unknown: { label: 'Tela', icon: <Monitor size={15} /> },
};

/** Começa a live ou, com ela no ar, muda as opções na hora (sem encerrar). */
function LiveModal({ onClose }: { onClose: () => void }) {
  const live = useApp((s) => s.live);
  const settings = useApp((s) => s.settings);
  const surface = useApp((s) => s.liveSurface);
  const [busy, setBusy] = useState(false);

  if (!live) {
    const go = async () => {
      setBusy(true);
      await startLive();
      setBusy(false);
    };
    return (
      <Modal
        title={
          <>
            <Radio size={20} /> Iniciar live
          </>
        }
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="btn btn--live" disabled={busy} onClick={() => void go()}>
              <MonitorUp size={16} /> Escolher o que transmitir
            </button>
          </>
        }
      >
        <p className="muted">
          Sua tela, janela ou aba vai direto para cada pessoa que clicar em “Assistir”. Dá para mudar tudo isso depois, com a live no ar.
        </p>
        <QualityPicker value={settings.liveQuality} onChange={(liveQuality) => updateSettings({ liveQuality })} />
        <Switch
          label="Transmitir o som"
          hint="Som da janela, da aba ou do sistema. O som da chamada fica de fora."
          checked={settings.liveAudio}
          onChange={(liveAudio) => updateSettings({ liveAudio })}
        />
        <Switch label="Otimizar para movimento" hint="Jogos e vídeos. Desligue para textos e código." checked={settings.liveMotion} onChange={(liveMotion) => updateSettings({ liveMotion })} />
        <Switch
          label="Laser e lápis dos espectadores"
          hint="Quem assiste pode apontar e desenhar por cima da live."
          checked={settings.liveEffects}
          onChange={(liveEffects) => updateSettings({ liveEffects })}
        />
        <LiveTips />
      </Modal>
    );
  }

  const where = SURFACE_LABEL[surface ?? 'unknown'];
  return (
    <Modal
      title={
        <>
          <span className="live-badge">AO VIVO</span> Sua live
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn--danger-ghost"
            onClick={() => {
              onClose();
              stopLive();
            }}
          >
            <Square size={14} /> Encerrar live
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Pronto
          </button>
        </>
      }
    >
      <div className="live-status">
        <span>
          {where.icon} {where.label}
        </span>
        <span>
          {live.viewers} {live.viewers === 1 ? 'pessoa assistindo' : 'pessoas assistindo'}
        </span>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await switchLiveSource();
            setBusy(false);
          }}
        >
          <RefreshCw size={14} /> Trocar o que está sendo transmitido
        </button>
        {canFloat() && (
          <button type="button" className="btn btn--sm" onClick={() => void openFloating()}>
            <SquareArrowOutUpRight size={14} /> Janela flutuante
          </button>
        )}
      </div>
      <QualityPicker value={live.quality} onChange={(quality) => void updateLiveOptions({ quality })} />
      <Switch
        label="Som da live"
        hint={live.audio ? 'Os espectadores ouvem o som do que você transmite.' : 'Ligar pede para escolher a fonte de novo, com o áudio marcado.'}
        checked={live.audio}
        onChange={(audio) => void updateLiveOptions({ audio })}
      />
      <Switch label="Otimizar para movimento" hint="Jogos e vídeos. Desligue para textos e código." checked={settings.liveMotion} onChange={(motion) => void updateLiveOptions({ motion })} />
      <Switch
        label="Laser e lápis dos espectadores"
        hint="Quem assiste pode apontar e desenhar por cima da live."
        checked={live.effects}
        onChange={(effects) => void updateLiveOptions({ effects })}
      />
      <LiveTips />
    </Modal>
  );
}

function LiveTips() {
  return (
    <details className="tips">
      <summary>
        <Lightbulb size={15} /> Dicas: som da janela, barra do navegador e monitores
      </summary>
      <ul>
        <li>
          <b>Janela com som:</b> na aba “Janela”, escolha a janela e ative <i>compartilhar o áudio do app</i>. Funciona no Chrome, Edge e
          Brave atualizados.
        </li>
        <li>
          <b>Sem a barra “compartilhando esta guia”:</b> essa barra é do navegador e não some quando você transmite uma aba. Transmita a{' '}
          <i>janela</i> do navegador (com o áudio do app) no lugar da aba: a imagem é a mesma e o som da chamada fica de fora.
        </li>
        <li>
          <b>Tela inteira:</b> ative <i>compartilhar áudio do sistema</i>. As vozes da chamada são tiradas da live automaticamente (sem eco); o
          som das outras abas e programas continua.
        </li>
        <li>
          <b>Um monitor (ou as janelas dele) não aparece?</b> Em notebooks com duas placas de vídeo, o navegador rodando na placa dedicada
          não enxerga a tela ligada à integrada. No Windows: Configurações › Sistema › Tela › Gráficos › escolha o navegador › “Economia
          de energia”, e reabra o navegador.
        </li>
      </ul>
    </details>
  );
}

// ───────────────────────── host ─────────────────────────

function LeaveModal({ onClose }: { onClose: () => void }) {
  const room = useApp((s) => s.room);
  const meId = useApp((s) => s.meId);
  const candidates = room?.members.filter((m) => m.id !== meId && !m.reconnecting) ?? [];
  const [target, setTarget] = useState(candidates[0]?.id ?? '');
  return (
    <Modal
      title="Sair da sua órbita"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn--danger-ghost"
            onClick={() => {
              onClose();
              endRoom();
            }}
          >
            Encerrar para todos
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!target}
            onClick={() => {
              onClose();
              transferAndLeave(target);
            }}
          >
            <Crown size={16} /> Passar a coroa e sair
          </button>
        </>
      }
    >
      <p>Você é o centro desta órbita. Escolha quem assume como host — a sala continua viva para os outros.</p>
      <div className="radio-list">
        {candidates.map((m) => (
          <label key={m.id} className={cx('radio-row', target === m.id && 'is-on')}>
            <input type="radio" name="new-host" checked={target === m.id} onChange={() => setTarget(m.id)} />
            <Planet memberId={m.id} name={m.name} color={m.color} size={32} />
            <span>{m.name}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function RoomModal({ onClose }: { onClose: () => void }) {
  const room = useApp((s) => s.room);
  const [name, setName] = useState(room?.name ?? '');
  if (!room) return null;
  const save = () => {
    if (name.trim()) renameRoom(name);
    onClose();
  };
  return (
    <Modal
      title="Editar órbita"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn--primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <label className="field">
        <span>Nome da órbita</span>
        <input
          value={name}
          maxLength={40}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
      </label>
      <Switch
        label="Trancar órbita"
        hint="Ninguém novo entra, nem com o convite. Quem já está continua."
        checked={room.locked}
        onChange={setLocked}
      />
    </Modal>
  );
}

// ───────────────────────── outros ─────────────────────────

function ImageModal({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose}>
      <img src={src} alt={name} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox__bar" onClick={(e) => e.stopPropagation()}>
        <span>{name}</span>
        <a className="btn btn--sm" href={src} download={name}>
          <Download size={14} /> Baixar
        </a>
        <button type="button" className="btn btn--sm" onClick={onClose}>
          <X size={14} /> Fechar
        </button>
      </div>
    </div>
  );
}

function ConfirmModal({ modal, onClose }: { modal: Extract<ModalState, { kind: 'confirm' }>; onClose: () => void }) {
  return (
    <Modal
      title={modal.title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className={cx('btn', modal.danger ? 'btn--danger' : 'btn--primary')}
            autoFocus
            onClick={() => {
              onClose();
              modal.action();
            }}
          >
            {modal.confirm}
          </button>
        </>
      }
    >
      <p>{modal.body}</p>
    </Modal>
  );
}
