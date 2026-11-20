import { DoorOpen, LoaderCircle, Lock, Pin, RotateCcw, Trash2, Users, X } from 'lucide-react';
import { answerKnock, cancelKnock, forgetRoom, knockRoom, reopenRoom } from '../controller';
import { formatDay } from '../lib/util';
import { useApp } from '../store';
import { Planet } from './Planet';
import { cx } from './ui';

/** Tela inicial: órbitas abertas. "Pedir para entrar" avisa o host; o código só vem se ele aceitar. */
export function LobbyList() {
  const rooms = useApp((s) => s.lobbyRooms);
  const online = useApp((s) => s.lobbyOnline);
  const knocking = useApp((s) => s.knocking);
  return (
    <section className="lobby" aria-label="Órbitas abertas">
      <header className="lobby__head">
        <h2>Órbitas no ar</h2>
        <span className={cx('lobby__status', online && 'is-online')}>{online ? `${rooms.length} na lista` : 'procurando…'}</span>
      </header>
      {knocking && (
        <div className="lobby__waiting" role="status">
          <LoaderCircle size={16} className="spin" />
          <span>
            Esperando o host de <b>{knocking.roomName}</b> responder…
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={cancelKnock}>
            Cancelar
          </button>
        </div>
      )}
      {rooms.length === 0 ? (
        <p className="lobby__empty">{online ? 'Nenhuma órbita aberta na lista agora. Crie a sua!' : 'Conectando à lista de órbitas…'}</p>
      ) : (
        <ul className="lobby__list">
          {rooms.map((room) => (
            <li key={room.id} className="lobby-room">
              <Planet name={room.hostName} color={room.hostColor} size={36} host />
              <div className="lobby-room__text">
                <span className="lobby-room__name">
                  {room.locked && <Lock size={13} aria-label="Trancada" />}
                  {room.name}
                </span>
                <span className="lobby-room__meta">
                  host: {room.hostName} · <Users size={12} /> {room.members}
                </span>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                disabled={room.locked || !!knocking}
                title={room.locked ? 'O host trancou esta órbita' : undefined}
                onClick={() => void knockRoom(room.id)}
              >
                <DoorOpen size={14} /> {room.locked ? 'Trancada' : 'Pedir para entrar'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="lobby__hint">A lista mostra só o nome da sala e do host. O código vai direto do host para você, se ele aceitar.</p>
    </section>
  );
}

/** Host: quem está pedindo para entrar. */
export function KnockRequests() {
  const knocks = useApp((s) => s.knocks);
  if (!knocks.length) return null;
  return (
    <div className="knocks" role="region" aria-label="Pedidos para entrar">
      {knocks.map((k) => (
        <div key={k.knockId} className="knock" role="alert">
          <Planet name={k.name} color={k.color} size={34} />
          <span className="knock__text">
            <b>{k.name}</b> quer entrar na órbita
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => answerKnock(k.knockId, false)}>
            <X size={14} /> Recusar
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => answerKnock(k.knockId, true)}>
            Aceitar
          </button>
        </div>
      ))}
    </div>
  );
}

/** Tela inicial: as órbitas fixas que este navegador conhece (dá para reabrir pelo mesmo link). */
export function FixedRoomsList() {
  const rooms = useApp((s) => s.fixedRooms);
  const me = useApp((s) => s.profile.id);
  if (!rooms.length) return null;
  return (
    <section className="lobby fixed-rooms" aria-label="Suas órbitas fixas">
      <header className="lobby__head">
        <h2>
          <Pin size={17} /> Suas órbitas fixas
        </h2>
        <span className="lobby__status">o mesmo link sempre</span>
      </header>
      <ul className="lobby__list">
        {rooms.map((room) => (
          <li key={room.code} className="lobby-room">
            <span className="fixed-rooms__icon" aria-hidden="true">
              <Pin size={18} />
            </span>
            <div className="lobby-room__text">
              <span className="lobby-room__name">
                {room.locked && <Lock size={13} aria-label="Trancada" />}
                {room.name}
              </span>
              <span className="lobby-room__meta">
                {room.ownerId === me ? 'criada por você' : 'você já entrou'} · código {room.code} · {formatDay(room.savedAt)}
              </span>
            </div>
            <button type="button" className="btn btn--sm" onClick={() => void reopenRoom(room.code)}>
              <RotateCcw size={14} /> Abrir
            </button>
            <button type="button" className="icon-btn" aria-label={`Esquecer ${room.name}`} title="Esquecer (tira da lista deste navegador)" onClick={() => forgetRoom(room.code)}>
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
      <p className="lobby__hint">“Abrir” entra se alguém já estiver lá; se estiver vazia, você reabre a sala (com o histórico) e vira o host. Quem criou recebe a coroa de volta ao chegar.</p>
    </section>
  );
}
