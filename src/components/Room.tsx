import type { CSSProperties } from 'react';
import { LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { applyUpdate, setChatOpen } from '../controller';
import { otherBuild } from '../lib/build';
import { setApp, useApp } from '../store';
import { AudioRenderer } from './AudioRenderer';
import { CallView } from './CallView';
import { ChatPanel } from './ChatPanel';
import { KnockRequests } from './Lobby';
import { MemberCard } from './MemberCard';
import { People } from './People';
import { cx } from './ui';

/** A sala: pessoas à esquerda, a chamada no meio e o chat (que dá para esconder) à direita. */
export function Room() {
  const room = useApp((s) => s.room);
  const chatOpen = useApp((s) => s.chatOpen);
  const peopleOpen = useApp((s) => s.peopleOpen);
  const chatWidth = useApp((s) => s.chatWidth);
  const net = useApp((s) => s.net);
  const netDetail = useApp((s) => s.netDetail);
  const updateReady = useApp((s) => s.updateReady);
  const hostOutdated = useApp((s) => {
    const host = s.room?.members.find((m) => m.id === s.room?.hostId);
    return !!host && host.id !== s.meId && otherBuild(host.build);
  });
  if (!room) return null;
  return (
    <div
      className={cx('room', chatOpen && 'room--chat', peopleOpen && 'room--people')}
      style={chatWidth ? ({ '--chat-w': `${chatWidth}px` } as CSSProperties) : undefined}
    >
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
        {hostOutdated && !updateReady && (
          <div className="banner banner--warn" role="status">
            <TriangleAlert size={15} /> Você e o host estão com versões diferentes do Órbita. Se algo não funcionar, quem estiver na versão antiga precisa
            atualizar a página (Ctrl+F5).
          </div>
        )}
        {updateReady && (
          <div className="banner banner--update" role="status">
            <RefreshCw size={15} /> Saiu uma versão nova do Órbita.
            <button type="button" className="btn btn--primary btn--sm" onClick={applyUpdate}>
              Atualizar
            </button>
            <button type="button" className="banner__close" aria-label="Depois" onClick={() => setApp({ updateReady: false })}>
              <X size={15} />
            </button>
          </div>
        )}
        <KnockRequests />
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
