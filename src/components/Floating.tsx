import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Eye } from 'lucide-react';
import type { Member } from '../lib/protocol';
import { setApp, toast, useApp } from '../store';
import { FxLayer } from './LiveFx';
import { VideoEl } from './ui';

/**
 * Janela flutuante da live (Document Picture-in-Picture, Chrome/Edge/Brave): fica sempre por
 * cima das outras janelas, então quem transmite vê o laser e os desenhos dos espectadores
 * mesmo com o jogo ou outro app na frente do Órbita.
 */

interface PipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

const pipApi = () => (window as Window & { documentPictureInPicture?: PipApi }).documentPictureInPicture;

export const canFloat = () => !!pipApi();

const EMPTY: Member[] = [];
let pipWindow: Window | null = null;
let pipRoot: Root | null = null;

function copyStyles(target: Document) {
  for (const sheet of [...document.styleSheets]) {
    try {
      const css = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      const style = target.createElement('style');
      style.textContent = css;
      target.head.append(style);
    } catch {
      // folha de outro domínio: copia o link
      if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.append(link);
      }
    }
  }
}

export async function openFloating() {
  const api = pipApi();
  if (!api) return;
  if (pipWindow && !pipWindow.closed) {
    pipWindow.focus();
    return;
  }
  try {
    const win = await api.requestWindow({ width: 480, height: 300 });
    pipWindow = win;
    win.document.title = 'Órbita · sua live';
    copyStyles(win.document);
    win.document.body.className = 'floating-body';
    const host = win.document.createElement('div');
    host.className = 'floating-root';
    win.document.body.append(host);
    pipRoot = createRoot(host);
    pipRoot.render(<FloatingLive />);
    setApp({ floating: true });
    win.addEventListener('pagehide', () => {
      pipRoot?.unmount();
      pipRoot = null;
      pipWindow = null;
      setApp({ floating: false });
    });
  } catch (err) {
    console.warn('[janela flutuante]', err);
    toast('Não consegui abrir a janela flutuante.', 'error');
  }
}

export function closeFloating() {
  if (pipWindow && !pipWindow.closed) pipWindow.close();
}

function FloatingLive() {
  const stream = useApp((s) => s.localScreen);
  const meId = useApp((s) => s.meId);
  const live = useApp((s) => s.live);
  const members = useApp((s) => s.room?.members ?? EMPTY);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!live) closeFloating();
  }, [live]);

  if (!stream || !meId || !live) return null;
  return (
    <div className="floating tile tile--live tile--big">
      <VideoEl stream={stream} contain videoRef={videoRef} />
      <FxLayer streamerId={meId} videoRef={videoRef} members={members} tool={null} />
      <div className="tile__label">
        <span className="live-badge">AO VIVO</span>
        <span className="floating__viewers">
          <Eye size={13} /> {live.viewers} assistindo
        </span>
      </div>
    </div>
  );
}
