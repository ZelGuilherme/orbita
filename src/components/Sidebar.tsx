import { useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Copy,
  Crown,
  Hash,
  HeadphoneOff,
  Headphones,
  Lock,
  LockOpen,
  LogOut,
  Mic,
  MicOff,
  MonitorUp,
  Pencil,
  PhoneOff,
  Plus,
  Settings,
  Signal,
  UserPlus,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import {
  copyInvite,
  joinVoice,
  leaveVoice,
  openChannel,
  openLive,
  requestLeave,
  setLocked,
  stopLive,
  toggleCamera,
  toggleDeafen,
  toggleMic,
} from '../controller';
import type { Channel, ChannelType, Member } from '../lib/protocol';
import { setApp, useApp } from '../store';
import { openMemberCard } from './MemberList';
import { OrbitLogo } from './OrbitLogo';
import { Planet } from './Planet';
import { cx, IconButton } from './ui';

export function Sidebar() {
  const room = useApp((s) => s.room);
  const isHost = useApp((s) => s.isHost);
  const view = useApp((s) => s.view);
  const unread = useApp((s) => s.unread);
  const mentions = useApp((s) => s.mentions);
  const voiceChannelId = useApp((s) => s.voiceChannelId);
  const [menu, setMenu] = useState(false);
  if (!room) return null;
  const textChannels = room.channels.filter((c) => c.type === 'text');
  const voiceChannels = room.channels.filter((c) => c.type === 'voice');
  const alone = room.members.length <= 1;

  return (
    <aside className="sidebar">
      <button type="button" className={cx('sidebar__header', menu && 'is-open')} onClick={() => setMenu(!menu)}>
        <span className="sidebar__room-name">
          {room.locked && <Lock size={14} />}
          {room.name}
        </span>
        <ChevronDown size={18} className="chev" />
      </button>
      {menu && <RoomMenu onClose={() => setMenu(false)} />}

      <div className="sidebar__scroll">
        {alone && isHost && <InviteCard />}
        <ChannelSection title="Canais de texto" type="text" canAdd={isHost}>
          {textChannels.map((c) => (
            <TextChannelRow
              key={c.id}
              channel={c}
              active={view?.channelId === c.id}
              unread={unread[c.id] ?? 0}
              mentions={mentions[c.id] ?? 0}
              canEdit={isHost}
            />
          ))}
        </ChannelSection>
        <ChannelSection title="Canais de voz" type="voice" canAdd={isHost}>
          {voiceChannels.map((c) => (
            <VoiceChannelRow
              key={c.id}
              channel={c}
              active={view?.channelId === c.id}
              connected={voiceChannelId === c.id}
              members={room.members.filter((m) => m.voiceChannelId === c.id)}
              hostId={room.hostId}
              canEdit={isHost}
            />
          ))}
        </ChannelSection>
      </div>

      {voiceChannelId && <VoicePanel />}
      <UserPanel />
    </aside>
  );
}

function RoomMenu({ onClose }: { onClose: () => void }) {
  const isHost = useApp((s) => s.isHost);
  const locked = useApp((s) => !!s.room?.locked);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="dropdown" role="menu">
        <button type="button" onClick={run(() => setApp({ modal: { kind: 'invite' } }))}>
          <UserPlus size={16} /> Convidar pessoas
        </button>
        {isHost && (
          <>
            <button type="button" onClick={run(() => setApp({ modal: { kind: 'room' } }))}>
              <Pencil size={16} /> Editar órbita
            </button>
            <button type="button" onClick={run(() => setLocked(!locked))}>
              {locked ? <LockOpen size={16} /> : <Lock size={16} />} {locked ? 'Destrancar órbita' : 'Trancar órbita'}
            </button>
            <button type="button" onClick={run(() => setApp({ modal: { kind: 'channel', type: 'text' } }))}>
              <Hash size={16} /> Criar canal de texto
            </button>
            <button type="button" onClick={run(() => setApp({ modal: { kind: 'channel', type: 'voice' } }))}>
              <Volume2 size={16} /> Criar canal de voz
            </button>
          </>
        )}
        <div className="dropdown__sep" />
        <button type="button" className="danger" onClick={run(requestLeave)}>
          <LogOut size={16} /> {isHost ? 'Sair ou encerrar a órbita' : 'Sair da órbita'}
        </button>
      </div>
    </>
  );
}

function InviteCard() {
  return (
    <div className="invite-card">
      <OrbitLogo size={64} animated />
      <p>
        <b>Sua órbita está no ar!</b>
        <br />
        Mande o link pros amigos entrarem.
      </p>
      <button type="button" className="btn btn--primary btn--sm" onClick={() => void copyInvite()}>
        <Copy size={14} /> Copiar convite
      </button>
    </div>
  );
}

function ChannelSection({ title, type, canAdd, children }: { title: string; type: ChannelType; canAdd: boolean; children: ReactNode }) {
  return (
    <section className="chan-section">
      <div className="chan-section__head">
        <span>{title}</span>
        {canAdd && (
          <button
            type="button"
            className="chan-section__add"
            aria-label={`Criar canal de ${type === 'text' ? 'texto' : 'voz'}`}
            title="Criar canal"
            onClick={() => setApp({ modal: { kind: 'channel', type } })}
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function ChannelTools({ channel }: { channel: Channel }) {
  return (
    <span
      className="chan__tools"
      title="Editar canal"
      onClick={(e) => {
        e.stopPropagation();
        setApp({ modal: { kind: 'channel', type: channel.type, channel } });
      }}
    >
      <Settings size={14} />
    </span>
  );
}

function TextChannelRow({
  channel,
  active,
  unread,
  mentions,
  canEdit,
}: {
  channel: Channel;
  active: boolean;
  unread: number;
  mentions: number;
  canEdit: boolean;
}) {
  return (
    <button
      type="button"
      className={cx('chan', active && 'is-active', unread > 0 && !active && 'is-unread')}
      onClick={() => openChannel({ kind: 'text', channelId: channel.id })}
    >
      <Hash size={18} className="chan__icon" />
      <span className="chan__name">{channel.name}</span>
      {mentions > 0 && !active && <span className="chan__badge">{mentions}</span>}
      {canEdit && <ChannelTools channel={channel} />}
    </button>
  );
}

function VoiceChannelRow({
  channel,
  active,
  connected,
  members,
  hostId,
  canEdit,
}: {
  channel: Channel;
  active: boolean;
  connected: boolean;
  members: Member[];
  hostId: string;
  canEdit: boolean;
}) {
  const speaking = useApp((s) => s.speaking);
  return (
    <div className="vchan">
      <button
        type="button"
        className={cx('chan', active && 'is-active', connected && 'is-connected')}
        onClick={() => void joinVoice(channel.id)}
        title={connected ? undefined : 'Entrar na chamada'}
      >
        <Volume2 size={18} className="chan__icon" />
        <span className="chan__name">{channel.name}</span>
        {canEdit && <ChannelTools channel={channel} />}
      </button>
      {members.length > 0 && (
        <ul className="vchan__members">
          {members.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={cx('vmember', m.reconnecting && 'is-away')}
                onClick={(e) => openMemberCard(m.id, e.currentTarget)}
              >
                <Planet name={m.name} color={m.color} size={24} speaking={!!speaking[m.id]} host={m.id === hostId} />
                <span className="vmember__name">{m.name}</span>
                <span className="vmember__icons">
                  {m.live && (
                    <span
                      className="live-badge live-badge--button"
                      title="Assistir live"
                      onClick={(e) => {
                        e.stopPropagation();
                        openLive(m.id);
                      }}
                    >
                      AO VIVO
                    </span>
                  )}
                  {m.cameraOn && <Video size={14} />}
                  {(m.serverMuted || !m.micOn || m.deafened) && <MicOff size={14} className={m.serverMuted ? 'danger' : undefined} />}
                  {m.deafened && <HeadphoneOff size={14} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VoicePanel() {
  const voiceChannelId = useApp((s) => s.voiceChannelId);
  const channelName = useApp((s) => s.room?.channels.find((c) => c.id === s.voiceChannelId)?.name ?? '');
  const roomName = useApp((s) => s.room?.name ?? '');
  const cameraOn = useApp((s) => s.cameraOn);
  const live = useApp((s) => s.live);
  const net = useApp((s) => s.net);
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  if (!voiceChannelId) return null;
  return (
    <div className="voice-panel">
      <button type="button" className="voice-panel__status" onClick={() => openChannel({ kind: 'voice', channelId: voiceChannelId })}>
        <span className={cx('voice-panel__title', net === 'reconnecting' && 'is-warn')}>
          <Signal size={16} /> {net === 'reconnecting' ? 'Reconectando…' : 'Voz conectada'}
        </span>
        <span className="voice-panel__sub">
          {channelName} · {roomName}
        </span>
      </button>
      <div className="voice-panel__actions">
        <IconButton label={cameraOn ? 'Desligar câmera' : 'Ligar câmera'} active={cameraOn} onClick={() => void toggleCamera()}>
          {cameraOn ? <Video size={19} /> : <VideoOff size={19} />}
        </IconButton>
        <IconButton
          label={!canShare ? 'Seu navegador não compartilha tela' : live ? 'Encerrar live' : 'Iniciar live'}
          className={live ? 'is-live' : undefined}
          disabled={!canShare}
          onClick={() => (live ? stopLive() : setApp({ modal: { kind: 'golive' } }))}
        >
          <MonitorUp size={19} />
        </IconButton>
        <IconButton label="Desconectar da voz" className="is-danger" onClick={() => leaveVoice()}>
          <PhoneOff size={19} />
        </IconButton>
      </div>
    </div>
  );
}

function UserPanel() {
  const profile = useApp((s) => s.profile);
  const micOn = useApp((s) => s.micOn);
  const deafened = useApp((s) => s.deafened);
  const speaking = useApp((s) => (s.meId ? !!s.speaking[s.meId] : false));
  const isHost = useApp((s) => s.isHost);
  const code = useApp((s) => s.code);
  const serverMuted = useApp((s) => !!s.room?.members.find((m) => m.id === s.meId)?.serverMuted);
  const muted = !micOn || deafened || serverMuted;
  return (
    <div className="user-panel">
      <button type="button" className="user-panel__me" onClick={() => setApp({ modal: { kind: 'settings', tab: 'perfil' } })}>
        <Planet name={profile.name} color={profile.color} size={34} speaking={speaking} host={isHost} />
        <span className="user-panel__text">
          <span className="user-panel__name">{profile.name}</span>
          <span className="user-panel__sub">
            {isHost ? (
              <>
                <Crown size={11} /> host
              </>
            ) : (
              `#${code}`
            )}
          </span>
        </span>
      </button>
      <IconButton
        label={serverMuted ? 'Silenciado pelo host' : muted ? 'Ativar microfone' : 'Silenciar microfone'}
        className={cx(muted && 'is-off')}
        onClick={toggleMic}
      >
        {muted ? <MicOff size={19} /> : <Mic size={19} />}
      </IconButton>
      <IconButton label={deafened ? 'Ativar áudio' : 'Ensurdecer'} className={cx(deafened && 'is-off')} onClick={toggleDeafen}>
        {deafened ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
      </IconButton>
      <IconButton label="Configurações" onClick={() => setApp({ modal: { kind: 'settings' } })}>
        <Settings size={19} />
      </IconButton>
    </div>
  );
}
