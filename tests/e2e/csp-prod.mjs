// Confere a política de segurança (CSP) no build de produção: sobe o dist/ localmente, abre duas
// pessoas, entra na chamada (filtro de ruído em WebAssembly), 3D (worker de texturas), live,
// gravação (worker blob:) e editor de planeta, e falha se o navegador recusar qualquer coisa.
//
//   npm run build && node tests/e2e/csp-prod.mjs
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { PeerServer } = await import('peer');
const SIGNAL_PORT = 9412;
const signaling = PeerServer({ port: SIGNAL_PORT, path: '/' });
const NETWORK = { host: 'localhost', port: SIGNAL_PORT, path: '/', secure: false, key: 'peerjs', iceServersJson: '' };
const server = await preview({ root, logLevel: 'error', preview: { port: 5399, strictPort: true } });
const BASE = server.resolvedUrls.local[0];
const log = (...a) => console.log('[csp]', ...a);

const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const problems = [];

async function user(name, color) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await context.addInitScript(
    ([n, c, network]) => {
      if (!sessionStorage.getItem('csp.init')) {
        sessionStorage.setItem('csp.init', '1');
        localStorage.setItem('orbita.profile.v1', JSON.stringify({ id: (Math.random().toString(36).slice(2, 12) + 'abcdefgh').slice(0, 16), name: n, color: c }));
        localStorage.setItem('orbita.settings.v1', JSON.stringify({ network }));
      }
      window.showSaveFilePicker = undefined;
      document.addEventListener('securitypolicyviolation', (e) => {
        (window.__csp ??= []).push(`${e.violatedDirective} ← ${e.blockedURI || 'inline'}`);
      });
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const g = canvas.getContext('2d');
        let t = 0;
        setInterval(() => {
          g.fillStyle = `hsl(${t++ % 360} 70% 40%)`;
          g.fillRect(0, 0, 640, 360);
        }, 33);
        return canvas.captureStream(30);
      };
    },
    [name, color, NETWORK],
  );
  const page = await context.newPage();
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(`${name}: ${m.text().slice(0, 220)}`);
  });
  page.on('pageerror', (e) => problems.push(`${name} erro: ${e.message}`));
  return page;
}

try {
  const a = await user('Ana', '#8b5cf6');
  const b = await user('Bruno', '#22c55e');
  await a.goto(BASE);
  const csp = await a.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  if (!csp || csp.includes('unsafe-inline\'; style') || /script-src[^;]*unsafe-inline/.test(csp)) throw new Error(`CSP de produção errada: ${csp}`);
  log('CSP presente:', csp.split(';')[1].trim());
  await a.getByRole('button', { name: /Criar e virar host/ }).click();
  await a.waitForFunction(() => location.hash.includes('/sala/'), null, { timeout: 30_000 });
  const code = await a.evaluate(() => location.hash.split('/').pop());
  // fecha o convite (a janela carrega sob demanda)
  await a.locator('.modal-backdrop').waitFor({ timeout: 10_000 }).catch(() => {});
  await a.keyboard.press('Escape');
  await a.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
  await b.goto(`${BASE}#/sala/${code}`);
  await b.getByRole('button', { name: /Entrar na órbita/ }).click();
  await b.waitForSelector('.call-controls', { timeout: 30_000 });
  await a.waitForSelector('.orbit3d canvas, .orbit', { timeout: 30_000 });
  log('sala e chamada ok (3D:', await a.locator('.orbit3d canvas').count(), ')');
  await b.getByRole('button', { name: 'Iniciar live' }).last().click();
  await b.getByRole('button', { name: /Escolher o que transmitir/ }).click();
  await a.getByRole('button', { name: /Assistir live/ }).first().click();
  await a.waitForFunction(() => [...document.querySelectorAll('.tile--live video')].some((v) => v.videoWidth > 0), null, { timeout: 30_000 });
  log('live ok');
  await a.getByRole('button', { name: 'Gravar a chamada' }).click();
  await a.waitForTimeout(2_500);
  await a.getByRole('button', { name: /Parar a gravação/ }).click().catch(() => {});
  log('gravação ok');
  await a.getByRole('button', { name: 'Configurações' }).last().click();
  await a.getByRole('tab', { name: /Planeta/ }).click().catch(() => {});
  await a.waitForTimeout(4_000);
  for (const page of [a, b]) problems.push(...(await page.evaluate(() => window.__csp ?? [])).map((v) => `violação: ${v}`));
} catch (err) {
  problems.push(`falhou: ${err.message.split('\n').slice(0, 3).join(' | ')}`);
}
await browser.close();
await server.close();
signaling.close?.();
if (problems.length) {
  console.log('[csp] ❌ problemas:\n  ' + [...new Set(problems)].join('\n  '));
  process.exit(1);
}
log('✅ nada recusado pela CSP no build de produção');
process.exit(0);
