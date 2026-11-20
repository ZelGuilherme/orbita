// Demo: abre uma sala da Órbita com você como host (janela visível) e N usuários falsos.
//   node tests/perf/demo-sala.mjs [quantidade=10]
// Cada usuário falso é uma aba do navegador com voz P2P: em máquina com pouca RAM, use menos.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const COUNT = Number(process.argv[2] ?? 10);
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('playwright-core');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { PeerServer } = require('peer');

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const SIGNAL_PORT = 9421;
PeerServer({ port: SIGNAL_PORT, path: '/' });
const NETWORK = { host: 'localhost', port: SIGNAL_PORT, path: '/', secure: false, key: 'peerjs', iceServersJson: '' };
const LOBBY = `orbita-demo-${Math.random().toString(36).slice(2, 8)}`;

const server = await createServer({ root, logLevel: 'error', server: { port: 5320 } });
await server.listen();
const BASE = server.resolvedUrls.local[0];
log('app em', BASE);

const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'];
const visible = await chromium.launch({ channel: 'msedge', headless: false, args: [...FLAGS, '--window-size=1400,900'] });
const bots = await chromium.launch({ channel: 'msedge', headless: true, args: FLAGS });

// filtros de áudio desligados (mais leve); todos já no modo anéis
const LIGHT = { version: 4, noiseFilter: 'off', noiseGate: false, highpass: false, compressor: false, vadAuto: false };

async function user(browser, name, color, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport === undefined ? { width: 900, height: 600 } : opts.viewport, permissions: ['microphone', 'camera'] });
  await context.addInitScript(
    ([n, c, settings, lobby, network]) => {
      localStorage.setItem('orbita.lobbyId', lobby);
      if (!sessionStorage.getItem('demo.init')) {
        sessionStorage.setItem('demo.init', '1');
        localStorage.setItem('orbita.profile.v1', JSON.stringify({ id: (Math.random().toString(36).slice(2, 12) + 'abcdefgh').slice(0, 16), name: n, color: c }));
        localStorage.setItem('orbita.settings.v1', JSON.stringify({ ...settings, network }));
        localStorage.setItem('orbita.ui.v1', JSON.stringify({ orbitView: 'line', chatOpen: true }));
      }
    },
    [name, color, opts.settings ?? LIGHT, LOBBY, NETWORK],
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`[${name}] erro:`, e.message));
  return page;
}

const inRoom = (page) => page.waitForFunction(() => window.__orbita?.getApp().phase === 'room', null, { timeout: 60_000, polling: 250 });

// você: o host, numa janela de verdade (pode redimensionar)
const me = await user(visible, 'Você (host)', '#8b5cf6', { viewport: null });
await me.goto(BASE);
await me.getByRole('button', { name: /Criar e virar host/ }).click();
await inRoom(me);
await me.locator('.modal-backdrop').waitFor({ timeout: 10_000 }).catch(() => {});
await me.keyboard.press('Escape');
const code = await me.evaluate(() => window.__orbita.getApp().code);
log('sala criada:', code, `— entrando ${COUNT} usuários de teste...`);

const NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João Pedro', 'Karina', 'Lucas', 'Marina', 'Nicolas', 'Olívia', 'Paulo', 'Quésia', 'Rafael', 'Sofia', 'Thiago'];
const COLORS = ['#22d3ee', '#f472b6', '#f59e0b', '#ef4444', '#10b981', '#3b82f6', '#84cc16', '#a855f7', '#14b8a6', '#eab308'];
const pages = [];
for (let i = 0; i < COUNT; i += 3) {
  await Promise.all(
    Array.from({ length: Math.min(3, COUNT - i) }, async (_, j) => {
      const k = i + j;
      const name = NAMES[k % NAMES.length] + (k >= NAMES.length ? ` ${Math.floor(k / NAMES.length) + 1}` : '');
      try {
        const page = await user(bots, name, COLORS[k % COLORS.length]);
        await page.goto(`${BASE}#/sala/${code}`);
        await page.getByRole('button', { name: /Entrar na órbita/ }).click();
        await inRoom(page);
        pages.push(page);
        log(`  ${name} entrou (${pages.length}/${COUNT})`);
      } catch (e) {
        log(`  ${name} não conseguiu entrar:`, e.message.split('\n')[0]);
      }
    }),
  );
}
log('pronto! Deixe este processo rodando enquanto olha; feche a janela do Edge para encerrar.');
me.context().browser().on('disconnected', async () => {
  await bots.close().catch(() => {});
  await server.close().catch(() => {});
  process.exit(0);
});
