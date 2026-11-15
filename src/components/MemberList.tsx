import { Ban, Crown, Mic, MicOff, Radio, UserX, Volume2, VolumeX } from 'lucide-react';
import { kick, openLive, serverMute, setVolume, toggleLocalMute, transferHost } from '../controller';
import { baseId } from '../lib/hub';
import type { Member } from '../lib/protocol';
import { formatTime, shade } from '../lib/util';
import { setApp, useApp } from '../store';
import { Planet } from './Planet';
import { cx } from './ui';

/** Abre o cartão de um membro ao lado do elemento clicado. */
export function openMemberCard(memberId: string, anchor: Element) {
  const rect = anchor.getBoundingClientRect();
  setApp({ memberCard: { memberId, x: rect.left, y: rect.top } });
}

export function MemberList() {
  const room = useApp((s) => s.room);
  const speaking = useApp((s) => s.speaking);
  if (!room) return null;
  const host = room.members.find((m) => m.id === room.hostId);
  const others = room.members.filter((m) => m.id !== room.hostId);
  return (
    <aside className="members" aria-label="Membros">
      <div className="members__scroll">
        <h3 className="members__title members__title--host">
          <Crown size={12} /> Centro da órbita
        </h3>
        {host ? <MemberRow member={host} host speaking={!!speaking[host.id]} /> : <p className="members__empty">Escolhendo um novo host…</p>}
        <h3 className="members__title">Em órbita — {others.length}</h3>
        {others.map((m) => (
          <MemberRow key={m.id} member={m} speaking={!!speaking[m.id]} />
        ))}
        {!others.length && (
          <p className="members__empty">
            Ninguém orbitando ainda.{' '}
            <button type="button" className="link-btn" onClick={() => setApp({ modal: { kind: 'invite' } })}>
              Convidar alguém
            </button>
          </p>
        )}
      </div>
    </aside>
  );
}

function MemberRow({ member, host, speaking }: { member: Member; host?: boolean; speaking: boolean }) {
  const channelName = useApp((s) =>
    member.voiceChannelId ? (s.room?.channels.find((c) => c.id === member.voiceChannelId)?.name ?? '') : '',
  );
  const meId = useApp((s) => s.meId);
  return (
    <button
      type="button"
      className={cx('member', member.reconnecting && 'is-away')}
      onClick={(e) => openMemberCard(member.id, e.currentTarget)}
    >
      <Planet name={member.name} color={member.color} size={34} host={host} speaking={speaking} live={!!member.live} />
      <span className="member__text">
        <span className={cx('member__name', host && 'is-host')}>
          {member.name}
          {member.id === meId && <span className="muted"> (você)</span>}
        </span>
        <span className="member__status">
          {member.reconnecting ? (
            'Reconectando…'
          ) : member.live ? (
            <span className="live-text">● Ao vivo</span>
          ) : channelName ? (
            <>
              <Volume2 size={12} /> {channelName}
            </>
          ) : (
            'Online'
          )}
        </span>
      </span>
    </button>
  );
}

export function MemberCard() {
  const card = useApp((s) => s.memberCard);
  const member = useApp((s) => (s.memberCard ? s.room?.members.find((m) => m.id === s.memberCard?.memberId) : undefined));
  const meId = useApp((s) => s.meId);
  const hostId = useApp((s) => s.room?.hostId);
  const isHost = useApp((s) => s.isHost);
  const volumes = useApp((s) => s.volumes);
  const localMute = useApp((s) => (s.memberCard ? !!s.localMutes[s.memberCard.memberId] : false));
  if (!card || !member) return null;

  const isMe = member.id === meId;
  const width = 300;
  const left = card.x > window.innerWidth / 2 ? card.x - width - 12 : card.x + 56;
  const top = Math.max(12, Math.min(card.y - 20, window.innerHeight - 440));
  const volume = volumes[baseId(member.id)] ?? 100;
  const close = () => setApp({ memberCard: null });
  const confirm = (title: string, body: string, label: string, action: () => void) =>
    setApp({ memberCard: null, modal: { kind: 'confirm', title, body, confirm: label, danger: true, action } });

  return (
    <div className="popover-backdrop" onMouseDown={close}>
      <div
        className="member-card"
        style={{ left: Math.max(12, Math.min(left, window.innerWidth - width - 12)), top, width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="member-card__banner" style={{ background: `linear-gradient(135deg, ${member.color}, ${shade(member.color, -0.65)})` }} />
        <Planet name={member.name} color={member.color} size={84} host={member.id === hostId} className="member-card__planet" />
        <div className="member-card__body">
          <h3>
            {member.name} {isMe && <span className="muted">(você)</span>}
          </h3>
          <p className="muted small">
            {member.id === hostId ? '👑 Host — o centro desta órbita' : `Em órbita desde ${formatTime(member.joinedAt)}`}
            {member.reconnecting && ' · reconectando…'}
          </p>

          {member.live && !isMe && (
            <button type="button" className="btn btn--live btn--sm" onClick={() => openLive(member.id)}>
              <Radio size={14} /> Assistir live
            </button>
          )}

          {!isMe && (
            <div className="member-card__section">
              <label className="field">
                <span>Volume para você — {volume}%</span>
                <input type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(member.id, Number(e.target.value))} />
              </label>
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
                  confirm(`Remover ${member.name}?`, 'A pessoa sai da órbita, mas pode voltar pelo convite.', 'Remover', () =>
                    kick(member.id, false),
                  )
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
