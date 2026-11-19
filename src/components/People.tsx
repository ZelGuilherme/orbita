import { useState } from 'react';
import {
  ChevronDown,
  Copy,
  Crown,
  HeadphoneOff,
  Headphones,
  Lock,
  LockOpen,
  LogOut,
  Mic,
  MicOff,
  Pencil,
  Settings,
  UserPlus,
  Video,
  X,
} from 'lucide-react';
import { copyInvite, openLive, requestLeave, setLocked, toggleDeafen, toggleMic } from '../controller';
import type { Member } from '../lib/protocol';
import { setApp, useApp, voiceChannelOf } from '../store';
import { openMemberCard } from './MemberCard';
import { OrbitLogo } from './OrbitLogo';
import { Planet } from './Planet';
import { cx, IconButton } from './ui';

/** Painel da esquerda: a sala, quem está na chamada, quem está só na órbita e você. */
export function People() {
  const room = useApp((s) => s.room);
  const isHost = useApp((s) => s.isHost);
  const speaking = useApp((s) => s.speaking);
  const meId = useApp((s) => s.meId);
  const [menu, setMenu] = useState(false);
  if (!room) return null;
  const callId = voiceChannelOf(room)?.id;
  const inCall = room.members.filter((m) => !!callId && m.voiceChannelId === callId);
  const others = room.members.filter((m) => !inCall.includes(m));
  const alone = room.members.length <= 1;

  return (
    <aside className="people" aria-label="Pessoas na órbita">
      <div className="people__head">
        <button type="button" className={cx('people__room', menu && 'is-open')} onClick={() => setMenu(!menu)} aria-expanded={menu}>
          <OrbitLogo size={26} />
          <span className="people__room-name">
            {room.locked && <Lock size={13} />}
            {room.name}
          </span>
          <ChevronDown size={18} className="chev" />
        </button>
        <button type="button" className="people__close" aria-label="Fechar" onClick={() => setApp({ peopleOpen: false })}>
          <X size={20} />
        </button>
      </div>
      {menu && <RoomMenu onClose={() => setMenu(false)} />}

      <div className="people__scroll">
        {alone && isHost && <InviteCard />}
        <h3 className="people__title">
          Na chamada <span>{inCall.length}</span>
        </h3>
        {inCall.map((m) => (
          <PersonRow key={m.id} member={m} host={m.id === room.hostId} me={m.id === meId} speaking={!!speaking[m.id]} />
        ))}
        {!inCall.length && <p className="people__empty">Ninguém na chamada ainda.</p>}
        {others.length > 0 && (
          <>
            <h3 className="people__title">
              Só no chat <span>{others.length}</span>
            </h3>
            {others.map((m) => (
              <PersonRow key={m.id} member={m} host={m.id === room.hostId} me={m.id === meId} speaking={false} />
            ))}
          </>
        )}
      </div>

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
        <button type="button" role="menuitem" onClick={run(() => setApp({ modal: { kind: 'invite' } }))}>
          <UserPlus size={16} /> Convidar pessoas
        </button>
        {isHost && (
          <>
            <button type="button" role="menuitem" onClick={run(() => setApp({ modal: { kind: 'room' } }))}>
              <Pencil size={16} /> Editar órbita
            </button>
            <button type="button" role="menuitem" onClick={run(() => setLocked(!locked))}>
              {locked ? <LockOpen size={16} /> : <Lock size={16} />} {locked ? 'Destrancar órbita' : 'Trancar órbita'}
            </button>
          </>
        )}
        <button type="button" role="menuitem" onClick={run(() => setApp({ modal: { kind: 'settings' } }))}>
          <Settings size={16} /> Configurações
        </button>
        <div className="dropdown__sep" />
        <button type="button" role="menuitem" className="danger" onClick={run(requestLeave)}>
          <LogOut size={16} /> {isHost ? 'Sair ou encerrar a órbita' : 'Sair da órbita'}
        </button>
      </div>
    </>
  );
}

function InviteCard() {
  return (
    <div className="invite-card">
      <OrbitLogo size={56} animated />
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

function PersonRow({ member, host, me, speaking }: { member: Member; host: boolean; me: boolean; speaking: boolean }) {
  const muted = member.serverMuted || !member.micOn || member.deafened;
  return (
    <button type="button" className={cx('person', member.reconnecting && 'is-away')} onClick={(e) => openMemberCard(member.id, e.currentTarget)}>
      <Planet name={member.name} color={member.color} size={34} host={host} speaking={speaking} live={!!member.live} />
      <span className="person__text">
        <span className={cx('person__name', host && 'is-host')}>
          {member.name}
          {me && <span className="muted"> (você)</span>}
        </span>
        <span className="person__status">
          {member.reconnecting ? (
            'Reconectando…'
          ) : member.live && me ? (
            <span className="live-text">● Você está ao vivo</span>
          ) : member.live ? (
            <span
              className="live-text"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                openLive(member.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  openLive(member.id);
                }
              }}
            >
              ● Ao vivo — assistir
            </span>
          ) : host ? (
            <>
              <Crown size={11} /> host
            </>
          ) : member.voiceChannelId ? (
            'Na chamada'
          ) : (
            'Online'
          )}
        </span>
      </span>
      <span className="person__icons">
        {member.cameraOn && <Video size={14} />}
        {member.voiceChannelId && muted && <MicOff size={14} className={member.serverMuted ? 'danger' : undefined} />}
        {member.deafened && <HeadphoneOff size={14} />}
      </span>
    </button>
  );
}

function UserPanel() {
  const profile = useApp((s) => s.profile);
  const micOn = useApp((s) => s.micOn);
  const deafened = useApp((s) => s.deafened);
  const speaking = useApp((s) => (s.meId ? !!s.speaking[s.meId] : false));
  const isHost = useApp((s) => s.isHost);
  const code = useApp((s) => s.code);
  const inCall = useApp((s) => s.inCall);
  const serverMuted = useApp((s) => !!s.room?.members.find((m) => m.id === s.meId)?.serverMuted);
  const muted = !micOn || deafened || serverMuted;
  return (
    <div className="user-panel">
      <button type="button" className="user-panel__me" onClick={() => setApp({ modal: { kind: 'settings', tab: 'perfil' } })} title="Editar perfil">
        <Planet name={profile.name} color={profile.color} size={34} speaking={speaking} host={isHost} />
        <span className="user-panel__text">
          <span className="user-panel__name">{profile.name}</span>
          <span className="user-panel__sub">{inCall ? 'na chamada' : `#${code}`}</span>
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
