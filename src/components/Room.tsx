import { LoaderCircle, LogOut, Settings, UserPlus } from 'lucide-react';
import { requestLeave } from '../controller';
import { hashColor, planetBackground, roomInitials } from '../lib/util';
import { setApp, useApp } from '../store';
import { AudioRenderer } from './AudioRenderer';
import { CallView } from './CallView';
import { ChatView } from './ChatView';
import { MemberCard, MemberList } from './MemberList';
import { OrbitLogo } from './OrbitLogo';
import { Sidebar } from './Sidebar';
import { cx } from './ui';

function ServerRail() {
  const room = useApp((s) => s.room);
  if (!room) return null;
  return (
    <nav className="rail starfield" aria-label="Navegação">
      <button
        type="button"
        className="rail__logo"
        data-tip="Órbita"
        data-tip-pos="right"
        onClick={() => setApp({ modal: { kind: 'settings', tab: 'sobre' } })}
      >
        <OrbitLogo size={42} />
      </button>
      <div className="rail__sep" />
      <button
        type="button"
        className="rail__room"
        data-tip={room.name}
        data-tip-pos="right"
        onClick={() => setApp({ modal: { kind: 'invite' } })}
      >
        <span className="rail__pill" />
        <span className="rail__room-planet" style={{ background: planetBackground(hashColor(room.code)) }}>
          {roomInitials(room.name)}
        </span>
      </button>
      <button
        type="button"
        className="rail__btn"
        data-tip="Convidar amigos"
        data-tip-pos="right"
        onClick={() => setApp({ modal: { kind: 'invite' } })}
      >
        <UserPlus size={20} />
      </button>
      <div className="rail__spacer" />
      <button type="button" className="rail__btn" data-tip="Configurações" data-tip-pos="right" onClick={() => setApp({ modal: { kind: 'settings' } })}>
        <Settings size={20} />
      </button>
      <button type="button" className="rail__btn rail__btn--danger" data-tip="Sair da órbita" data-tip-pos="right" onClick={requestLeave}>
        <LogOut size={20} />
      </button>
    </nav>
  );
}

export function Room() {
  const room = useApp((s) => s.room);
  const view = useApp((s) => s.view);
  const showMembers = useApp((s) => s.showMembers);
  const navOpen = useApp((s) => s.navOpen);
  const net = useApp((s) => s.net);
  const netDetail = useApp((s) => s.netDetail);
  if (!room) return null;
  return (
    <div className={cx('room', showMembers && 'room--members', navOpen && 'room--nav')}>
      <ServerRail />
      <Sidebar />
      <main className="room__main">
        {net === 'reconnecting' && (
          <div className="banner banner--warn" role="status">
            <LoaderCircle size={16} className="spin" />
            {netDetail === 'transfer'
              ? 'Trocando de host… a órbita já volta.'
              : 'Conexão com o host perdida — reconectando (ou escolhendo um novo centro da órbita)…'}
          </div>
        )}
        {view?.kind === 'voice' ? (
          <CallView key={view.channelId} channelId={view.channelId} />
        ) : view ? (
          <ChatView key={view.channelId} channelId={view.channelId} />
        ) : null}
      </main>
      {showMembers && <MemberList />}
      <div
        className="room__scrim"
        onClick={() => setApp(window.innerWidth <= 1100 ? { navOpen: false, showMembers: false } : { navOpen: false })}
      />
      <AudioRenderer />
      <MemberCard />
    </div>
  );
}
