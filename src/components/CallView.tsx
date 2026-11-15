import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Crown,
  Eye,
  HeadphoneOff,
  Headphones,
  LayoutGrid,
  LoaderCircle,
  Maximize,
  Mic,
  MicOff,
  Orbit,
  Phone,
  PhoneOff,
  PictureInPicture2,
  Radio,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
  Volume2,
  X,
} from 'lucide-react';
import {
  joinVoice,
  leaveVoice,
  openLive,
  stopLive,
  toggleCamera,
  toggleDeafen,
  toggleMic,
  unwatchLive,
  watchLive,
} from '../controller';
import type { Member, RoomState } from '../lib/protocol';
import { hashColor, roomInitials } from '../lib/util';
import { setApp, useApp } from '../store';
import { ChannelHeader } from './ChatView';
import { openMemberCard } from './MemberList';
import { Planet } from './Planet';
import { cx, IconButton, useReducedMotion } from './ui';

export function CallView({ channelId }: { channelId: string }) {
  const room = useApp((s) => s.room);
  const voiceChannelId = useApp((s) => s.voiceChannelId);
  const joining = useApp((s) => s.joiningVoice);
  const layout = useApp((s) => s.callLayout);
  if (!room) return null;
  const channel = room.channels.find((c) => c.id === channelId);
  const members = room.members.filter((m) => m.voiceChannelId === channelId);
  const joined = voiceChannelId === channelId;
  // automático: órbita enquanto ninguém tem vídeo; grade quando aparece câmera ou live
  const effective = layout === 'auto' ? (members.some((m) => m.cameraOn || m.live) ? 'grid' : 'orbit') : layout;

  const pick = (member: Member, anchor: Element) => {
    if (member.live) openLive(member.id);
    else openMemberCard(member.id, anchor);
  };

  return (
    <section className="call">
      <ChannelHeader icon={<Volume2 size={22} />} title={channel?.name ?? 'Voz'}>
        <div className="seg" role="tablist" aria-label="Visualização">
          <button type="button" className={cx(effective === 'orbit' && 'is-on')} onClick={() => setApp({ callLayout: 'orbit' })}>
            <Orbit size={15} /> <span>Órbita</span>
          </button>
          <button type="button" className={cx(effective === 'grid' && 'is-on')} onClick={() => setApp({ callLayout: 'grid' })}>
            <LayoutGrid size={15} /> <span>Grade</span>
          </button>
        </div>
      </ChannelHeader>
      <div className="call__stage">
        {effective === 'orbit' ? (
          <OrbitStage members={members} room={room} channelName={channel?.name ?? ''} onPick={pick} />
        ) : (
          <CallGrid members={members} />
        )}
      </div>
      {joined ? (
        <CallControls />
      ) : (
        <div className="call__join">
          <button type="button" className="btn btn--primary btn--lg" disabled={joining} onClick={() => void joinVoice(channelId)}>
            {joining ? <LoaderCircle size={18} className="spin" /> : <Phone size={18} />} Entrar na chamada
          </button>
        </div>
      )}
    </section>
  );
}

// ───────────────────────── visão em órbita ─────────────────────────

const TILT = 0.36;

function geometry(w: number, h: number, n: number) {
  const minSide = Math.max(1, Math.min(w, h));
  const planet = Math.round(Math.max(40, Math.min(68, minSide / 7.5)));
  const center = Math.round(Math.max(72, Math.min(150, minSide / 3.6)));
  // a órbita cabe na largura (com o nome embaixo do planeta) e na altura (achatada pela inclinação)
  const maxRx = Math.max(planet * 2, Math.min(w / 2 - planet * 0.9 - 24, (h / 2 - planet * 0.8 - 30) / TILT));
  const twoRings = n > 6;
  const inner = twoRings ? Math.ceil(n * 0.4) : n;
  const minRx = Math.min(maxRx, center * 0.62 + planet * 0.7);
  const radii = twoRings ? [Math.max(minRx, maxRx * 0.62), Math.max(minRx * 1.3, maxRx)] : [Math.max(minRx, maxRx * 0.86)];
  return { planet, center, radii, inner };
}

function place(g: ReturnType<typeof geometry>, i: number, n: number, t: number) {
  const ring = i < g.inner ? 0 : 1;
  const index = ring === 0 ? i : i - g.inner;
  const count = Math.max(1, ring === 0 ? g.inner : n - g.inner);
  const speed = ring === 0 ? 0.14 : -0.09;
  const angle = (index / count) * Math.PI * 2 + t * speed + (ring ? 0.4 : 0);
  const rx = g.radii[ring] ?? g.radii[0];
  const depth = Math.sin(angle);
  return {
    x: Math.cos(angle) * rx,
    y: depth * rx * TILT,
    front: depth > 0,
    scale: 0.8 + 0.2 * ((depth + 1) / 2),
    opacity: 0.7 + 0.3 * ((depth + 1) / 2),
  };
}

const transformOf = (p: ReturnType<typeof place>) =>
  `translate(-50%, -50%) translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${p.scale.toFixed(3)})`;

function OrbitStage({
  members,
  room,
  channelName,
  onPick,
}: {
  members: Member[];
  room: RoomState;
  channelName: string;
  onPick: (member: Member, anchor: Element) => void;
}) {
  const speaking = useApp((s) => s.speaking);
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const center = members.find((m) => m.id === room.hostId) ?? null;
  const satellites = members.filter((m) => m !== center);
  const n = satellites.length;
  const g = geometry(box.w, box.h, n);
  const key = satellites.map((m) => m.id).join('|');

  useEffect(() => {
    if (!box.w) return;
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = reduce ? 0 : (now - start) / 1000;
      satellites.forEach((m, i) => {
        const el = nodes.current.get(m.id);
        if (!el) return;
        const p = place(g, i, n, t);
        el.style.transform = transformOf(p);
        el.style.zIndex = p.front ? '4' : '1';
        el.style.opacity = p.opacity.toFixed(3);
      });
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // satellites, g e n derivam de key e box: as dependências abaixo bastam
  }, [key, box.w, box.h, reduce]);

  const cx0 = box.w / 2;
  const cy0 = box.h / 2;

  return (
    <div className="orbit" ref={ref}>
      <div className="orbit__glow" style={{ width: g.center * 2.6, height: g.center * 2.6 }} />
      {box.w > 0 && (
        <svg className="orbit__rings" width={box.w} height={box.h} aria-hidden="true">
          {g.radii.slice(0, n > 6 ? 2 : 1).map((rx, i) => (
            <ellipse key={i} cx={cx0} cy={cy0} rx={rx} ry={rx * TILT} />
          ))}
        </svg>
      )}

      <div className="orbit__center">
        {center ? (
          <button type="button" className="orbit__center-btn" onClick={(e) => onPick(center, e.currentTarget)}>
            <Planet name={center.name} color={center.color} size={g.center} host speaking={!!speaking[center.id]} live={!!center.live} />
            <span className="orbit__center-name">
              {center.name}
              {(center.serverMuted || !center.micOn || center.deafened) && <MicOff size={14} />}
            </span>
            <span className="orbit__center-sub">
              {center.live ? (
                <span className="live-badge">AO VIVO</span>
              ) : (
                <>
                  <Crown size={12} /> host · centro da órbita
                </>
              )}
            </span>
          </button>
        ) : (
          <div className="orbit__center-btn">
            <Planet name={room.name} color={hashColor(room.code)} size={g.center} text={roomInitials(room.name)} />
            <span className="orbit__center-name">{channelName}</span>
            <span className="orbit__center-sub is-muted">{members.length ? 'o host não está neste canal' : 'ninguém em órbita ainda'}</span>
          </div>
        )}
      </div>

      {satellites.map((m, i) => (
        <div
          key={m.id}
          ref={(el) => {
            if (el) nodes.current.set(m.id, el);
            else nodes.current.delete(m.id);
          }}
          className={cx('orbit__sat', m.reconnecting && 'is-away')}
          style={{ transform: transformOf(place(g, i, n, 0)) }}
          role="button"
          tabIndex={0}
          onClick={(e) => onPick(m, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onPick(m, e.currentTarget);
          }}
        >
          <Planet name={m.name} color={m.color} size={g.planet} speaking={!!speaking[m.id]} live={!!m.live} />
          <span className="orbit__label">
            {m.live && <span className="live-dot" />}
            {m.name}
            {(m.serverMuted || !m.micOn || m.deafened) && <MicOff size={12} />}
          </span>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── grade ─────────────────────────

interface TileSpec {
  id: string;
  kind: 'cam' | 'live';
  member: Member;
}

function columns(count: number, wide: boolean) {
  if (count <= 1) return 1;
  if (count <= 4) return wide ? 2 : 1;
  if (count <= 9) return wide ? 3 : 2;
  return wide ? 4 : 2;
}

function CallGrid({ members }: { members: Member[] }) {
  const focus = useApp((s) => s.focus);
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWide(el.clientWidth > 640);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tiles: TileSpec[] = [];
  for (const m of members) {
    if (m.live) tiles.push({ id: `live:${m.id}`, kind: 'live', member: m });
    tiles.push({ id: `cam:${m.id}`, kind: 'cam', member: m });
  }
  const focused = tiles.find((t) => t.id === focus);

  if (!tiles.length) {
    return (
      <div className="grid grid--empty" ref={ref}>
        <p className="muted">Ninguém neste canal ainda.</p>
      </div>
    );
  }

  if (focused) {
    return (
      <div className="grid grid--focus" ref={ref}>
        <div className="grid__main">
          <Tile spec={focused} big />
        </div>
        {tiles.length > 1 && (
          <div className="grid__strip">
            {tiles
              .filter((t) => t !== focused)
              .map((t) => (
                <Tile key={t.id} spec={t} />
              ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid" ref={ref} style={{ '--cols': columns(tiles.length, wide) } as CSSProperties}>
      {tiles.map((t) => (
        <Tile key={t.id} spec={t} />
      ))}
    </div>
  );
}

function VideoEl({ stream, mirror, contain }: { stream: MediaStream; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} className={cx('video', mirror && 'is-mirror', contain && 'is-contain')} autoPlay playsInline muted />;
}

function Tile({ spec, big }: { spec: TileSpec; big?: boolean }) {
  const m = spec.member;
  const meId = useApp((s) => s.meId);
  const hostId = useApp((s) => s.room?.hostId);
  const speaking = useApp((s) => !!s.speaking[m.id]);
  const voiceStream = useApp((s) => s.voiceStreams[m.id]);
  const liveStream = useApp((s) => s.liveStreams[m.id]);
  const localCamera = useApp((s) => s.localCamera);
  const localScreen = useApp((s) => s.localScreen);
  const watching = useApp((s) => !!s.watching[m.id]);
  const focus = useApp((s) => s.focus);
  const ref = useRef<HTMLDivElement>(null);
  const isMe = m.id === meId;
  const muted = m.serverMuted || !m.micOn || m.deafened;

  let stream: MediaStream | null | undefined = null;
  if (spec.kind === 'cam') stream = m.cameraOn ? (isMe ? localCamera : voiceStream) : null;
  else stream = isMe ? localScreen : watching ? liveStream : null;
  const showVideo = !!stream && stream.getVideoTracks().length > 0;

  const toggleFocus = () => setApp({ focus: focus === spec.id ? null : spec.id });
  const fullscreen = () => void ref.current?.requestFullscreen?.().catch(() => {});
  const pip = () => {
    const video = ref.current?.querySelector('video');
    if (video && document.pictureInPictureEnabled) void video.requestPictureInPicture().catch(() => {});
  };

  return (
    <div
      ref={ref}
      className={cx('tile', spec.kind === 'live' && 'tile--live', spec.kind === 'cam' && speaking && 'is-speaking', big && 'tile--big')}
      onClick={toggleFocus}
      onDoubleClick={fullscreen}
    >
      {showVideo && stream ? (
        <VideoEl stream={stream} mirror={spec.kind === 'cam' && isMe} contain={spec.kind === 'live'} />
      ) : spec.kind === 'cam' ? (
        <div className="tile__planet">
          <Planet name={m.name} color={m.color} size={big ? 128 : 76} speaking={speaking} host={m.id === hostId} />
        </div>
      ) : (
        <div className="live-placeholder">
          <Planet name={m.name} color={m.color} size={big ? 96 : 56} live />
          {watching ? (
            <span className="muted">
              <LoaderCircle size={16} className="spin" /> Conectando à live…
            </span>
          ) : (
            <button
              type="button"
              className="btn btn--live"
              onClick={(e) => {
                e.stopPropagation();
                watchLive(m.id);
                setApp({ focus: spec.id });
              }}
            >
              <Radio size={16} /> Assistir live
            </button>
          )}
        </div>
      )}

      <div className="tile__label">
        {m.id === hostId && <Crown size={13} className="gold" />}
        <span className="tile__name">
          {m.name}
          {isMe && ' (você)'}
        </span>
        {spec.kind === 'live' && <span className="live-badge">AO VIVO</span>}
        {spec.kind === 'cam' && muted && <MicOff size={14} />}
      </div>

      {spec.kind === 'live' && (
        <div className="tile__tools" onClick={(e) => e.stopPropagation()}>
          {m.live && (
            <span className="tile__viewers" title="Espectadores">
              <Eye size={13} /> {m.live.viewers}
            </span>
          )}
          {showVideo && !isMe && (
            <IconButton label="Picture-in-picture" tipPos="bottom" onClick={pip}>
              <PictureInPicture2 size={16} />
            </IconButton>
          )}
          <IconButton label="Tela cheia" tipPos="bottom" onClick={fullscreen}>
            <Maximize size={16} />
          </IconButton>
          {!isMe && watching && (
            <IconButton label="Parar de assistir" tipPos="bottom" onClick={() => unwatchLive(m.id)}>
              <X size={16} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── controles ─────────────────────────

function CallControls() {
  const micOn = useApp((s) => s.micOn);
  const deafened = useApp((s) => s.deafened);
  const cameraOn = useApp((s) => s.cameraOn);
  const live = useApp((s) => s.live);
  const serverMuted = useApp((s) => !!s.room?.members.find((m) => m.id === s.meId)?.serverMuted);
  const muted = !micOn || deafened || serverMuted;
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  return (
    <div className="call-controls">
      <button
        type="button"
        className={cx('ctrl', muted && 'is-off')}
        data-tip={serverMuted ? 'Silenciado pelo host' : muted ? 'Ativar microfone' : 'Silenciar'}
        aria-label={muted ? 'Ativar microfone' : 'Silenciar'}
        onClick={toggleMic}
      >
        {muted ? <MicOff /> : <Mic />}
      </button>
      <button
        type="button"
        className={cx('ctrl', deafened && 'is-off')}
        data-tip={deafened ? 'Ativar áudio' : 'Ensurdecer'}
        aria-label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
        onClick={toggleDeafen}
      >
        {deafened ? <HeadphoneOff /> : <Headphones />}
      </button>
      <button
        type="button"
        className={cx('ctrl', cameraOn && 'is-on')}
        data-tip={cameraOn ? 'Desligar câmera' : 'Ligar câmera'}
        aria-label={cameraOn ? 'Desligar câmera' : 'Ligar câmera'}
        onClick={() => void toggleCamera()}
      >
        {cameraOn ? <Video /> : <VideoOff />}
      </button>
      <button
        type="button"
        className={cx('ctrl', live && 'is-live')}
        data-tip={!canShare ? 'Seu navegador não compartilha tela' : live ? 'Encerrar live' : 'Iniciar live'}
        aria-label={live ? 'Encerrar live' : 'Iniciar live'}
        disabled={!canShare}
        onClick={() => (live ? stopLive() : setApp({ modal: { kind: 'golive' } }))}
      >
        {live ? <ScreenShareOff /> : <ScreenShare />}
      </button>
      <button type="button" className="ctrl ctrl--leave" data-tip="Sair da chamada" aria-label="Sair da chamada" onClick={() => leaveVoice()}>
        <PhoneOff />
      </button>
    </div>
  );
}
