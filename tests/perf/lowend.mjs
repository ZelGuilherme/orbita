// Simula computadores fracos na Órbita e mede o que causa lag (ver docs/desempenho-low-end.md).
//   node tests/perf/lowend.mjs [bots=6]        (LEAN=1: só a janela com GPU, para máquinas com pouca RAM)
// Abre duas janelas medidoras (GPU normal e sem GPU), estrangula a CPU 4x pelo DevTools e mede
// fps, tarefas longas e o perfil de CPU em cada modo (3D, 2D, anéis), sem e com live no ar.
// Resultados em test-results/perf/.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(root, 'test-results', 'perf');
mkdirSync(OUT, { recursive: true });
const BOTS = Number(process.argv[2] ?? 6);
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('playwright-core');
const vite = await import(pathToFileURL(require.resolve('vite')).href);
const { PeerServer } = require('peer');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

// build de produção sem minificar (nomes legíveis no perfil)
const outDir = join(OUT, 'dist-prof');
await vite.build({ root, logLevel: 'error', define: { 'import.meta.env.DEV': 'true' }, build: { outDir, emptyOutDir: true, minify: false, sourcemap: false } });
const server = await vite.preview({ root, logLevel: 'error', build: { outDir }, preview: { port: 5340, strictPort: true } });
const BASE = server.resolvedUrls.local[0];
PeerServer({ port: 9441, path: '/' });
const NETWORK = { host: 'localhost', port: 9441, path: '/', secure: false, key: 'peerjs', iceServersJson: '' };
const LOBBY = `orbita-lowend-${Math.random().toString(36).slice(2, 8)}`;
log('app (produção) em', BASE);

const MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'];
const NO_THROTTLE = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
const botsBrowser = await chromium.launch({ channel: 'msedge', headless: true, args: MEDIA });
const gpuBrowser = await chromium.launch({ channel: 'msedge', headless: false, args: [...MEDIA, ...NO_THROTTLE, '--window-size=1440,900', '--window-position=0,0'] });
const softBrowser = process.env.LEAN ? null : await chromium.launch({
  channel: 'msedge',
  headless: false,
  args: [...MEDIA, ...NO_THROTTLE, '--disable-gpu', '--enable-unsafe-swiftshader', '--window-size=1440,900', '--window-position=60,40'],
});

const LIGHT = { version: 4, noiseFilter: 'off', noiseGate: false, highpass: false, compressor: false, vadAuto: false };

async function user(browser, name, color, { settings = LIGHT, view = 'line', viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, permissions: ['microphone', 'camera'] });
  await context.addInitScript(
    ([n, c, s, v, lobby, network]) => {
      localStorage.setItem('orbita.lobbyId', lobby);
      if (!sessionStorage.getItem('le.init')) {
        sessionStorage.setItem('le.init', '1');
        localStorage.setItem('orbita.profile.v1', JSON.stringify({ id: (Math.random().toString(36).slice(2, 12) + 'abcdefgh').slice(0, 16), name: n, color: c }));
        localStorage.setItem('orbita.settings.v1', JSON.stringify(s ? { ...s, network } : { network }));
        localStorage.setItem('orbita.ui.v1', JSON.stringify({ orbitView: v, chatOpen: true }));
      }
      window.showSaveFilePicker = undefined;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const g = canvas.getContext('2d');
        let t = 0;
        setInterval(() => {
          t++;
          g.fillStyle = `hsl(${(t * 3) % 360} 70% 35%)`;
          g.fillRect(0, 0, 1280, 720);
          g.fillStyle = '#fff';
          g.font = 'bold 90px sans-serif';
          g.fillText(`LIVE ${t}`, 80 + ((t * 9) % 700), 380);
        }, 33);
        return canvas.captureStream(30);
      };
    },
    [name, color, settings, view, LOBBY, NETWORK],
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`[${name}] erro:`, e.message));
  return page;
}
const inRoom = (p) => p.waitForFunction(() => window.__orbita?.getApp().phase === 'room', null, { timeout: 90_000, polling: 250 });
const join_ = async (p) => {
  await p.goto(`${BASE}#/sala/${code}`, { timeout: 90_000 });
  await p.getByRole('button', { name: /Entrar na órbita/ }).click({ timeout: 60_000 });
  await inRoom(p);
};

// a sala: um bot é o host; os outros entram; todos com microfone ligado (o som falso faz "falar")
const NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João Pedro'];
const COLORS = ['#22d3ee', '#f472b6', '#f59e0b', '#ef4444', '#10b981', '#3b82f6', '#84cc16', '#a855f7', '#14b8a6', '#eab308'];
const hostBot = await user(botsBrowser, NAMES[0], COLORS[0]);
await hostBot.goto(BASE);
await hostBot.getByRole('button', { name: /Criar e virar host/ }).click();
await inRoom(hostBot);
await hostBot.keyboard.press('Escape');
const code = await hostBot.evaluate(() => window.__orbita.getApp().code);
const bots = [hostBot];
for (let i = 1; i < BOTS; i++) {
  const p = await user(botsBrowser, NAMES[i], COLORS[i]);
  try {
    await join_(p);
    bots.push(p);
  } catch (e) {
    log(`  ${NAMES[i]} não entrou:`, e.message.split('\n')[0]);
  }
}
log(`sala ${code}: ${bots.length} bots`);

// as janelas medidas: configurações padrão (filtros de áudio ligados), como um usuário novo
const candidates = [
  { label: 'GPU normal', page: await user(gpuBrowser, 'Medidor GPU', '#8b5cf6', { settings: null, view: 'line', viewport: null }) },
  softBrowser && { label: 'sem GPU', page: await user(softBrowser, 'Medidor sem GPU', '#ec4899', { settings: null, view: 'line', viewport: null }) },
];
const viewers = [];
for (const v of candidates.filter(Boolean)) {
  const t = Date.now();
  try {
    await join_(v.page);
  } catch (e) {
    await v.page.screenshot({ path: join(OUT, `join-fail-${v.label.replace(/ /g, '-')}.png`) }).catch(() => {});
    log(`${v.label}: não entrou na sala (${e.message.split(String.fromCharCode(10))[0]})`);
    continue;
  }
  log(`${v.label}: entrou em ${((Date.now() - t) / 1000).toFixed(1)} s`);
  viewers.push(v);
  v.cdp = await v.page.context().newCDPSession(v.page);
  await v.cdp.send('Performance.enable');
  await v.cdp.send('Profiler.enable');
  await v.cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  v.webgl = await v.page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return 'sem WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  log(`${v.label}: WebGL = ${v.webgl}`);
}
for (const b of bots) await b.getByRole('button', { name: 'Ativar microfone' }).first().click({ timeout: 10_000 }).catch(() => {});
await viewers[0].page.waitForFunction((n) => (window.__orbita.getApp().room?.members.length ?? 0) >= n, bots.length + viewers.length, { timeout: 60_000 }).catch(async () => log("aviso: membros na sala =", await viewers[0].page.evaluate(() => window.__orbita.getApp().room?.members.length)));
log('microfones dos bots ligados; aquecendo...');
await viewers[0].page.waitForTimeout(4000);

const METRICS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
const metrics = async (cdp) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter((m) => METRICS.includes(m.name)).map((m) => [m.name, m.value]));

async function measure(v, seconds, profile) {
  await v.page.evaluate(() => {
    const st = (window.__le = { frames: [], long: [], speak: 0, run: true });
    let last = performance.now();
    const loop = (now) => {
      st.frames.push(now - last);
      last = now;
      if (st.run) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    st.obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => st.long.push(e.duration)));
    st.obs.observe({ type: 'longtask' });
    let prev = window.__orbita.getApp().speaking;
    st.unsub = setInterval(() => {
      const s = window.__orbita.getApp().speaking;
      if (s !== prev) st.speak++;
      prev = s;
    }, 16);
  });
  const m0 = await metrics(v.cdp);
  if (profile) await v.cdp.send('Profiler.start');
  await v.page.waitForTimeout(seconds * 1000);
  const prof = profile ? (await v.cdp.send('Profiler.stop')).profile : null;
  const m1 = await metrics(v.cdp);
  const r = await v.page.evaluate(() => {
    const st = window.__le;
    st.run = false;
    st.obs.disconnect();
    clearInterval(st.unsub);
    const f = st.frames.slice(1).sort((a, b) => a - b);
    const total = st.frames.slice(1).reduce((a, b) => a + b, 0);
    return {
      fps: f.length / (total / 1000),
      p95: f[Math.floor(f.length * 0.95)] ?? 0,
      max: f[f.length - 1] ?? 0,
      janky: f.filter((x) => x > 50).length,
      long: st.long.length,
      longMs: st.long.reduce((a, b) => a + b, 0),
      speak: st.speak,
    };
  });
  const busy = Object.fromEntries(METRICS.map((k) => [k, ((m1[k] - m0[k]) / seconds) * 100]));
  return { ...r, busy, prof };
}

/** Tempo próprio por função (soma das amostras), as que mais pesam. */
function topFunctions(profile, n = 14) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const self = new Map();
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    const cf = node.callFrame;
    const file = cf.url ? basename(cf.url.split('?')[0]) : '';
    const key = `${cf.functionName || '(anônima)'}${file ? ` ${file}:${cf.lineNumber + 1}` : ''}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  return [...self.entries()]
    .filter(([k]) => k !== '(idle)')
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${((ms / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
}

const rows = [];
const profiles = {};
async function scenario(tag) {
  for (const v of viewers) {
    for (const rate of [4]) {
      await v.cdp.send('Emulation.setCPUThrottlingRate', { rate });
      for (const mode of ['entrar-3d', '3d', '2d', 'line']) {
        if (mode === 'entrar-3d') {
          // sai do 3D (desmonta a cena) e mede logo ao entrar de novo
          await v.page.evaluate(() => window.__orbita.setApp({ orbitView: 'line' }));
          await v.page.waitForTimeout(2500);
          await v.page.evaluate(() => window.__orbita.setApp({ orbitView: '3d' }));
        } else {
          await v.page.evaluate((m) => window.__orbita.setApp({ orbitView: m }), mode);
          await v.page.waitForTimeout(mode === '3d' ? 4000 : 1500);
        }
        const r = await measure(v, mode === 'entrar-3d' ? 10 : 6, true);
        if (r.prof) {
          const key = `${tag} | ${v.label} | CPU ${rate}x | ${mode}`;
          profiles[key] = topFunctions(r.prof);
          console.log(`\n--- perfil: ${key}`);
          for (const l of profiles[key]) console.log('  ' + l);
          writeFileSync(join(OUT, 'lowend-profiles.json'), JSON.stringify(profiles, null, 2));
        }
        const row = { cenario: tag, maquina: v.label, cpu: `${rate}x`, modo: mode, ...r, prof: undefined };
        rows.push(row);
        log(
          `${tag.padEnd(9)} ${v.label.padEnd(10)} CPU ${rate}x ${mode.padEnd(4)}  fps ${r.fps.toFixed(0).padStart(3)}  p95 ${r.p95.toFixed(0).padStart(4)}ms  max ${r.max.toFixed(0).padStart(4)}ms  travadas(>50ms) ${String(r.janky).padStart(3)}  longas ${String(r.long).padStart(3)} (${r.longMs.toFixed(0)}ms)  ocupado ${r.busy.TaskDuration.toFixed(0)}% [js ${r.busy.ScriptDuration.toFixed(0)}% estilo ${r.busy.RecalcStyleDuration.toFixed(0)}% layout ${r.busy.LayoutDuration.toFixed(0)}%]  falas ${r.speak}`,
        );
      }
    }
    await v.cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
}

await scenario('chamada');

// com live no ar: um bot transmite e os medidores assistem (a órbita vira a faixa de baixo)
let liveOk = true;
try {
  await bots[1].getByRole('button', { name: 'Iniciar live' }).last().click({ timeout: 20_000 });
  await bots[1].getByRole('button', { name: /Escolher o que transmitir/ }).click({ timeout: 20_000 });
} catch (e) {
  liveOk = false;
  log('live não começou:', e.message.split(String.fromCharCode(10))[0]);
  await bots[1].screenshot({ path: join(OUT, 'live-fail.png') }).catch(() => {});
}
for (const v of liveOk ? viewers : []) {
  await v.page.waitForFunction(() => window.__orbita.getApp().room?.members.some((m) => m.live), null, { timeout: 30_000 });
  await v.page.getByRole('button', { name: /Assistir live/ }).first().click();
  await v.page.waitForFunction(() => [...document.querySelectorAll('.tile--live video')].some((x) => x.videoWidth > 0), null, { timeout: 30_000 }).catch(() => log(`${v.label}: vídeo da live não apareceu`));
}
if (liveOk) {
  log('live no ar');
  await scenario('live');
}

writeFileSync(join(OUT, 'lowend.json'), JSON.stringify({ rows, profiles, webgl: viewers.map((v) => [v.label, v.webgl]) }, null, 2));
console.log('\n===== funções que mais pesam (CPU 4x, 6 s) =====');
for (const [k, list] of Object.entries(profiles)) {
  console.log(`\n--- ${k}`);
  for (const l of list) console.log('  ' + l);
}
await Promise.all([botsBrowser.close(), gpuBrowser.close(), softBrowser?.close()]);
await server.close();
process.exit(0);
