import { parseRoomCode } from './util';

/**
 * Integração com o app instalado (PWA).
 *
 * O app e as abas do mesmo navegador dividem o localStorage. Quando o app roda, ele deixa
 * uma marca; uma aba que recebe um convite vê a marca e entrega o convite para o app pelo
 * protocolo web+orbita:// (registrado no manifesto). O resto do site continua funcionando
 * na aba normalmente: dá para editar o perfil, as configurações etc.
 */

const INSTALLED_KEY = 'orbita.app.installed';
const STAY_KEY = 'orbita.app.stay';
export const PROTOCOL = 'web+orbita';

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function markInstalled() {
  storage('local')?.setItem(INSTALLED_KEY, String(Date.now()));
}

export function forgetInstalled() {
  storage('local')?.removeItem(INSTALLED_KEY);
}

export function appLikelyInstalled(): boolean {
  return !!storage('local')?.getItem(INSTALLED_KEY);
}

/** A pessoa escolheu continuar no navegador com este convite (vale até fechar a aba). */
export function stayInBrowser(code: string) {
  storage('session')?.setItem(STAY_KEY, code);
}

export function wantsBrowser(code: string): boolean {
  return storage('session')?.getItem(STAY_KEY) === code;
}

/** Só no computador: no celular o próprio sistema já abre o app instalado. */
export function canHandOff(): boolean {
  return !isStandalone() && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * Pede para o navegador abrir o app (no convite, se houver). Resolve true se a janela perdeu
 * o foco, sinal de que o app abriu (ou de que o navegador está perguntando se pode abrir).
 */
export function openInApp(code: string | null, timeoutMs = 4_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (opened: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onBlur);
      clearTimeout(timer);
      resolve(opened);
    };
    const onBlur = () => {
      if (document.visibilityState === 'hidden' || !document.hasFocus()) finish(true);
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onBlur);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    try {
      window.location.href = code ? `${PROTOCOL}://sala/${code}` : `${PROTOCOL}://inicio`;
    } catch {
      finish(false);
    }
  });
}

/** Código de sala vindo de um link aberto pelo app (protocolo ou convite comum). */
export function codeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, location.href);
    const protocol = parsed.searchParams.get('protocol');
    if (protocol) return parseRoomCode(protocol);
    const hash = parsed.hash.match(/^#\/sala\/([a-z0-9]{4,16})/i);
    return hash ? hash[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Remove o ?protocol=… da barra de endereço, deixando o convite no formato normal. */
export function cleanProtocolParam(): string | null {
  const code = codeFromUrl(location.href);
  if (!new URLSearchParams(location.search).has('protocol')) return null;
  history.replaceState(null, '', `${location.pathname}${code ? `#/sala/${code}` : ''}`);
  return code;
}

interface LaunchParams {
  targetURL?: string;
}

/** O app já estava aberto e alguém clicou num convite: o navegador entrega o link aqui. */
export function onAppLaunch(handler: (url: string) => void) {
  const queue = (window as Window & { launchQueue?: { setConsumer(cb: (params: LaunchParams) => void): void } }).launchQueue;
  queue?.setConsumer((params) => {
    if (params.targetURL) handler(params.targetURL);
  });
}

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let installPrompt: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
const notifyInstall = () => installListeners.forEach((fn) => fn());

/** O navegador oferece instalar o app (Chrome, Edge, Brave). */
export const canInstall = () => !!installPrompt;

export function onInstallChange(listener: () => void): () => void {
  installListeners.add(listener);
  return () => installListeners.delete(listener);
}

export async function promptInstall(): Promise<boolean> {
  const prompt = installPrompt;
  if (!prompt) return false;
  installPrompt = null;
  notifyInstall();
  await prompt.prompt();
  return (await prompt.userChoice).outcome === 'accepted';
}

export function trackInstallation() {
  if (isStandalone()) markInstalled();
  window.addEventListener('appinstalled', () => {
    markInstalled();
    installPrompt = null;
    notifyInstall();
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e as InstallPrompt;
    notifyInstall();
  });
}
