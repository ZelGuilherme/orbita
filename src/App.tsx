import { lazy, Suspense, useEffect } from 'react';
import { Landing } from './components/Landing';
import { Connecting, Ended, HandOff, Toasts } from './components/Screens';
import { initController } from './controller';
import { useApp } from './store';

// a sala e as janelas (configurações, editor do planeta…) só carregam quando são usadas
const loadRoom = () => import('./components/Room').then((m) => ({ default: m.Room }));
const loadModals = () => import('./components/Modals').then((m) => ({ default: m.Modals }));
const Room = lazy(loadRoom);
const Modals = lazy(loadModals);

export default function App() {
  const phase = useApp((s) => s.phase);
  const modal = useApp((s) => !!s.modal);
  useEffect(() => initController(), []);
  // com a tela inicial já de pé, baixa o resto em segundo plano (entrar na sala fica instantâneo)
  useEffect(() => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1_500));
    idle(() => {
      void loadRoom();
      void loadModals();
    });
  }, []);
  return (
    <>
      {phase === 'landing' && <Landing />}
      {phase === 'connecting' && <Connecting />}
      {phase === 'room' && (
        <Suspense fallback={<Connecting />}>
          <Room />
        </Suspense>
      )}
      {phase === 'ended' && <Ended />}
      {phase === 'handoff' && <HandOff />}
      {modal && (
        <Suspense fallback={null}>
          <Modals />
        </Suspense>
      )}
      <Toasts />
    </>
  );
}
