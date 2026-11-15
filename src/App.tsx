import { useEffect } from 'react';
import { Landing } from './components/Landing';
import { Modals } from './components/Modals';
import { Room } from './components/Room';
import { Connecting, Ended, HandOff, Toasts } from './components/Screens';
import { initController } from './controller';
import { useApp } from './store';

export default function App() {
  const phase = useApp((s) => s.phase);
  useEffect(() => initController(), []);
  return (
    <>
      {phase === 'landing' && <Landing />}
      {phase === 'connecting' && <Connecting />}
      {phase === 'room' && <Room />}
      {phase === 'ended' && <Ended />}
      {phase === 'handoff' && <HandOff />}
      <Modals />
      <Toasts />
    </>
  );
}
