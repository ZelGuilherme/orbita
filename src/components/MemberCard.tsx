import type { CSSProperties } from 'react';
import { Ban, Crown, Mic, MicOff, Pencil, Radio, UserX, Volume2, VolumeX } from 'lucide-react';
import { kick, openLive, serverMute, setLiveVolume, setVolume, toggleLocalMute, transferHost } from '../controller';
import { baseId } from '../lib/hub';
import { MAX_VOLUME, VOLUME_STEP, volumeLabel } from '../lib/playback';
import { formatTime, shade } from '../lib/util';
import { setApp, useApp } from '../store';
import { Planet } from './Planet';
import { cx } from './ui';

/** Abre o cartão de um membro ao lado do elemento clicado. */
export function openMemberCard(memberId: string, anchor: Element) {
  const rect = anchor.getBoundingClientRect();
  setApp({ memberCard: { memberId, x: rect.left, y: rect.top } });
}

export function MemberCard() {
  const card = useApp((s) => s.memberCard);
  const member = useApp((s) => (s.memberCard ? s.room?.members.find((m) => m.id === s.memberCard?.memberId) : undefined));
  const meId = useApp((s) => s.meId);
  const hostId = useApp((s) => s.room?.hostId);
  const isHost = useApp((s) => s.isHost);
  const volumes = useApp((s) => s.volumes);
  const liveVolumes = useApp((s) => s.liveVolumes);
  const liveMuted = useApp((s) => (s.memberCard ? !!s.liveMutes[s.memberCard.memberId] : false));
  const localMute = useApp((s) => (s.memberCard ? !!s.localMutes[s.memberCard.memberId] : false));
  if (!card || !member) return null;

  const isMe = member.id === meId;
  const width = 300;
  const height = isMe ? 260 : isHost ? 520 : 360;
  const left = card.x > window.innerWidth / 2 ? card.x - width - 12 : card.x + 56;
  const top = Math.max(12, Math.min(card.y - 20, window.innerHeight - height - 12));
  const volume = volumes[baseId(member.id)] ?? 100;
  const liveVolume = liveMuted ? 0 : (liveVolumes[baseId(member.id)] ?? 100);
  const close = () => setApp({ memberCard: null });
  const confirm = (title: string, body: string, label: string, action: () => void) =>
    setApp({ memberCard: null, modal: { kind: 'confirm', title, body, confirm: label, danger: true, action } });

  return (
    <div className="popover-backdrop" onMouseDown={close}>
      <div
        className="member-card"
        role="dialog"
        aria-label={member.name}
        style={{ left: Math.max(12, Math.min(left, window.innerWidth - width - 12)), top, width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="member-card__banner" style={{ background: `linear-gradient(135deg, ${member.color}, ${shade(member.color, -0.65)})` }} />
        <Planet memberId={member.id} name={member.name} color={member.color} size={84} host={member.id === hostId} className="member-card__planet" />
        <div className="member-card__body">
          <h3>
            {member.name} {isMe && <span className="muted">(você)</span>}
          </h3>
          <p className="muted small">
            {member.id === hostId ? '👑 Host — o centro desta órbita' : `Em órbita desde ${formatTime(member.joinedAt)}`}
            {member.reconnecting && ' · reconectando…'}
          </p>

          {isMe && (
            <button type="button" className="btn btn--sm" onClick={() => setApp({ memberCard: null, modal: { kind: 'settings', tab: 'perfil' } })}>
              <Pencil size={14} /> Editar perfil
            </button>
          )}

          {member.live && !isMe && (
            <button type="button" className="btn btn--live btn--sm" onClick={() => openLive(member.id)}>
              <Radio size={14} /> Assistir live
            </button>
          )}

          {!isMe && (
            <div className="member-card__section">
              <label className="field">
                <span>Volume da voz: {volumeLabel(volume)}</span>
                <input
                  type="range"
                  min={0}
                  max={MAX_VOLUME}
                  step={VOLUME_STEP}
                  value={volume}
                  style={{ '--fill': `${(volume / MAX_VOLUME) * 100}%` } as CSSProperties}
                  onChange={(e) => setVolume(member.id, Number(e.target.value))}
                />
              </label>
              {member.live && (
                <label className="field">
                  <span>Volume da live: {volumeLabel(liveVolume)}</span>
                  <input
                    type="range"
                    min={0}
                    max={MAX_VOLUME}
                    step={VOLUME_STEP}
                    value={liveVolume}
                    style={{ '--fill': `${(liveVolume / MAX_VOLUME) * 100}%` } as CSSProperties}
                    onChange={(e) => setLiveVolume(member.id, Number(e.target.value))}
                  />
                </label>
              )}
              <button type="button" className={cx('card-action', localMute && 'is-on')} onClick={() => toggleLocalMute(member.id)}>
                {localMute ? <VolumeX size={16} /> : <Volume2 size={16} />}
                {localMute ? 'Voltar a ouvir' : 'Silenciar só para mim'}
              </button>
            </div>
          )}

          {isHost && !isMe && (
            <div className="member-card__section">
              <span className="member-card__label">Ações do host</span>
              <button type="button" className="card-action" onClick={() => serverMute(member.id, !member.serverMuted)}>
                {member.serverMuted ? <Mic size={16} /> : <MicOff size={16} />}
                {member.serverMuted ? 'Liberar microfone' : 'Silenciar para todos'}
              </button>
              <button
                type="button"
                className="card-action"
                disabled={member.reconnecting}
                onClick={() =>
                  confirm(
                    `Passar o host para ${member.name}?`,
                    `${member.name} vira o centro da órbita e passa a comandar a sala. Você continua aqui como membro.`,
                    'Passar a coroa',
                    () => transferHost(member.id),
                  )
                }
              >
                <Crown size={16} /> Tornar host
              </button>
              <button
                type="button"
                className="card-action danger"
                onClick={() =>
                  confirm(`Remover ${member.name}?`, 'A pessoa sai da órbita, mas pode voltar pelo convite.', 'Remover', () => kick(member.id, false))
                }
              >
                <UserX size={16} /> Remover da órbita
              </button>
              <button
                type="button"
                className="card-action danger"
                onClick={() =>
                  confirm(`Banir ${member.name}?`, 'A pessoa sai e não consegue voltar enquanto esta órbita existir.', 'Banir', () =>
                    kick(member.id, true),
                  )
                }
              >
                <Ban size={16} /> Banir
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
