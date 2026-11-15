import { LoaderCircle } from 'lucide-react';
import { setChatOpen } from '../controller';
import { setApp, useApp } from '../store';
import { AudioRenderer } from './AudioRenderer';
import { CallView } from './CallView';
import { ChatPanel } from './ChatPanel';
import { MemberCard } from './MemberCard';
import { People } from './People';
import { cx } from './ui';

/** A sala: pessoas à esquerda, a chamada no meio e o chat (que dá para esconder) à direita. */
export function Room() {
  const room = useApp((s) => s.room);
  const chatOpen = useApp((s) => s.chatOpen);
  const peopleOpen = useApp((s) => s.peopleOpen);
  const net = useApp((s) => s.net);
  const netDetail = useApp((s) => s.netDetail);
  if (!room) return null;
  return (
    <div className={cx('room', chatOpen && 'room--chat', peopleOpen && 'room--people')}>
      <People />
      <main className="room__main">
        {net === 'reconnecting' && (
          <div className="banner banner--warn" role="status">
            <LoaderCircle size={16} className="spin" />
            {netDetail === 'transfer'
              ? 'Trocando de host… a órbita já volta.'
              : 'Conexão com o host perdida — reconectando (ou escolhendo um novo centro da órbita)…'}
          </div>
        )}
        <CallView />
      </main>
      <ChatPanel />
      <div
        className="room__scrim"
        onClick={() => {
          if (peopleOpen) setApp({ peopleOpen: false });
          else if (window.innerWidth <= 760) setChatOpen(false);
        }}
      />
      <AudioRenderer />
      <MemberCard />
    </div>
  );
}
