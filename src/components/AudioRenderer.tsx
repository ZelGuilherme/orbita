import { useEffect, useRef } from 'react';
import { Volume2 } from 'lucide-react';
import { baseId } from '../lib/hub';
import type { Member } from '../lib/protocol';
import { setApp, useApp } from '../store';

const EMPTY_MEMBERS: Member[] = [];

/**
 * Toca o áudio de todo mundo da chamada (e das lives assistidas), independente da
 * tela aberta — dá para ler o chat sem cair da voz.
 */
export function AudioRenderer() {
  const voiceStreams = useApp((s) => s.voiceStreams);
  const liveStreams = useApp((s) => s.liveStreams);
  const deafened = useApp((s) => s.deafened);
  const volumes = useApp((s) => s.volumes);
  const localMutes = useApp((s) => s.localMutes);
  const members = useApp((s) => s.room?.members ?? EMPTY_MEMBERS);
  const sinkId = useApp((s) => s.settings.audioOutputId);
  const blocked = useApp((s) => s.audioBlocked);

  return (
    <>
      {Object.entries(voiceStreams).map(([id, stream]) => {
        const member = members.find((m) => m.id === id);
        return (
          <RemoteAudio
            key={`v-${id}-${stream.id}`}
            stream={stream}
            volume={(volumes[baseId(id)] ?? 100) / 100}
            muted={deafened || !!localMutes[id] || !!member?.serverMuted}
            sinkId={sinkId}
          />
        );
      })}
      {Object.entries(liveStreams).map(([id, stream]) =>
        stream.getAudioTracks().length ? (
          <RemoteAudio key={`l-${id}-${stream.id}`} stream={stream} volume={(volumes[baseId(id)] ?? 100) / 100} muted={deafened} sinkId={sinkId} />
        ) : null,
      )}
      {blocked && (
        <button type="button" className="audio-unlock" onClick={unlockAudio}>
          <Volume2 size={16} /> Clique para ativar o som da chamada
        </button>
      )}
    </>
  );
}

function unlockAudio() {
  document.querySelectorAll('audio').forEach((audio) => void audio.play().catch(() => {}));
  setApp({ audioBlocked: false });
}

function RemoteAudio({ stream, volume, muted, sinkId }: { stream: MediaStream; volume: number; muted: boolean; sinkId: string }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    audio.srcObject = stream;
    audio.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'NotAllowedError') setApp({ audioBlocked: true });
    });
  }, [stream]);

  useEffect(() => {
    if (ref.current) ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const audio = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (audio?.setSinkId) void audio.setSinkId(sinkId).catch(() => {});
  }, [sinkId]);

  return <audio ref={ref} autoPlay />;
}
