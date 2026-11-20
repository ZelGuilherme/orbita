import { Circle, Scissors } from 'lucide-react';
import { saveClip, toggleRecording } from '../controller';
import type { Member } from '../lib/protocol';
import { useApp } from '../store';
import { cx, useNow } from './ui';

const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};

/** Gravar a chamada (o som de todos e, se houver, a live em destaque). */
export function RecordButton() {
  const recording = useApp((s) => s.recording);
  return (
    <button
      type="button"
      className={cx('ctrl', recording && 'is-recording')}
      data-tip={recording ? 'Parar e salvar a gravação' : 'Gravar a chamada'}
      aria-label={recording ? 'Parar a gravação' : 'Gravar a chamada'}
      onClick={() => void toggleRecording()}
    >
      <Circle fill={recording ? 'currentColor' : 'none'} />
      {recording && <RecordClock since={recording.since} />}
    </button>
  );
}

/** O relógio só existe (e redesenha a cada segundo) enquanto grava. */
function RecordClock({ since }: { since: number }) {
  const now = useNow(1_000);
  return <span className="ctrl__tag ctrl__tag--live">{clock(now - since)}</span>;
}

/** Salvar o último minuto (só aparece com os clipes ligados). */
export function ClipButton() {
  const enabled = useApp((s) => s.settings.clips);
  if (!enabled) return null;
  return (
    <button type="button" className="ctrl" data-tip="Salvar clipe do último minuto" aria-label="Salvar clipe do último minuto" onClick={() => void saveClip()}>
      <Scissors />
    </button>
  );
}

/** Aviso vermelho para todos: quem está gravando a chamada. */
export function RecordingNotice({ members }: { members: Member[] }) {
  const meId = useApp((s) => s.meId);
  const who = members.filter((m) => m.recording);
  if (!who.length) return null;
  const names = who.map((m) => (m.id === meId ? 'você' : m.name));
  return (
    <div className="rec-notice" role="status">
      <span className="rec-notice__dot" aria-hidden="true" />
      Gravando: {names.join(', ')}
    </div>
  );
}
