import type { SavedRoom } from './hub';
import type { ChatMessage } from './protocol';

/**
 * Órbitas fixas guardadas neste navegador (de quem criou e de quem já entrou): nome,
 * configurações, banidos, histórico do chat e fixadas. Só aqui, sem servidor. Imagens antigas
 * não são guardadas (ficam como "imagem antiga").
 */

const KEY = 'orbita.fixed.v1';
const MAX_ROOMS = 10;
const MAX_MESSAGES = 200;

function readAll(): SavedRoom[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.code === 'string' && typeof r.name === 'string') : [];
  } catch {
    return [];
  }
}

function writeAll(rooms: SavedRoom[]) {
  let list = rooms.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_ROOMS);
  // sem espaço: vai largando as mais antigas
  while (list.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return;
    } catch {
      list = list.slice(0, -1);
    }
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* sem armazenamento */
  }
}

export const listFixedRooms = (): SavedRoom[] => readAll().sort((a, b) => b.savedAt - a.savedAt);

export const getFixedRoom = (code: string): SavedRoom | undefined => readAll().find((r) => r.code === code);

/** Guarda (ou atualiza) a cópia de uma órbita fixa. */
export function saveFixedRoom(room: SavedRoom) {
  const light: ChatMessage[] = room.messages.slice(-MAX_MESSAGES).map((m) =>
    m.attachment?.kind === 'image' && m.attachment.dataUrl ? { ...m, attachment: { ...m.attachment, dataUrl: '' } } : m,
  );
  writeAll([...readAll().filter((r) => r.code !== room.code), { ...room, messages: light }]);
}

export function forgetFixedRoom(code: string) {
  writeAll(readAll().filter((r) => r.code !== code));
}
