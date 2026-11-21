import { sanitizeOrbit } from './orbitPath';
import { sanitizePlanet } from './planet';
import type { ChatMessage, Member, RoomState } from './protocol';
import { sanitizeColor, sanitizeName, sanitizeRoomName } from './util';

/**
 * O host é só mais uma pessoa: quem participa não confia cegamente no que o hub manda. O hub
 * honesto já valida tudo; aqui, cada participante confere de novo os campos que acabam em cor,
 * estilo, imagem ou link na tela, para um host malicioso (ou alguém que virou host numa
 * migração) não conseguir injetar nada.
 *
 * Quando nada precisa mudar, o objeto original volta intacto (as telas não redesenham à toa).
 */

const IMAGE_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function cleanMember(m: Member): Member {
  const name = sanitizeName(m.name);
  const color = sanitizeColor(m.color);
  const planet = m.planet === undefined ? undefined : sanitizePlanet(m.planet);
  const orbit = m.orbit === undefined ? undefined : sanitizeOrbit(m.orbit);
  if (name === m.name && color === m.color && same(planet, m.planet) && same(orbit, m.orbit)) return m;
  return { ...m, name, color, planet, orbit };
}

/** Estado da sala vindo do hub. */
export function cleanState(state: RoomState): RoomState {
  const members = Array.isArray(state.members) ? state.members.filter((m) => !!m && typeof m === 'object' && typeof m.id === 'string') : [];
  let changed = members.length !== state.members?.length;
  const clean = members.map((m) => {
    const c = cleanMember(m);
    if (c !== m) changed = true;
    return c;
  });
  const name = sanitizeRoomName(state.name);
  if (name !== state.name) changed = true;
  return changed ? { ...state, name, members: clean } : state;
}

/** Mensagem do chat vinda do hub (null = descartar). */
export function cleanMessage(msg: ChatMessage): ChatMessage | null {
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return null;
  let out = msg;
  const color = sanitizeColor(msg.authorColor);
  if (color !== msg.authorColor) out = { ...out, authorColor: color };
  if (typeof msg.text !== 'string') out = { ...out, text: '' };
  const a = msg.attachment;
  if (a) {
    if (a.kind === 'image') {
      // só imagem embutida: nada de link para fora nem javascript: no botão de baixar
      if (typeof a.dataUrl !== 'string' || (a.dataUrl && !IMAGE_URL.test(a.dataUrl))) out = { ...out, attachment: { ...a, dataUrl: '' } };
    } else if (a.kind !== 'file') {
      out = { ...out, attachment: undefined };
    }
  }
  return out;
}

export const cleanMessages = (messages: ChatMessage[]) => (Array.isArray(messages) ? messages.map(cleanMessage).filter((m): m is ChatMessage => !!m) : []);
