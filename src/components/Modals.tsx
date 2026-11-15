import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Copy,
  Crown,
  Download,
  ExternalLink,
  Hash,
  Info,
  Lock,
  Mic,
  MonitorUp,
  Radio,
  Share2,
  Trash2,
  User,
  UserPlus,
  Volume2,
  Wifi,
  X,
} from 'lucide-react';
import {
  copyInvite,
  createChannel,
  deleteChannel,
  endRoom,
  renameChannel,
  renameRoom,
  setLocked,
  shareInvite,
  startLive,
  transferAndLeave,
  updateProfile,
  updateSettings,
} from '../controller';
import { APP_VERSION, REPO_URL } from '../lib/config';
import { LIVE_PRESETS, levelFromBuffer } from '../lib/media';
import { parseIceServers } from '../lib/peer';
import type { Channel, ChannelType, LiveQuality } from '../lib/protocol';
import { DEFAULT_NETWORK } from '../lib/storage';
import { errorMessage, inviteLink, sanitizeName } from '../lib/util';
import { setApp, toast, useApp, type Modal as ModalState, type SettingsTab } from '../store';
import { Swatches } from './Landing';
import { OrbitLogo } from './OrbitLogo';
import { Planet } from './Planet';
import { cx, Modal, Switch } from './ui';

export function Modals() {
  const modal = useApp((s) => s.modal);
  const close = useCallback(() => setApp({ modal: null }), []);
  if (!modal) return null;
  switch (modal.kind) {
    case 'invite':
      return <InviteModal onClose={close} />;
    case 'settings':
      return <SettingsModal initial={modal.tab} onClose={close} />;
    case 'golive':
      return <GoLiveModal onClose={close} />;
    case 'leave':
      return <LeaveModal onClose={close} />;
    case 'room':
      return <RoomModal onClose={close} />;
    case 'channel':
      return <ChannelModal type={modal.type} channel={modal.channel} onClose={close} />;
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
  ['audio', 'Voz e vídeo', <Mic size={17} key="m" />],
  ['live', 'Lives', <Radio size={17} key="r" />],
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
            <button key={key} type="button" className={cx(tab === key && 'is-on')} onClick={() => setTab(key)}>
              {icon}
              {label}
            </button>
          ))}
        </nav>
        <div className="settings__content">
          <button type="button" className="modal__close settings__close" onClick={onClose} aria-label="Fechar">
            <X size={20} />
          </button>
          {tab === 'perfil' && <ProfileTab />}
          {tab === 'audio' && <AudioTab />}
          {tab === 'live' && <LiveTab />}
          {tab === 'rede' && <NetworkTab />}
          {tab === 'sobre' && <AboutTab />}
        </div>
      </div>
    </Modal>
  );
}

function ProfileTab() {
  const profile = useApp((s) => s.profile);
  const isHost = useApp((s) => s.isHost);
  const [name, setName] = useState(profile.name);
  const commit = () => {
    const clean = sanitizeName(name);
    setName(clean);
    if (clean !== profile.name) updateProfile({ name: clean });
  };
  return (
    <>
      <h3 className="settings__title">Perfil</h3>
      <div className="profile-preview">
        <Planet name={name || '?'} color={profile.color} size={92} host={isHost} />
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
      <div className="field">
        <span>Cor do seu planeta</span>
        <Swatches value={profile.color} onChange={(color) => updateProfile({ color })} />
      </div>
      <p className="muted small">Seu perfil fica salvo só neste navegador. Não existe conta nem servidor guardando nada.</p>
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
          .filter((d) => d.deviceId && d.deviceId !== 'default')
          .map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
      </select>
    </label>
  );
}

function AudioTab() {
  const settings = useApp((s) => s.settings);
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

  const canPickOutput = 'setSinkId' in HTMLMediaElement.prototype;
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
      <MicTest threshold={settings.vadThreshold} onThreshold={(vadThreshold) => updateSettings({ vadThreshold })} />
      <Switch
        label="Cancelamento de eco"
        checked={settings.echoCancellation}
        onChange={(echoCancellation) => updateSettings({ echoCancellation })}
      />
      <Switch
        label="Supressão de ruído"
        hint="Corta ventilador, teclado e barulho de fundo."
        checked={settings.noiseSuppression}
        onChange={(noiseSuppression) => updateSettings({ noiseSuppression })}
      />
      <Switch
        label="Ganho automático"
        hint="Ajusta o volume da sua voz sozinho."
        checked={settings.autoGainControl}
        onChange={(autoGainControl) => updateSettings({ autoGainControl })}
      />
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
        label="Sons da interface"
        hint="Entrar e sair da voz, mensagens, menções e lives."
        checked={settings.sounds}
        onChange={(sounds) => updateSettings({ sounds })}
      />
    </>
  );
}

function MicTest({ threshold, onThreshold }: { threshold: number; onThreshold: (value: number) => void }) {
  const settings = useApp((s) => s.settings);
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0);
  const { audioInputId, echoCancellation, noiseSuppression, autoGainControl } = settings;

  useEffect(() => {
    if (!on) {
      setLevel(0);
      return;
    }
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: audioInputId ? { ideal: audioInputId } : undefined,
            echoCancellation,
            noiseSuppression,
            autoGainControl,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        const loop = () => {
          analyser.getFloatTimeDomainData(buffer);
          setLevel(levelFromBuffer(buffer));
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        toast(`Não consegui abrir o microfone: ${errorMessage(err)}.`, 'error');
        setOn(false);
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
    };
  }, [on, audioInputId, echoCancellation, noiseSuppression, autoGainControl]);

  return (
    <div className="field">
      <span>Sensibilidade da voz</span>
      <div className="mic-test">
        <div className="meter">
          <div className={cx('meter__fill', level > threshold && 'is-hot')} style={{ width: `${Math.round(level * 100)}%` }} />
          <input
            className="meter__range"
            type="range"
            min={0.05}
            max={0.9}
            step={0.01}
            value={threshold}
            onChange={(e) => onThreshold(Number(e.target.value))}
            aria-label="Sensibilidade da voz"
          />
        </div>
        <button type="button" className="btn btn--sm" onClick={() => setOn(!on)}>
          {on ? 'Parar teste' : 'Testar microfone'}
        </button>
      </div>
      <span className="hint">Arraste o marcador: acima dele, você aparece falando (o anel verde no seu planeta).</span>
    </div>
  );
}

function LiveTab() {
  const settings = useApp((s) => s.settings);
  return (
    <>
      <h3 className="settings__title">Lives</h3>
      <p className="muted">
        Na live, sua tela vai direto para cada espectador. Cada pessoa assistindo usa um pouco do seu upload — com internet fraca, prefira
        720p ou 480p.
      </p>
      <div className="field">
        <span>Qualidade padrão</span>
        <QualityPicker value={settings.liveQuality} onChange={(liveQuality) => updateSettings({ liveQuality })} />
      </div>
      <Switch
        label="Transmitir áudio"
        hint="Som da aba ou do sistema (Chrome e Edge no Windows)."
        checked={settings.liveAudio}
        onChange={(liveAudio) => updateSettings({ liveAudio })}
      />
      <Switch
        label="Otimizar para movimento"
        hint="Ligado: jogos e vídeos (prioriza fluidez). Desligado: textos e código (prioriza nitidez)."
        checked={settings.liveMotion}
        onChange={(liveMotion) => updateSettings({ liveMotion })}
      />
    </>
  );
}

function QualityPicker({ value, onChange }: { value: LiveQuality; onChange: (q: LiveQuality) => void }) {
  return (
    <div className="quality-grid">
      {(Object.keys(LIVE_PRESETS) as LiveQuality[]).map((key) => {
        const preset = LIVE_PRESETS[key];
        return (
          <button key={key} type="button" className={cx('quality', value === key && 'is-on')} onClick={() => onChange(key)}>
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
          <b>Quem cria a sala é o host</b> — o centro da órbita. O navegador dele mantém a sala viva: membros, canais e histórico do chat.
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
        <span>
          <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd> microfone
        </span>
        <span>
          <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> ensurdecer
        </span>
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

function GoLiveModal({ onClose }: { onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const [quality, setQuality] = useState<LiveQuality>(settings.liveQuality);
  const [audio, setAudio] = useState(settings.liveAudio);
  const [motion, setMotion] = useState(settings.liveMotion);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    updateSettings({ liveQuality: quality, liveAudio: audio, liveMotion: motion });
    await startLive(quality, audio, motion);
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
            <MonitorUp size={16} /> Escolher tela e entrar ao vivo
          </button>
        </>
      }
    >
      <p className="muted">
        Sua tela vai direto para cada pessoa que clicar em “Assistir”, sem servidor no meio. Quem estiver na chamada também ouve sua voz.
      </p>
      <QualityPicker value={quality} onChange={setQuality} />
      <Switch label="Transmitir áudio" hint="Marque “compartilhar áudio” na janela do navegador." checked={audio} onChange={setAudio} />
      <Switch label="Otimizar para movimento" hint="Jogos e vídeos. Desligue para textos e código." checked={motion} onChange={setMotion} />
    </Modal>
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
            <Planet name={m.name} color={m.color} size={32} />
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

function ChannelModal({ type, channel, onClose }: { type: ChannelType; channel?: Channel; onClose: () => void }) {
  const [name, setName] = useState(channel?.name ?? '');
  const [kind, setKind] = useState<ChannelType>(channel?.type ?? type);
  const sameKind = useApp((s) => s.room?.channels.filter((c) => c.type === kind).length ?? 0);
  const save = () => {
    if (!name.trim()) return;
    if (channel) renameChannel(channel.id, name);
    else createChannel(name, kind);
    onClose();
  };
  const remove = () => {
    if (!channel) return;
    setApp({
      modal: {
        kind: 'confirm',
        title: `Apagar ${channel.type === 'text' ? '#' : ''}${channel.name}?`,
        body:
          channel.type === 'text'
            ? 'As mensagens deste canal somem para todo mundo.'
            : 'Quem estiver na chamada deste canal será desconectado.',
        confirm: 'Apagar canal',
        danger: true,
        action: () => deleteChannel(channel.id),
      },
    });
  };
  return (
    <Modal
      title={channel ? 'Editar canal' : 'Criar canal'}
      onClose={onClose}
      footer={
        <>
          {channel && sameKind > 1 && (
            <button type="button" className="btn btn--danger-ghost" onClick={remove}>
              <Trash2 size={16} /> Apagar
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn--primary" disabled={!name.trim()} onClick={save}>
            {channel ? 'Salvar' : 'Criar canal'}
          </button>
        </>
      }
    >
      {!channel && (
        <div className="kind-picker">
          <button type="button" className={cx('kind', kind === 'text' && 'is-on')} onClick={() => setKind('text')}>
            <Hash size={22} />
            <span>
              <b>Texto</b>
              <small>Mensagens, imagens, emojis e reações</small>
            </span>
          </button>
          <button type="button" className={cx('kind', kind === 'voice' && 'is-on')} onClick={() => setKind('voice')}>
            <Volume2 size={22} />
            <span>
              <b>Voz</b>
              <small>Chamada, câmera e lives</small>
            </span>
          </button>
        </div>
      )}
      <label className="field">
        <span>Nome do canal</span>
        <span className="input-icon">
          {kind === 'text' ? <Hash size={16} /> : <Volume2 size={16} />}
          <input
            value={name}
            maxLength={32}
            autoFocus
            placeholder={kind === 'text' ? 'novo-canal' : 'Nova sala'}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
          />
        </span>
      </label>
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
