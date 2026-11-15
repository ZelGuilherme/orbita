import { joinRoom } from '../controller';
import type { EndReason } from '../lib/session';
import { setApp, useApp } from '../store';
import { OrbitLogo } from './OrbitLogo';
import { cx } from './ui';

export function Connecting() {
  const text = useApp((s) => s.connectingText);
  return (
    <div className="center-screen starfield">
      <OrbitLogo size={150} animated />
      <h1>{text}</h1>
      <p>Abrindo conexões WebRTC diretas — pode levar alguns segundos.</p>
    </div>
  );
}

const ENDED: Record<EndReason, { title: string; body: string }> = {
  ended: { title: 'A órbita foi encerrada', body: 'O host fechou a sala para todos. As mensagens foram junto — nada fica salvo.' },
  kicked: { title: 'Você foi removido', body: 'O host tirou você desta órbita.' },
  banned: { title: 'Você foi banido', body: 'O host baniu você desta órbita.' },
  lost: {
    title: 'Conexão perdida',
    body: 'Não consegui reconectar. O host pode ter saído sem ninguém para assumir, ou sua internet caiu.',
  },
  left: { title: 'Você saiu', body: '' },
};

export function Ended() {
  const ended = useApp((s) => s.ended);
  if (!ended) return null;
  const text = ENDED[ended.reason];
  return (
    <div className="center-screen starfield">
      <OrbitLogo size={120} />
      <h1>{text.title}</h1>
      {ended.roomName && <p className="muted">{ended.roomName}</p>}
      <p>{text.body}</p>
      <div className="row">
        {ended.reason === 'lost' && ended.code && (
          <button type="button" className="btn btn--primary" onClick={() => joinRoom(ended.code)}>
            Tentar entrar de novo
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={() => setApp({ phase: 'landing', ended: null })}>
          Voltar ao início
        </button>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast--${t.tone}`)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
