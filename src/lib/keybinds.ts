/**
 * Atalhos de teclado (e botões do mouse) editáveis.
 *
 * Uma combinação é guardada como texto, ex.: "Ctrl+Shift+KeyM" ou "Mouse4". A tecla é o
 * `KeyboardEvent.code` (posição física), então o atalho não muda com o idioma do teclado.
 * Só funcionam com a janela do Órbita em foco: o navegador não deixa sites ouvirem o teclado
 * quando estão em segundo plano.
 */

export type KeyAction = 'toggleMic' | 'toggleDeafen' | 'pushToTalk' | 'toggleCamera' | 'toggleLive' | 'toggleChat' | 'saveClip';

export type Keybinds = Record<KeyAction, string | null>;

export const KEY_ACTIONS: Array<{ id: KeyAction; label: string; hint?: string }> = [
  { id: 'toggleMic', label: 'Ligar/desligar microfone' },
  { id: 'toggleDeafen', label: 'Ensurdecer' },
  { id: 'pushToTalk', label: 'Pressionar para falar', hint: 'Segure para falar quando o modo de voz for “Pressionar para falar”.' },
  { id: 'toggleCamera', label: 'Ligar/desligar câmera' },
  { id: 'toggleLive', label: 'Abrir a live', hint: 'Inicia uma live ou abre as opções da live em andamento.' },
  { id: 'toggleChat', label: 'Mostrar/esconder o chat' },
  { id: 'saveClip', label: 'Salvar clipe do último minuto', hint: 'Precisa dos clipes ligados em Configurações › Voz e vídeo.' },
];

export const DEFAULT_KEYBINDS: Keybinds = {
  toggleMic: 'Ctrl+Shift+KeyM',
  toggleDeafen: 'Ctrl+Shift+KeyD',
  pushToTalk: null,
  toggleCamera: null,
  toggleLive: null,
  toggleChat: null,
  saveClip: null,
};

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
]);

/** Botões do mouse que dá para usar: meio e os dois laterais (voltar/avançar). */
const MOUSE_BUTTONS: Record<number, string> = { 1: 'Mouse3', 3: 'Mouse4', 4: 'Mouse5' };

interface Parsed {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

function parse(combo: string): Parsed {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  return { ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), meta: parts.includes('Meta'), key };
}

function build(p: Parsed): string {
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.meta && 'Meta', p.key].filter(Boolean).join('+');
}

/** Combinação de um evento de teclado; null enquanto só há modificadores pressionados. */
export function comboFromKeyboard(e: KeyboardEvent): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  return build({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key: e.code });
}

export function comboFromMouse(e: MouseEvent): string | null {
  const key = MOUSE_BUTTONS[e.button];
  return key ? build({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key }) : null;
}

export const isMouseCombo = (combo: string) => /(^|\+)Mouse\d$/.test(combo);

export function hasModifier(combo: string): boolean {
  const p = parse(combo);
  return p.ctrl || p.alt || p.meta;
}

/** A tecla (ou botão) do evento é a da combinação, com exatamente os mesmos modificadores. */
export function matchesKeyboard(combo: string, e: KeyboardEvent): boolean {
  return comboFromKeyboard(e) === combo;
}

export function matchesMouse(combo: string, e: MouseEvent): boolean {
  return comboFromMouse(e) === combo;
}

/** Para "pressionar para falar": a tecla principal basta (dá para segurar e apertar outras coisas). */
export function sameMainKey(combo: string, code: string): boolean {
  return parse(combo).key === code;
}

export function mainKey(combo: string): string {
  return parse(combo).key;
}

const NAMED_KEYS: Record<string, string> = {
  Space: 'Espaço',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Escape: 'Esc',
  CapsLock: 'Caps Lock',
  Backquote: '`',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlRo: '/',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Pause: 'Pause',
  ScrollLock: 'Scroll Lock',
  ContextMenu: 'Menu',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num ,',
  NumpadEnter: 'Num Enter',
  Mouse3: 'Botão do meio',
  Mouse4: 'Mouse lateral 1',
  Mouse5: 'Mouse lateral 2',
};

let layout: Map<string, string> | null = null;

/** Lê o layout do teclado (Chrome/Edge) para mostrar "Ç" no ABNT2 em vez de ";". */
export async function loadKeyboardLayout(): Promise<void> {
  try {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
    if (keyboard?.getLayoutMap) layout = await keyboard.getLayoutMap();
  } catch {
    /* sem permissão (iframe) ou navegador sem suporte */
  }
}

export function keyLabel(code: string): string {
  const printed = layout?.get(code);
  if (printed && printed.trim() && !/^Numpad/.test(code)) return printed.toUpperCase();
  if (NAMED_KEYS[code]) return NAMED_KEYS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

/** Partes para mostrar como teclas: ["Ctrl", "Shift", "M"]. */
export function comboParts(combo: string): string[] {
  const p = parse(combo);
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.meta && 'Win', keyLabel(p.key)].filter((x): x is string => !!x);
}

export const comboLabel = (combo: string) => comboParts(combo).join(' + ');

/** Atalhos que o navegador não deixa um site usar (ou que atrapalham demais). */
export function reservedCombo(combo: string): string | null {
  const p = parse(combo);
  if (p.key === 'Escape') return 'O Esc fecha janelas e menus do Órbita.';
  if (p.ctrl && !p.alt && !p.shift && ['KeyW', 'KeyT', 'KeyN', 'Tab'].includes(p.key)) return 'O navegador não deixa sites usarem esse atalho.';
  if (p.ctrl && p.shift && ['KeyN', 'KeyT', 'KeyW', 'Tab'].includes(p.key)) return 'O navegador não deixa sites usarem esse atalho.';
  if (p.alt && p.key === 'F4') return 'Esse atalho fecha a janela.';
  if (!p.ctrl && !p.alt && !p.meta && !p.shift && ['Enter', 'Tab', 'Backspace'].includes(p.key)) return 'Essa tecla é usada para escrever no chat.';
  return null;
}

export function sanitizeKeybinds(value: unknown): Keybinds {
  const out: Keybinds = { ...DEFAULT_KEYBINDS };
  if (!value || typeof value !== 'object') return out;
  for (const { id } of KEY_ACTIONS) {
    const combo = (value as Record<string, unknown>)[id];
    if (combo === null) out[id] = null;
    else if (typeof combo === 'string' && /^[A-Za-z0-9+]{2,40}$/.test(combo)) out[id] = combo;
  }
  return out;
}
