export const APP_NAME = 'Órbita';
export const APP_SLUG = 'orbita';
export const APP_VERSION = '0.1.0';
export const REPO_URL = 'https://github.com/ZelGuilherme/orbita';

/** Versão do protocolo entre clientes e host. Mude ao quebrar compatibilidade. */
export const PROTOCOL_VERSION = 1;
/** O peer do host no servidor de sinalização se chama HUB_PREFIX + código da sala. */
export const HUB_PREFIX = `${APP_SLUG}-v${PROTOCOL_VERSION}-sala-`;
export const ROOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_CODE_LENGTH = 7;

export const MAX_MEMBERS = 24;
export const MAX_MESSAGES_PER_CHANNEL = 300;
export const MAX_TEXT_LENGTH = 4000;
/** Tamanho máximo (em caracteres do data URL) de uma imagem enviada no chat (~1,6 MB). */
export const MAX_IMAGE_CHARS = 2_200_000;
/** Quanto de imagem o host guarda no histórico para quem entrar depois. */
export const HISTORY_IMAGE_BUDGET = 9_000_000;

export const HEARTBEAT_MS = 4_000;
export const CLIENT_TIMEOUT_MS = 15_000;
export const HUB_TIMEOUT_MS = 12_000;
export const RECONNECT_GRACE_MS = 25_000;
export const MIGRATION_GIVE_UP_MS = 120_000;

export const REACTIONS = ['👍', '😂', '❤️', '🔥', '😮', '😢', '🎉', '👀', '🚀', '🪐'];

export const QUICK_EMOJIS = [
  '😀', '😂', '🤣', '😊', '😍', '🥰', '😎', '🤩', '😉', '🤔', '😏', '😴', '😭', '😤', '😡', '🤯',
  '🥳', '😱', '🙃', '😇', '🤗', '🤝', '👍', '👎', '👏', '🙏', '💪', '👀', '🔥', '✨', '💯', '🎉',
  '❤️', '💜', '💙', '💚', '💛', '🧡', '🖤', '💔', '⭐', '🌙', '☀️', '🪐', '🚀', '🛸', '🌌', '☄️',
  '🎮', '🎧', '🎵', '📺', '🍕', '🍔', '🍺', '☕', '⚽', '🏆', '💀', '🤡', '👻', '🐱', '🐶', '🦄',
];

/** Cores dos "planetas" (avatares). */
export const PLANET_COLORS = [
  '#8b5cf6', '#22d3ee', '#f472b6', '#fb923c', '#34d399', '#facc15',
  '#60a5fa', '#f87171', '#c084fc', '#2dd4bf', '#a3e635', '#e879f9',
];

export const COSMIC_NAMES = [
  'Cometa', 'Nebulosa', 'Quasar', 'Pulsar', 'Asteroide', 'Eclipse', 'Meteoro', 'Supernova',
  'Galáxia', 'Satélite', 'Aurora', 'Órion', 'Vega', 'Andrômeda', 'Plutão', 'Netuno',
];
