import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Crown,
  Eye,
  HeadphoneOff,
  Headphones,
  LayoutGrid,
  LoaderCircle,
  Maximize,
  MessageSquare,
  Mic,
  MicOff,
  Orbit,
  Phone,
  PhoneOff,
  PictureInPicture2,
  Radio,
  ScreenShare,
  Settings2,
  Square,
  SquareArrowOutUpRight,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  joinCall,
  leaveCall,
  openLive,
  setLiveVolume,
  stopLive,
  toggleCamera,
  toggleChat,
  toggleDeafen,
  toggleLiveMute,
  toggleMic,
  unwatchLive,
  watchLive,
} from '../controller';
import { baseId } from '../lib/hub';
import { comboLabel } from '../lib/keybinds';
import type { Member, RoomState } from '../lib/protocol';
import { hashColor, roomInitials } from '../lib/util';
import { setApp, useApp, voiceChannelOf } from '../store';
import { canFloat, openFloating } from './Floating';
import { FxBar, FxLayer } from './LiveFx';
import { openMemberCard } from './MemberCard';
import { Planet } from './Planet';
import { cx, IconButton, useReducedMotion, VideoEl } from './ui';

const EMPTY: Member[] = [];

export function CallView() {
  const room = useApp((s) => s.room);
  const inCall = useApp((s) => s.inCall);
  const joining = useApp((s) => s.joiningVoice);
  const layout = useApp((s) => s.callLayout);
  if (!room) return null;
  const callId = voiceChannelOf(room)?.id;
  const members = room.members.filter((m) => !!callId && m.voiceChannelId === callId);
  // automático: órbita enquanto ninguém tem vídeo; grade quando aparece câmera ou live
  const effective = layout === 'auto' ? (members.some((m) => m.cameraOn || m.live) ? 'grid' : 'orbit') : layout;

  const pick = (member: Member, anchor: Element) => {
    if (member.live) openLive(member.id);
    else openMemberCard(member.id, anchor);
  };

  return (
    <section className="call">
      <StageHeader room={room} count={members.length} layout={effective} />
      <div className="call__stage">
        {effective === 'orbit' ? <OrbitStage members={members} room={room} onPick={pick} /> : <CallGrid members={members} />}
      </div>
      {inCall ? (
        <CallControls />
      ) : (
        <div className="call__join">
          <button type="button" className="btn btn--primary btn--lg" disabled={joining} onClick={() => void joinCall()}>
            {joining ? <LoaderCircle size={18} className="spin" /> : <Phone size={18} />} Entrar na chamada
          </button>
          <span className="call__join-hint">Dá para conversar no chat e assistir lives sem entrar na chamada.</span>
        </div>
      )}
    </section>
  );
}

function StageHeader({ room, count, layout }: { room: RoomState; count: number; layout: 'grid' | 'orbit' }) {
  const chatOpen = useApp((s) => s.chatOpen);
  const unread = useApp((s) => s.unread);
  const mentions = useApp((s) => s.mentions);
  return (
    <header className="stage-header">
      <button type="button" className="stage-header__people" aria-label="Pessoas na órbita" onClick={() => setApp({ peopleOpen: true })}>
        <Users size={20} />
      </button>
      <div className="stage-header__title">
        <h1>
          <span className="stage-header__room">{room.name}</span>
          <span className="stage-header__call">Chamada</span>
        </h1>
        <span className="stage-header__sub">
          <Volume2 size={13} /> {count ? `${count} na chamada` : 'ninguém na chamada'}
        </span>
      </div>
      <div className="stage-header__tools">
        <div className="seg" role="tablist" aria-label="Visualização">
          <button type="button" role="tab" aria-selected={layout === 'orbit'} className={cx(layout === 'orbit' && 'is-on')} onClick={() => setApp({ callLayout: 'orbit' })}>
            <Orbit size={15} /> <span>Órbita</span>
          </button>
          <button type="button" role="tab" aria-selected={layout === 'grid'} className={cx(layout === 'grid' && 'is-on')} onClick={() => setApp({ callLayout: 'grid' })}>
            <LayoutGrid size={15} /> <span>Grade</span>
          </button>
        </div>
        <IconButton label="Convidar" tipPos="bottom" onClick={() => setApp({ modal: { kind: 'invite' } })}>
          <UserPlus size={20} />
        </IconButton>
        <IconButton label={chatOpen ? 'Esconder o chat' : 'Mostrar o chat'} tipPos="bottom" active={chatOpen} onClick={toggleChat}>
          <MessageSquare size={20} />
          {!chatOpen && unread > 0 && <span className={cx('count-badge', mentions > 0 && 'is-mention')}>{mentions || (unread > 99 ? '99+' : unread)}</span>}
        </IconButton>
      </div>
    </header>
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

function OrbitStage({ members, room, onPick }: { members: Member[]; room: RoomState; onPick: (member: Member, anchor: Element) => void }) {
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
            <span className="orbit__center-name">{room.name}</span>
            <span className="orbit__center-sub is-muted">{members.length ? 'o host não está na chamada' : 'ninguém em órbita ainda'}</span>
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
          aria-label={m.live ? `${m.name}: assistir live` : m.name}
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
        <p className="muted">Ninguém na chamada ainda.</p>
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

function Tile({ spec, big }: { spec: TileSpec; big?: boolean }) {
  const m = spec.member;
  const meId = useApp((s) => s.meId);
  const hostId = useApp((s) => s.room?.hostId);
  const members = useApp((s) => s.room?.members ?? EMPTY);
  const speaking = useApp((s) => !!s.speaking[m.id]);
  const voiceStream = useApp((s) => s.voiceStreams[m.id]);
  const liveStream = useApp((s) => s.liveStreams[m.id]);
  const localCamera = useApp((s) => s.localCamera);
  const localScreen = useApp((s) => s.localScreen);
  const watching = useApp((s) => !!s.watching[m.id]);
  const focus = useApp((s) => s.focus);
  const tool = useApp((s) => s.tool);
  const floatTipClosed = useApp((s) => s.floatTipClosed);
  const floating = useApp((s) => s.floating);
  const ref = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isMe = m.id === meId;
  const muted = m.serverMuted || !m.micOn || m.deafened;

  let stream: MediaStream | null | undefined = null;
  if (spec.kind === 'cam') stream = m.cameraOn ? (isMe ? localCamera : voiceStream) : null;
  else stream = isMe ? localScreen : watching ? liveStream : null;
  const showVideo = !!stream && stream.getVideoTracks().length > 0;
  const live = spec.kind === 'live' ? m.live : null;
  const effects = !!live && (live.effects || isMe);

  const toggleFocus = () => setApp({ focus: focus === spec.id ? null : spec.id });
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void ref.current?.requestFullscreen?.().catch(() => {});
  };
  const pip = () => {
    const video = videoRef.current;
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
        <VideoEl stream={stream} mirror={spec.kind === 'cam' && isMe} contain={spec.kind === 'live'} videoRef={spec.kind === 'live' ? videoRef : undefined} />
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

      {live && showVideo && effects && <FxLayer streamerId={m.id} videoRef={videoRef} members={members} tool={!!big || focus === spec.id ? tool : null} />}

      <div className="tile__label">
        {m.id === hostId && <Crown size={13} className="gold" />}
        <span className="tile__name">
          {m.name}
          {isMe && ' (você)'}
        </span>
        {spec.kind === 'live' && <span className="live-badge">AO VIVO</span>}
        {spec.kind === 'cam' && muted && <MicOff size={14} />}
      </div>

      {live && (
        <div className="tile__tools" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <span className="tile__viewers" title="Espectadores">
            <Eye size={13} /> {live.viewers}
          </span>
          {!isMe && watching && <LiveVolume member={m} />}
          {isMe && (
            <IconButton label="Opções da live" tipPos="bottom" onClick={() => setApp({ modal: { kind: 'live' } })}>
              <Settings2 size={16} />
            </IconButton>
          )}
          {isMe && canFloat() && (
            <IconButton label={floating ? 'Janela flutuante aberta' : 'Janela flutuante (sempre por cima)'} tipPos="bottom" active={floating} onClick={() => void openFloating()}>
              <SquareArrowOutUpRight size={16} />
            </IconButton>
          )}
          {showVideo && !isMe && (
            <IconButton label="Picture-in-picture" tipPos="bottom" onClick={pip}>
              <PictureInPicture2 size={16} />
            </IconButton>
          )}
          <IconButton label="Tela cheia" tipPos="bottom" onClick={fullscreen}>
            <Maximize size={16} />
          </IconButton>
          {isMe ? (
            <IconButton label="Encerrar live" tipPos="bottom" className="is-danger" onClick={stopLive}>
              <Square size={15} />
            </IconButton>
          ) : (
            watching && (
              <IconButton label="Parar de assistir" tipPos="bottom" onClick={() => unwatchLive(m.id)}>
                <X size={16} />
              </IconButton>
            )
          )}
        </div>
      )}

      {live && showVideo && effects && (!isMe || floatTipClosed || floating || !canFloat()) && <FxBar streamerId={m.id} />}
      {live && isMe && !floatTipClosed && !floating && canFloat() && (
        <div className="float-tip" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <span>Veja o laser e os desenhos por cima do jogo</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void openFloating()}>
            <SquareArrowOutUpRight size={14} /> Abrir janela flutuante
          </button>
          <IconButton label="Fechar dica" onClick={() => setApp({ floatTipClosed: true })}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** Volume da live (separado do volume da voz da pessoa). */
function LiveVolume({ member }: { member: Member }) {
  const volume = useApp((s) => s.liveVolumes[baseId(member.id)] ?? 100);
  const muted = useApp((s) => !!s.liveMutes[member.id]);
  const hasAudio = !!member.live?.audio;
  const value = muted ? 0 : volume;
  if (!hasAudio) {
    return (
      <span className="live-volume is-disabled" data-tip="Esta live está sem som" data-tip-pos="bottom">
        <VolumeX size={16} />
      </span>
    );
  }
  return (
    <div className="live-volume">
      <button type="button" className="icon-btn" aria-label={value === 0 ? 'Ativar o som da live' : 'Silenciar a live'} onClick={() => toggleLiveMute(member.id)}>
        {value === 0 ? <VolumeX size={16} /> : value < 50 ? <Volume1 size={16} /> : <Volume2 size={16} />}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label="Volume da live"
        style={{ '--fill': `${value}%` } as CSSProperties}
        onChange={(e) => setLiveVolume(member.id, Number(e.target.value))}
      />
      <span className="live-volume__value">{value}%</span>
    </div>
  );
}

// ───────────────────────── controles ─────────────────────────

function CallControls() {
  const micOn = useApp((s) => s.micOn);
  const deafened = useApp((s) => s.deafened);
  const cameraOn = useApp((s) => s.cameraOn);
  const live = useApp((s) => s.live);
  const ptt = useApp((s) => s.settings.voiceMode === 'ptt');
  const pttKey = useApp((s) => s.settings.keybinds.pushToTalk);
  const pttDown = useApp((s) => s.pttDown);
  const serverMuted = useApp((s) => !!s.room?.members.find((m) => m.id === s.meId)?.serverMuted);
  const muted = !micOn || deafened || serverMuted;
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const micTip = serverMuted
    ? 'Silenciado pelo host'
    : muted
      ? 'Ativar microfone'
      : ptt
        ? pttKey
          ? `Segure ${comboLabel(pttKey)} para falar`
          : 'Escolha a tecla de falar em Configurações › Atalhos'
        : 'Silenciar';
  return (
    <div className="call-controls">
      <button
        type="button"
        className={cx('ctrl', muted && 'is-off', ptt && !muted && pttDown && 'is-talking')}
        data-tip={micTip}
        aria-label={muted ? 'Ativar microfone' : 'Silenciar'}
        onClick={toggleMic}
      >
        {muted ? <MicOff /> : <Mic />}
        {ptt && !muted && <span className="ctrl__tag">{pttDown ? 'falando' : 'PTT'}</span>}
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
        data-tip={!canShare ? 'Seu navegador não compartilha a tela' : live ? 'Opções da live' : 'Iniciar live'}
        aria-label={live ? 'Opções da live' : 'Iniciar live'}
        disabled={!canShare}
        onClick={() => setApp({ modal: { kind: 'live' } })}
      >
        <ScreenShare />
        {live && <span className="ctrl__tag ctrl__tag--live">AO VIVO</span>}
      </button>
      <button type="button" className="ctrl ctrl--leave" data-tip="Sair da chamada" aria-label="Sair da chamada" onClick={() => leaveCall()}>
        <PhoneOff />
      </button>
    </div>
  );
}
