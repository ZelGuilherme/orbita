// Testes ponta a ponta da Órbita: navegadores reais conversando por P2P.
//
//   npm run test:e2e
//
// Sobe o Vite em modo dev, abre várias pessoas no Edge/Chrome instalado (com câmera e
// microfone falsos) e usa o servidor público do PeerJS. Capturas vão para test-results/.
// Variáveis: E2E_BROWSER=chrome|msedge, E2E_HEADED=1 para ver as janelas.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = join(root, 'test-results');
mkdirSync(SHOTS, { recursive: true });
const CHANNEL = process.env.E2E_BROWSER ?? (process.platform === 'win32' ? 'msedge' : 'chrome');

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...args);

const server = await createServer({ root, logLevel: 'error', server: { port: 5299 } });
await server.listen();
const BASE = server.resolvedUrls.local[0];
log('app em', BASE, '| navegador:', CHANNEL);

const browser = await chromium.launch({
  channel: CHANNEL,
  headless: !process.env.E2E_HEADED,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
});

// ───────────────────────── utilidades ─────────────────────────

async function newUser(name, color, opened, viewport = { width: 1440, height: 900 }, settings = null) {
  const context = await browser.newContext({ viewport, permissions: ['microphone', 'camera'], hasTouch: viewport.width < 500 });
  opened.push(context);
  await context.addInitScript(
    ([n, c, extra]) => {
      if (!sessionStorage.getItem('e2e.init')) {
        sessionStorage.setItem('e2e.init', '1');
        localStorage.setItem(
          'orbita.profile.v1',
          JSON.stringify({ id: (Math.random().toString(36).slice(2, 12) + 'abcdefgh').slice(0, 16), name: n, color: c }),
        );
        if (extra) localStorage.setItem('orbita.settings.v1', JSON.stringify(extra));
      }
      window.__displayCalls = 0;
      // getDisplayMedia falso: canvas animado + tom (testa a live sem tela de verdade)
      navigator.mediaDevices.getDisplayMedia = async () => {
        window.__displayCalls++;
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
        const stream = canvas.captureStream(30);
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        stream.addTrack(dest.stream.getAudioTracks()[0]);
        return stream;
      };
    },
    [name, color, settings],
  );
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`        [${name} ${msg.type()}]`, msg.text().slice(0, 240));
  });
  page.on('pageerror', (err) => console.log(`        [${name} ERRO]`, err.message));
  return { name, context, page };
}

const waitFor = (page, fn, arg, timeout = 30_000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const membersOf = (page) =>
  page.evaluate(() => {
    const s = window.__orbita.getApp();
    return s.room?.members.map((m) => `${m.name}${m.id === s.room.hostId ? '👑' : ''}`).join(', ');
  });

async function createRoom(user) {
  await user.page.goto(BASE);
  await user.page.getByRole('button', { name: /Criar e virar host/ }).click();
  await waitFor(user.page, () => window.__orbita?.getApp().phase === 'room');
  await user.page.keyboard.press('Escape');
  return user.page.evaluate(() => window.__orbita.getApp().code);
}

async function joinRoom(user, code) {
  await user.page.goto(`${BASE}#/sala/${code}`);
  await user.page.getByRole('button', { name: /Entrar na órbita/ }).click();
  await waitFor(user.page, () => window.__orbita?.getApp().phase === 'room');
}

async function joinCall(user) {
  await user.page.getByRole('button', { name: /Entrar na chamada/ }).click();
  await waitFor(user.page, () => window.__orbita.getApp().inCall);
}

// ───────────────────────── cenários ─────────────────────────

/** 3 pessoas: chat, reação, malha de voz, câmera, live, queda do host e expulsão. */
async function chamadaCompleta(opened) {
  const a = await newUser('Ana', '#8b5cf6', opened);
  const b = await newUser('Bruno', '#22d3ee', opened);
  const c = await newUser('Carla', '#f472b6', opened);
  const code = await createRoom(a);
  await joinRoom(b, code);
  await joinRoom(c, code);
  await waitFor(a.page, () => window.__orbita.getApp().room?.members.length === 3);
  log('  sala', code, '→', await membersOf(a.page));

  await b.page.locator('.composer textarea').fill('Olá @Ana! Testando a órbita 🚀 com **negrito**');
  await b.page.keyboard.press('Enter');
  await waitFor(a.page, () => document.querySelector('.messages')?.textContent?.includes('Testando a órbita'));
  await waitFor(c.page, () => document.querySelector('.messages')?.textContent?.includes('Testando a órbita'));
  await a.page.locator('.msg', { hasText: 'Testando a órbita' }).hover();
  await a.page.locator('.msg', { hasText: 'Testando a órbita' }).getByRole('button', { name: 'Reagir' }).click();
  await a.page.locator('.reaction-picker button').first().click();
  await waitFor(b.page, () => !!document.querySelector('.reaction'));
  log('  chat e reação ok');

  for (const u of [a, b, c]) await joinCall(u);
  for (const u of [a, b, c]) {
    await waitFor(u.page, () => Object.keys(window.__orbita.getApp().voiceStreams).length === 2, null, 45_000);
  }
  log('  malha de voz completa');
  await a.page.waitForTimeout(1_000);
  await shot(a.page, 'chamada-orbita');

  await a.page.getByRole('button', { name: 'Ligar câmera' }).last().click();
  await waitFor(b.page, () => [...document.querySelectorAll('.tile video')].some((v) => v.videoWidth > 0));
  log('  câmera ok');

  await b.page.getByRole('button', { name: 'Iniciar live' }).last().click();
  await b.page.getByRole('button', { name: /Escolher o que transmitir/ }).click();
  await waitFor(a.page, () => window.__orbita.getApp().room?.members.some((m) => m.live), null, 20_000);
  await a.page.getByRole('button', { name: /Assistir live/ }).first().click();
  await waitFor(a.page, () => [...document.querySelectorAll('.tile--live video')].some((v) => v.videoWidth > 0));
  await waitFor(b.page, () => window.__orbita.getApp().live?.viewers === 1, null, 15_000);
  log('  live ok (1 espectador)');

  // volume da live, separado do volume da voz
  await a.page.locator('.tile--live').first().hover();
  await a.page.getByRole('button', { name: 'Silenciar a live' }).click();
  await waitFor(a.page, () => Object.values(window.__orbita.getApp().liveMutes).some(Boolean));
  await a.page.getByRole('button', { name: 'Ativar o som da live' }).click();
  await a.page.locator('.live-volume input[type=range]').fill('35');
  await waitFor(a.page, () => Object.values(window.__orbita.getApp().liveVolumes).includes(35));
  const liveAudio = await a.page.evaluate(() => [...document.querySelectorAll('audio')].map((el) => Math.round(el.volume * 100)));
  if (!liveAudio.includes(35)) throw new Error(`volume da live não chegou no áudio: ${liveAudio}`);
  log('  volume da live ok:', liveAudio.join(', '));

  // efeitos e laser: aparecem para quem transmite e para quem assiste
  await a.page.locator('.fx-bar__emoji').first().click();
  await waitFor(b.page, () => !!document.querySelector('.tile--live .fx-reaction'), null, 10_000);
  await a.page.locator('.fx-bar').getByRole('button', { name: 'Efeitos na tela' }).click();
  await a.page.getByRole('menuitem', { name: /Disco voador/ }).click();
  await waitFor(b.page, () => !!document.querySelector('.tile--live .fx-ufo'), null, 10_000);
  await a.page.locator('.fx-bar').getByRole('button', { name: 'Chamar atenção' }).click();
  await waitFor(b.page, () => [...document.querySelectorAll('.fx-credit')].some((el) => el.textContent.includes('chamou atenção')), null, 10_000);
  await a.page.locator('.fx-bar').getByRole('button', { name: /Laser/ }).click();
  const stage = await a.page.locator('.tile--live .fx-stage').boundingBox();
  await a.page.mouse.move(stage.x + stage.width * 0.25, stage.y + stage.height * 0.5);
  await a.page.mouse.move(stage.x + stage.width * 0.3, stage.y + stage.height * 0.4, { steps: 5 });
  await waitFor(b.page, () => !!document.querySelector('.tile--live .fx-laser.is-on'), null, 10_000);
  const laserAt = await b.page.evaluate(() => {
    const el = document.querySelector('.tile--live .fx-laser.is-on');
    return { left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
  });
  if (Math.abs(laserAt.left - 30) > 4 || Math.abs(laserAt.top - 40) > 4) throw new Error(`laser fora do lugar: ${JSON.stringify(laserAt)}`);
  log('  efeitos ok (reação, disco voador, chamar atenção) e laser em', laserAt);
  await shot(b.page, 'live-efeitos-streamer');

  // opções com a live no ar: qualidade e trocar a fonte, sem derrubar o espectador
  await b.page.getByRole('button', { name: 'Opções da live' }).last().click();
  await b.page.getByRole('button', { name: /1080p 60fps/ }).click();
  await waitFor(a.page, () => window.__orbita.getApp().room?.members.find((m) => m.live)?.live.quality === '1080p60', null, 10_000);
  await b.page.getByRole('button', { name: /Trocar o que está sendo transmitido/ }).click();
  await waitFor(b.page, () => window.__displayCalls === 2, null, 10_000);
  await b.page.getByRole('button', { name: 'Pronto' }).click();
  await a.page.waitForTimeout(1_500);
  const stillWatching = await a.page.evaluate(() => [...document.querySelectorAll('.tile--live video')].some((v) => v.videoWidth > 0));
  if (!stillWatching) throw new Error('o espectador perdeu a live ao trocar a fonte');
  log('  live: qualidade e fonte trocadas no ar, espectador continuou assistindo');
  await a.page.mouse.move(5, 5);
  await shot(a.page, 'chamada-live');

  // atalho padrão (Ctrl+Shift+M) silencia e volta
  const micBefore = await c.page.evaluate(() => window.__orbita.getApp().micOn);
  await c.page.keyboard.press('Control+Shift+KeyM');
  await waitFor(c.page, (before) => window.__orbita.getApp().micOn !== before, micBefore);
  await c.page.keyboard.press('Control+Shift+KeyM');
  await waitFor(c.page, (before) => window.__orbita.getApp().micOn === before, micBefore);
  log('  atalho do microfone ok');

  await a.context.close();
  await waitFor(b.page, () => window.__orbita.getApp().isHost === true, null, 60_000);
  await waitFor(
    c.page,
    () => {
      const s = window.__orbita.getApp();
      return s.net === 'connected' && s.room?.members.find((m) => m.id === s.room.hostId)?.name === 'Bruno';
    },
    null,
    60_000,
  );
  await waitFor(c.page, () => Object.keys(window.__orbita.getApp().voiceStreams).length === 1, null, 30_000);
  log('  host caiu → Bruno assumiu, Carla reconectou e a voz continuou:', await membersOf(c.page));

  await c.page.locator('.composer textarea').fill('Ainda aqui depois da troca de host!');
  await c.page.keyboard.press('Enter');
  await waitFor(b.page, () => document.querySelector('.messages')?.textContent?.includes('depois da troca de host'));
  log('  chat e histórico ok depois da migração');

  await b.page.locator('.people .person', { hasText: 'Carla' }).click();
  await b.page.getByRole('button', { name: /Remover da órbita/ }).click();
  await b.page.getByRole('button', { name: /^Remover$/ }).click();
  await waitFor(c.page, () => window.__orbita.getApp().phase === 'ended', null, 15_000);
  log('  expulsão ok');
}

/**
 * Filtros de voz (RNNoise + portão), pressionar para falar, passar a coroa e continuar;
 * host sair escolhendo o sucessor; encerrar; layout de celular.
 */
async function passarCoroa(opened) {
  const filters = { noiseFilter: 'rnnoise', noiseGate: true, highpass: true, compressor: true, voiceMode: 'ptt', keybinds: { pushToTalk: 'KeyV' } };
  const a = await newUser('Ana', '#8b5cf6', opened, { width: 1280, height: 800 }, filters);
  const b = await newUser('Bruno', '#22d3ee', opened, { width: 390, height: 844 });
  const code = await createRoom(a);
  await joinRoom(b, code);
  await joinCall(a);
  await joinCall(b);
  for (const u of [a, b]) await waitFor(u.page, () => Object.keys(window.__orbita.getApp().voiceStreams).length === 1, null, 45_000);
  const filterFailed = await a.page.evaluate(() => document.body.textContent.includes('Não consegui carregar'));
  if (filterFailed) throw new Error('a supressão de ruído RNNoise não carregou');
  // pressionar para falar: só transmite com a tecla segurada
  await a.page.evaluate(() => document.activeElement?.blur());
  await a.page.keyboard.down('KeyV');
  await waitFor(a.page, () => window.__orbita.getApp().pttDown === true);
  await a.page.keyboard.up('KeyV');
  await waitFor(a.page, () => window.__orbita.getApp().pttDown === false);
  log('  filtros de voz (RNNoise, portão, graves, compressor) e pressionar para falar ok');
  await b.page.waitForTimeout(1_000);
  await shot(b.page, 'celular-orbita');
  log('  Ana + Bruno (celular) na voz');

  await b.page.getByRole('button', { name: 'Mostrar o chat' }).click();
  await b.page.locator('.composer textarea').fill('Oi do celular!');
  await b.page.keyboard.press('Enter');
  await waitFor(a.page, () => document.querySelector('.messages')?.textContent?.includes('Oi do celular'));
  await shot(b.page, 'celular-chat');
  await b.page.locator('.chat-panel').getByRole('button', { name: 'Esconder o chat' }).click();
  log('  chat no celular ok');

  await a.page.locator('.people .person', { hasText: 'Bruno' }).click();
  await a.page.getByRole('button', { name: /Tornar host/ }).click();
  await a.page.getByRole('button', { name: /Passar a coroa/ }).click();
  await waitFor(b.page, () => window.__orbita.getApp().isHost === true, null, 45_000);
  await waitFor(a.page, () => {
    const s = window.__orbita.getApp();
    return !s.isHost && s.net === 'connected' && s.room?.members.length === 2;
  }, null, 45_000);
  await waitFor(a.page, () => Object.keys(window.__orbita.getApp().voiceStreams).length === 1, null, 20_000);
  log('  coroa passada para o Bruno; Ana continuou como membro, voz intacta');

  await b.page.getByRole('button', { name: 'Pessoas na órbita' }).click();
  await b.page.locator('.people__room').click();
  await b.page.getByRole('menuitem', { name: /Sair ou encerrar/ }).click();
  await b.page.getByRole('button', { name: /Passar a coroa e sair/ }).click();
  await waitFor(b.page, () => window.__orbita.getApp().phase === 'landing', null, 20_000);
  await waitFor(a.page, () => {
    const s = window.__orbita.getApp();
    return s.isHost && s.net === 'connected' && s.room?.members.length === 1;
  }, null, 45_000);
  log('  Bruno saiu passando a coroa; Ana é host de novo');

  await a.page.locator('.people__room').click();
  await a.page.getByRole('menuitem', { name: /Sair ou encerrar/ }).click();
  await a.page.getByRole('button', { name: /Encerrar e sair/ }).click();
  await waitFor(a.page, () => window.__orbita.getApp().phase === 'landing', null, 15_000);
  log('  sala encerrada');
}

// ───────────────────────── execução ─────────────────────────

let failed = false;
for (const [name, scenario] of [
  ['chamada completa + queda do host', chamadaCompleta],
  ['passar a coroa + celular', passarCoroa],
]) {
  log(`▶ ${name}`);
  const opened = [];
  try {
    await scenario(opened);
    log(`✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`❌ ${name}: ${err.message}`);
  } finally {
    for (const context of opened) await context.close().catch(() => {});
  }
}

await browser.close();
await server.close();
log(failed ? 'algum cenário falhou' : 'todos os cenários passaram');
process.exit(failed ? 1 : 0);
