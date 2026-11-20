import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Crown, MicOff, RotateCcw } from 'lucide-react';
import { setMyOrbit } from '../controller';
import { randomOrbit } from '../lib/orbitPath';
import { DEFAULT_PLANET } from '../lib/planet';
import { textureSeed } from '../lib/noise';
import type { Member, RoomState } from '../lib/protocol';
import { hashColor } from '../lib/util';
import { useApp } from '../store';
import { OrbitScene, type LabelPos, type SceneMember } from '../three/OrbitScene';
import { OrbitModeSwitch } from './OrbitViews';
import { cx, useReducedMotion } from './ui';

/** Câmera de cada pessoa da chamada (a minha vem direto da câmera; a dos outros, da chamada). */
function useCameras(members: Member[]): Record<string, MediaStream | null> {
  const meId = useApp((s) => s.meId);
  const local = useApp((s) => s.localCamera);
  const remote = useApp((s) => s.voiceStreams);
  return useMemo(() => {
    const out: Record<string, MediaStream | null> = {};
    for (const m of members) out[m.id] = m.cameraOn ? (m.id === meId ? local : (remote[m.id] ?? null)) : null;
    return out;
  }, [members, meId, local, remote]);
}

const HINT_KEY = 'orbita.hint3d';

/** A órbita da chamada em 3D (three.js). No canto, troca para 2D ou para a linha. */
export default function Orbit3D({
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
  const meId = useApp((s) => s.meId);
  const myOrbit = useApp((s) => s.profile.orbit);
  const speaking = useApp((s) => s.speaking);
  const avatars = useApp((s) => s.avatars);
  const reduce = useReducedMotion();
  const cameras = useCameras(members);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<OrbitScene | null>(null);
  const labelEls = useRef(new Map<string, HTMLElement>());
  const [hint, setHint] = useState(() => {
    try {
      return !localStorage.getItem(HINT_KEY);
    } catch {
      return false;
    }
  });
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  const center = members.find((m) => m.id === room.hostId) ?? null;
  const satellites = members.filter((m) => m !== center);

  const sceneMembers: SceneMember[] = useMemo(() => {
    const list: SceneMember[] = [];
    const base = (m: Member) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      look: m.planet ?? DEFAULT_PLANET,
      seed: textureSeed(m.id),
      photo: avatars[m.id],
      me: m.id === meId,
      speaking: !!speaking[m.id],
      live: !!m.live,
      video: cameras[m.id] ?? null,
      mirror: m.id === meId,
      pickable: true,
    });
    if (center) list.push({ ...base(center), orbit: null, host: true });
    else list.push({ id: '__sala__', name: room.name, color: hashColor(room.code), look: DEFAULT_PLANET, seed: textureSeed(room.code), orbit: null, host: false, me: false, speaking: false, live: false, video: null, mirror: false, pickable: false });
    satellites.forEach((m) => {
      const orbit = (m.id === meId ? myOrbit : m.orbit) ?? randomOrbit(m.id);
      list.push({ ...base(m), orbit, host: false });
    });
    return list;
  }, [center, satellites.map((m) => m.id).join('|'), members, room.name, room.code, avatars, meId, myOrbit, speaking, cameras]);

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  const placeLabels = (labels: LabelPos[]) => {
    for (const l of labels) {
      const el = labelEls.current.get(l.id);
      if (!el) continue;
      el.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px) translateX(-50%)`;
      el.style.opacity = l.behind ? '0.6' : '1';
      el.style.zIndex = l.behind ? '1' : '3';
    }
  };

  // a cena 3D
  useLayoutEffect(() => {
    if (!host.current) return;
    const s = new OrbitScene(host.current, {
      compact,
      skySeed: textureSeed(room.code),
      still: false,
      frozen: reduce,
      onPick: (id) => {
        const m = byIdRef.current.get(id);
        if (m) pickRef.current(m, labelEls.current.get(id) ?? host.current!);
      },
      onOrbit: (orbit) => {
        setMyOrbit(orbit);
        try {
          localStorage.setItem(HINT_KEY, '1');
        } catch {
          /* sem armazenamento */
        }
        setHint(false);
      },
      onLabels: placeLabels,
    });
    scene.current = s;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>)[compact ? '__orbitaSceneCompact' : '__orbitaScene'] = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
  }, [compact, reduce, room.code]);

  useEffect(() => {
    scene.current?.setMembers(sceneMembers);
  }, [sceneMembers]);

  const labelFor = (m: SceneMember) => {
    const member = byId.get(m.id);
    if (!member) {
      return (
        <div key={m.id} ref={(el) => void (el ? labelEls.current.set(m.id, el) : labelEls.current.delete(m.id))} className="orbit3d__label is-room">
          <span className="orbit3d__name">{m.name}</span>
          {!compact && <span className="orbit3d__sub">{members.length ? 'o host não está na chamada' : 'ninguém em órbita ainda'}</span>}
        </div>
      );
    }
    const muted = member.serverMuted || !member.micOn || member.deafened;
    return (
      <button
        key={m.id}
        type="button"
        ref={(el) => void (el ? labelEls.current.set(m.id, el) : labelEls.current.delete(m.id))}
        className={cx('orbit3d__label', m.host && 'is-host', member.reconnecting && 'is-away')}
        aria-label={member.live ? `${member.name}: assistir live` : member.cameraOn ? `${member.name}: ver câmera` : member.name}
        onClick={(e) => onPick(member, e.currentTarget)}
      >
        <span className="orbit3d__name">
          {member.live && <span className="live-dot" />}
          {member.name}
          {muted && <MicOff size={12} />}
        </span>
        {m.host && !compact && (
          <span className="orbit3d__sub">
            {member.live ? (
              <span className="live-badge">AO VIVO</span>
            ) : (
              <>
                <Crown size={12} /> host · centro da órbita
              </>
            )}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className={cx('orbit3d', compact && 'orbit3d--compact')} ref={host}>
      <div className="orbit3d__labels">{sceneMembers.map(labelFor)}</div>
      <div className="orbit3d__tools">
        <OrbitModeSwitch compact={compact} />
        <button type="button" className="orbit3d__tool" title="Voltar a câmera para o ângulo padrão (ou dois cliques no fundo)" aria-label="Centralizar a câmera" onClick={() => scene.current?.resetCamera()}>
          <RotateCcw size={14} />
        </button>
        {hint && !compact && satellites.some((m) => m.id === meId) && (
          <span className="orbit3d__hint">Arraste o fundo para girar · arraste seu planeta e solte com um empurrão para mudar sua órbita</span>
        )}
      </div>
    </div>
  );
}
