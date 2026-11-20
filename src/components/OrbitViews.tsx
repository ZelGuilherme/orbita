import { useLayoutEffect, useRef, useState } from 'react';
import { Box, Circle, Crown, MicOff, Rows3 } from 'lucide-react';
import { setOrbitView } from '../controller';
import type { Member, RoomState } from '../lib/protocol';
import type { OrbitView } from '../lib/storage';
import { hashColor, roomInitials } from '../lib/util';
import { hasWebGL } from '../lib/webgl';
import { useApp } from '../store';
import { FlingLayer, useDomPlanets } from './Flings';
import { Planet } from './Planet';
import { cx } from './ui';

const MODES: Array<{ id: OrbitView; label: string; title: string; icon: typeof Box }> = [
  { id: '3d', label: '3D', title: 'Planetas em 3D (gira a câmera e arrasta o seu planeta)', icon: Box },
  { id: '2d', label: '2D', title: 'Órbita plana, mais leve', icon: Circle },
  { id: 'line', label: 'Linha', title: 'Todos numa linha, com o host no meio (o mais leve)', icon: Rows3 },
];

/** Troca entre 3D, 2D e linha (fica sempre no canto de cima da área dos planetas). */
export function OrbitModeSwitch() {
  const mode = useApp((s) => s.orbitView);
  const can3d = hasWebGL();
  return (
    <div className="orbit-modes" role="radiogroup" aria-label="Como mostrar os planetas">
      {MODES.filter((m) => m.id !== '3d' || can3d).map((m) => {
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={cx('orbit3d__tool', mode === m.id && 'is-on')}
            title={m.title}
            onClick={() => setOrbitView(m.id)}
          >
            <Icon size={13} /> {m.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Modo linha: todos os planetas lado a lado, com o host no meio. Sem animação de órbita,
 * o mais leve. Clicar num planeta faz o mesmo que na órbita (live, câmera ou cartão).
 */
export function OrbitLine({
  members,
  room,
  onPick,
  compact = false,
}: {
  members: Member[];
  room: RoomState;
  onPick: (member: Member, anchor: Element) => void;
  compact?: boolean;
}) {
  const speaking = useApp((s) => s.speaking);
  const box = useRef<HTMLDivElement>(null);
  const locate = useDomPlanets(box);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const host = members.find((m) => m.id === room.hostId) ?? null;
  const others = members.filter((m) => m !== host);
  const left = others.slice(0, Math.ceil(others.length / 2));
  const right = others.slice(Math.ceil(others.length / 2));
  const count = others.length + 1;
  // cabem todos na largura (o host um pouco maior)
  const size = Math.round(Math.max(26, Math.min(compact ? Math.min(54, height * 0.42) : 76, (width - 32) / (count + 0.6) / 1.9)));
  const hostSize = Math.round(size * 1.35);

  const item = (m: Member, isHost: boolean) => {
    const muted = m.serverMuted || !m.micOn || m.deafened;
    return (
      <button
        key={m.id}
        type="button"
        data-planet-id={m.id}
        className={cx('orbit-line__item', isHost && 'is-host', m.reconnecting && 'is-away')}
        aria-label={m.live ? `${m.name}: assistir live` : m.cameraOn ? `${m.name}: ver câmera` : m.name}
        onClick={(e) => onPick(m, e.currentTarget)}
      >
        <Planet memberId={m.id} name={m.name} color={m.color} size={isHost ? hostSize : size} host={isHost} speaking={!!speaking[m.id]} live={!!m.live} />
        <span className="orbit3d__name">
          {m.live && <span className="live-dot" />}
          {m.name}
          {muted && <MicOff size={12} />}
        </span>
        {isHost && !compact && (
          <span className="orbit3d__sub">
            <Crown size={12} /> host
          </span>
        )}
      </button>
    );
  };

  return (
    <div className={cx('orbit-line', compact && 'orbit-line--compact')} ref={box}>
      <div className="orbit-line__row" style={{ gap: Math.max(6, size * 0.45) }}>
        {left.map((m) => item(m, false))}
        {host ? (
          item(host, true)
        ) : (
          <div className="orbit-line__item is-host is-room">
            <Planet name={room.name} color={hashColor(room.code)} size={hostSize} text={roomInitials(room.name)} />
            <span className="orbit3d__name">{room.name}</span>
          </div>
        )}
        {right.map((m) => item(m, false))}
      </div>
      <FlingLayer locate={locate} />
      <div className="orbit3d__tools">
        <OrbitModeSwitch />
      </div>
    </div>
  );
}
