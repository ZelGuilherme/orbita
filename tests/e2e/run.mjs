// Testes ponta a ponta da Órbita: navegadores reais conversando por P2P.
//
//   npm run test:e2e
//
// Sobe o Vite em modo dev, abre várias pessoas no Edge/Chrome instalado (com câmera e
// microfone falsos) e usa o servidor público do PeerJS. Capturas vão para test-results/.
// Variáveis: E2E_BROWSER=chrome|msedge, E2E_HEADED=1 para ver as janelas.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = join(root, 'test-results');
mkdirSync(SHOTS, { recursive: true });
const CHANNEL = process.env.E2E_BROWSER ?? (process.platform === 'win32' ? 'msedge' : 'chrome');

const t0 = Date.now();
/** Cada execução usa um ponto de encontro (lista de órbitas) só seu, longe do de verdade. */
const LOBBY = `orbita-e2e-${Math.random().toString(36).slice(2, 10)}`;
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
    ([n, c, extra, lobby]) => {
      localStorage.setItem('orbita.lobbyId', lobby);
      if (!sessionStorage.getItem('e2e.init')) {
        sessionStorage.setItem('e2e.init', '1');
        localStorage.setItem(
          'orbita.profile.v1',
          JSON.stringify({ id: (Math.random().toString(36).slice(2, 12) + 'abcdefgh').slice(0, 16), name: n, color: c }),
        );
        if (extra) localStorage.setItem('orbita.settings.v1', JSON.stringify(extra));
      }
      window.__displayCalls = 0;
      // sem a janela "salvar como" (a gravação cai no download comum)
      window.showSaveFilePicker = undefined;
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
    [name, color, settings, LOBBY],
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

/** Quem cria ou entra na sala já cai na chamada sozinho. */
async function joinCall(user) {
  await waitFor(user.page, () => window.__orbita.getApp().inCall, null, 15_000);
}

// ───────────────────────── cenários ─────────────────────────

/** 3 pessoas: chat, reação, malha de voz, câmera, live, queda do host e expulsão. */
async function chamadaCompleta(opened) {
  const a = await newUser('Ana', '#8b5cf6', opened);
  const b = await newUser('Bruno', '#22d3ee', opened);
  // a Carla vem de uma versão antiga, com os filtros desligados: a migração liga todos
  const c = await newUser('Carla', '#f472b6', opened, undefined, { version: 3, noiseFilter: 'off', noiseGate: false, highpass: false, compressor: false, vadAuto: false });
  const code = await createRoom(a);
  await joinRoom(b, code);
  await joinRoom(c, code);
  await waitFor(a.page, () => window.__orbita.getApp().room?.members.length === 3);
  log('  sala', code, '→', await membersOf(a.page));
  for (const u of [a, b, c]) await joinCall(u);
  log('  todos caíram direto na chamada, de microfone mutado:', (await Promise.all([a, b, c].map((u) => u.page.evaluate(() => window.__orbita.getApp().micOn)))).join(', '));
  for (const u of [a, c]) {
    const f = await u.page.evaluate(() => {
      const s = window.__orbita.getApp().settings;
      return `${s.noiseFilter} portão=${s.noiseGate} graves=${s.highpass} compressor=${s.compressor} auto=${s.vadAuto}`;
    });
    if (f !== 'rnnoise portão=true graves=true compressor=true auto=true') throw new Error(`${u.name}: filtros fora do padrão: ${f}`);
  }
  log('  filtros ligados por padrão (e migrados para quem tinha desligado)');

  await b.page.locator('.composer textarea').fill('Olá @Ana! Testando a órbita 🚀 com **negrito**');
  await b.page.keyboard.press('Enter');
  await waitFor(a.page, () => document.querySelector('.messages')?.textContent?.includes('Testando a órbita'));
  await waitFor(c.page, () => document.querySelector('.messages')?.textContent?.includes('Testando a órbita'));
  await a.page.locator('.msg', { hasText: 'Testando a órbita' }).hover();
  await a.page.locator('.msg', { hasText: 'Testando a órbita' }).getByRole('button', { name: 'Reagir' }).click();
  await a.page.locator('.reaction-picker button').first().click();
  await waitFor(b.page, () => !!document.querySelector('.reaction'));
  log('  chat e reação ok');

  // responder: a citação aparece para todos
  const original = () => b.page.locator('.msg', { hasText: 'Testando a órbita' }).first();
  await original().hover();
  await original().getByRole('button', { name: 'Responder' }).click();
  await b.page.locator('.composer__reply').waitFor();
  await b.page.locator('.composer textarea').fill('Respondendo a mim mesmo');
  await b.page.keyboard.press('Enter');
  await waitFor(c.page, () => window.__orbita.getApp().messages.some((m) => m.text === 'Respondendo a mim mesmo' && m.replyTo?.authorName === 'Bruno'));
  await waitFor(c.page, () => [...document.querySelectorAll('.msg__reply')].some((el) => el.textContent.includes('Testando a órbita')));
  log('  responder ok');

  // fixar: só o host tem o botão; a barra de fixadas aparece para todos
  await original().hover();
  if ((await original().getByRole('button', { name: 'Fixar' }).count()) !== 0) throw new Error('quem não é host conseguiu fixar');
  const pinTarget = a.page.locator('.msg', { hasText: 'Testando a órbita' }).first();
  await pinTarget.hover();
  await pinTarget.getByRole('button', { name: 'Fixar' }).click();
  await waitFor(c.page, () => document.querySelector('.pinned-bar')?.textContent?.includes('Testando a órbita'));
  await c.page.locator('.pinned-bar__main').click();
  await c.page.locator('.pinned-list__go').first().click();
  await waitFor(c.page, () => !document.querySelector('.pinned-list'));
  log('  fixar ok (só o host)');

  // busca sem diferenciar acento e maiúscula
  await c.page.getByRole('button', { name: 'Buscar no chat' }).click();
  await c.page.locator('.chat-search input').fill('TESTÁNDO');
  await waitFor(c.page, () => document.querySelectorAll('.search-hit').length >= 1);
  await c.page.locator('.search-hit').first().click();
  await waitFor(c.page, () => !document.querySelector('.chat-search') && !!document.querySelector('.msg'));
  log('  busca ok');

  // arquivo: vai direto do computador da Ana para quem baixa
  const big = Buffer.alloc(3 * 1024 * 1024 + 321, 7);
  await a.page.locator('input[aria-label="Escolher arquivo"]').setInputFiles({ name: 'dados.bin', mimeType: 'application/octet-stream', buffer: big });
  await a.page.locator('.composer__file').waitFor();
  await a.page.locator('.composer textarea').fill('segue o arquivo');
  await a.page.keyboard.press('Enter');
  const card = c.page.locator('.file-card', { hasText: 'dados.bin' });
  await card.waitFor();
  const [download] = await Promise.all([c.page.waitForEvent('download', { timeout: 60_000 }), card.getByRole('button', { name: /Baixar/ }).click()]);
  const got = statSync(await download.path()).size;
  if (got !== big.length) throw new Error(`arquivo chegou com ${got} bytes, esperado ${big.length}`);
  log('  arquivo P2P ok:', (got / 1024 / 1024).toFixed(1), 'MB baixados direto de quem mandou');

  // foto de perfil: o Bruno escolhe uma foto e a Ana vê na lista de pessoas
  const png = await b.page.screenshot({ clip: { x: 0, y: 0, width: 64, height: 64 } });
  await b.page.getByRole('button', { name: 'Configurações' }).last().click();
  await b.page.locator('.avatar-buttons input[type=file]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
  await b.page.locator('.settings__close').click();
  await waitFor(a.page, () => [...document.querySelectorAll('.people .person')].some((el) => el.textContent.includes('Bruno') && el.querySelector('img.planet__photo')), null, 10_000);
  log('  foto de perfil ok');

  // planeta personalizado (anéis e luas) aparece para os outros; o host tem coroa
  await b.page.getByRole('button', { name: 'Configurações' }).last().click();
  await b.page.locator('.planet-editor .field', { hasText: 'Anéis' }).getByRole('button', { name: '2' }).click();
  await b.page.locator('.planet-editor .field', { hasText: 'Luas' }).getByRole('button', { name: '3' }).click();
  await b.page.locator('.settings__close').click();
  await waitFor(
    a.page,
    () => {
      const row = [...document.querySelectorAll('.people .person')].find((el) => el.textContent.includes('Bruno'));
      return row && row.querySelectorAll('.planet__ring').length === 4 && row.querySelectorAll('.planet__moon').length === 3;
    },
    null,
    10_000,
  );
  const crown = await b.page.evaluate(() => !![...document.querySelectorAll('.people .person')].find((el) => el.textContent.includes('Ana'))?.querySelector('.planet__crown'));
  if (!crown) throw new Error('o host (Ana) está sem a coroa');
  log('  planeta personalizado e coroa do host ok');

  for (const u of [a, b, c]) {
    await waitFor(u.page, () => Object.keys(window.__orbita.getApp().voiceStreams).length === 2, null, 45_000);
  }
  log('  malha de voz completa');

  // barras de qualidade da conexão, com ping e perda no título
  await waitFor(a.page, () => document.querySelectorAll('.people .signal').length >= 2, null, 15_000);
  log('  qualidade da conexão:', await a.page.locator('.people .signal').first().getAttribute('title'));

  // soundboard: a Ana toca a buzina; o Bruno vê quem tocou; a Carla desligou os sons dos outros
  await c.page.evaluate(() => {
    const s = window.__orbita.getApp().settings;
    localStorage.setItem('orbita.settings.v1', JSON.stringify({ ...s, soundboardOthers: false }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'orbita.settings.v1', storageArea: localStorage }));
  });
  await waitFor(c.page, () => window.__orbita.getApp().settings.soundboardOthers === false);
  await a.page.getByRole('button', { name: 'Sons e efeitos' }).click();
  await a.page.locator('.sound-btn', { hasText: 'Buzina' }).click();
  if (!(await a.page.locator('.sound-btn', { hasText: 'Sino' }).isDisabled())) throw new Error('o soundboard não esperou 2 s entre um som e outro');
  // o host também barra quem manda sons rápido demais (direto pela rede, sem o botão)
  await a.page.evaluate(() => window.__orbita.session().send({ t: 'sound', id: 'bell' }));
  await waitFor(b.page, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Ana: Buzina')), null, 10_000);
  await new Promise((r) => setTimeout(r, 800));
  if (await c.page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Buzina')))) throw new Error('a Carla ouviu o som mesmo desligando');
  if ((await b.page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => t.textContent.includes('Sino')).length)) > 0) throw new Error('o host deixou passar dois sons em menos de 2 s');
  log('  soundboard ok: todos ouvem, limite de 2 s (também no host) e opção de não ouvir os outros');

  // efeitos de voz: robô e voz grossa carregam sem derrubar a voz
  for (const effect of ['robot', 'deep', 'radio', 'none']) {
    await a.page.locator('.sound-panel .chip', { hasText: { robot: 'Robô', deep: 'Voz grossa', radio: 'Rádio', none: 'Normal' }[effect] }).click();
    await waitFor(a.page, (e) => window.__orbitaMedia?.voiceProc?.effectKind === e, effect, 10_000);
  }
  await a.page.keyboard.press('Escape');
  await a.page.mouse.click(5, 5);
  await waitFor(b.page, () => Object.keys(window.__orbita.getApp().voiceStreams).length === 2, null, 10_000);
  log('  efeitos de voz ok (robô, voz grossa, rádio e normal)');
  const threshold = await a.page.evaluate(() => window.__orbitaMedia.voiceProc?.threshold);
  if (!(threshold >= 0.22 && threshold <= 0.7)) throw new Error(`sensibilidade automática fora da faixa: ${threshold}`);
  log('  sensibilidade automática ativa, limiar', threshold.toFixed(2));

  // voz travada: o Bruno para de mandar para a Ana sem fechar a conexão; a voz é refeita sozinha
  const bId = await b.page.evaluate(() => window.__orbita.getApp().meId);
  await a.page.evaluate((id) => {
    window.__oldVoice = window.__orbita.getApp().voiceStreams[id];
  }, bId);
  const aPeer = await a.page.evaluate(() => window.__orbita.session().peer.id);
  await b.page.evaluate(async (peerId) => {
    const link = window.__orbitaMedia.voice.get(peerId);
    for (const sender of link.call.peerConnection.getSenders()) await sender.replaceTrack(null);
  }, aPeer);
  await waitFor(
    a.page,
    (id) => {
      const now = window.__orbita.getApp().voiceStreams[id];
      return !!now && now !== window.__oldVoice;
    },
    bId,
    45_000,
  );
  for (const u of [a, b, c]) {
    await waitFor(u.page, () => Object.keys(window.__orbita.getApp().voiceStreams).length === 2, null, 30_000);
  }
  log('  voz travada foi reconectada sozinha');
  await a.page.waitForTimeout(1_000);
  await shot(a.page, 'chamada-orbita');

  await a.page.getByRole('button', { name: 'Ligar câmera' }).last().click();
  // a câmera aparece dentro do planeta de quem ligou
  await waitFor(b.page, () => [...document.querySelectorAll('.orbit .planet.has-video video')].some((v) => v.videoWidth > 0));
  // clicar no planeta com câmera abre grande no centro; fechar volta para a órbita
  await b.page.getByRole('button', { name: 'Ana: ver câmera' }).click();
  await waitFor(b.page, () => [...document.querySelectorAll('.stage-featured .tile video')].some((v) => v.videoWidth > 0), null, 10_000);
  await b.page.locator('.stage-featured .tile').hover();
  await b.page.getByRole('button', { name: /Fechar a câmera/ }).click();
  await waitFor(b.page, () => !document.querySelector('.stage-featured') && !!document.querySelector('.orbit'), null, 10_000);
  if (await b.page.evaluate(() => !!document.querySelector('.call .grid'))) throw new Error('ainda aparecem quadrados no centro');
  log('  câmera ok: dentro do planeta, abre grande ao clicar e fecha de volta');

  await b.page.getByRole('button', { name: 'Iniciar live' }).last().click();
  await b.page.getByRole('button', { name: /Escolher o que transmitir/ }).click();
  await waitFor(a.page, () => window.__orbita.getApp().room?.members.some((m) => m.live), null, 20_000);
  await a.page.getByRole('button', { name: /Assistir live/ }).first().click();
  await waitFor(a.page, () => [...document.querySelectorAll('.tile--live video')].some((v) => v.videoWidth > 0));
  await waitFor(b.page, () => window.__orbita.getApp().live?.viewers === 1, null, 15_000);
  log('  live ok (1 espectador)');
  // a live fica grande; embaixo, a faixa de órbita, que dá para esconder e mostrar
  if (!(await a.page.evaluate(() => !!document.querySelector('.stage-featured .tile--live') && !!document.querySelector('.orbit-strip .orbit')))) {
    throw new Error('a live não ficou em destaque com a faixa de órbita embaixo');
  }
  await a.page.getByRole('button', { name: 'Esconder os planetas' }).click();
  await waitFor(a.page, () => !document.querySelector('.orbit-strip') && !!document.querySelector('.orbit-strip__show'));
  await a.page.locator('.orbit-strip__show').click();
  await waitFor(a.page, () => !!document.querySelector('.orbit-strip .orbit'));
  log('  live em destaque com a faixa de planetas (esconder e mostrar ok)');

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
  // acima de 100%: o <audio> fica mudo e o som sai pelo Web Audio, com ganho
  await a.page.locator('.live-volume input[type=range]').fill('250');
  await waitFor(a.page, () => Object.values(window.__orbita.getApp().liveVolumes).includes(250));
  await waitFor(a.page, () => [...document.querySelectorAll('audio')].some((el) => el.muted && el.srcObject?.getAudioTracks().length));
  await a.page.locator('.live-volume input[type=range]').fill('100');
  await waitFor(a.page, () => ![...document.querySelectorAll('audio')].some((el) => el.muted));
  log('  volume da live até 300% ok');

  // gravação: a Ana grava (vozes + a live do Bruno em destaque); todo mundo vê o aviso vermelho
  await a.page.getByRole('button', { name: 'Gravar a chamada' }).click();
  await waitFor(c.page, () => document.querySelector('.rec-notice')?.textContent?.includes('Gravando: Ana'), null, 10_000);
  await waitFor(b.page, () => document.querySelector('.rec-notice')?.textContent?.includes('Ana'), null, 10_000);
  if (!(await a.page.evaluate(() => window.__orbita.getApp().recording?.video))) throw new Error('a gravação não pegou a live em destaque');
  await new Promise((r) => setTimeout(r, 3_000));
  const [recFile] = await Promise.all([a.page.waitForEvent('download', { timeout: 30_000 }), a.page.getByRole('button', { name: 'Parar a gravação' }).click()]);
  const recSize = statSync(await recFile.path()).size;
  await recFile.saveAs(join(SHOTS, 'gravacao.webm'));
  if (recSize < 20_000 || !recFile.suggestedFilename().endsWith('.webm')) throw new Error(`gravação estranha: ${recFile.suggestedFilename()} ${recSize} bytes`);
  await waitFor(c.page, () => !document.querySelector('.rec-notice'), null, 10_000);
  log('  gravação ok:', recFile.suggestedFilename(), Math.round(recSize / 1024), 'KB; aviso apareceu e sumiu para todos');

  // clipes: desligados por padrão; ligando, o botão aparece e salva o último trecho
  if (await a.page.getByRole('button', { name: 'Salvar clipe do último minuto' }).count()) throw new Error('clipes ligados por padrão');
  await a.page.evaluate(() => {
    const s = window.__orbita.getApp().settings;
    localStorage.setItem('orbita.settings.v1', JSON.stringify({ ...s, clips: true }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'orbita.settings.v1', storageArea: localStorage }));
  });
  await new Promise((r) => setTimeout(r, 3_000));
  const [clipFile] = await Promise.all([a.page.waitForEvent('download', { timeout: 30_000 }), a.page.getByRole('button', { name: 'Salvar clipe do último minuto' }).click()]);
  const clipSize = statSync(await clipFile.path()).size;
  if (clipSize < 5_000) throw new Error(`clipe vazio: ${clipSize} bytes`);
  await waitFor(c.page, () => document.querySelector('.messages')?.textContent?.includes('salvou um clipe'), null, 10_000);
  await a.page.evaluate(() => {
    const s = window.__orbita.getApp().settings;
    localStorage.setItem('orbita.settings.v1', JSON.stringify({ ...s, clips: false }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'orbita.settings.v1', storageArea: localStorage }));
  });
  log('  clipe ok:', clipFile.suggestedFilename(), Math.round(clipSize / 1024), 'KB; o chat avisou');

  // live travada: quem transmite para de mandar (imagem e som) sem fechar a conexão;
  // quem assiste percebe sozinho e reconecta
  await a.page.evaluate(() => {
    window.__oldLive = Object.values(window.__orbita.getApp().liveStreams)[0];
  });
  await b.page.evaluate(async () => {
    for (const call of window.__orbitaMedia.liveOut.values()) {
      for (const sender of call.peerConnection.getSenders()) await sender.replaceTrack(null);
    }
  });
  await waitFor(
    a.page,
    () => {
      const now = Object.values(window.__orbita.getApp().liveStreams)[0];
      return !!now && now !== window.__oldLive && [...document.querySelectorAll('.tile--live video')].some((v) => v.videoWidth > 0);
    },
    null,
    40_000,
  );
  log('  live travada foi reconectada sozinha');

  // laser e lápis: aparecem para quem transmite e para quem assiste
  const laserOf = (page) =>
    page.evaluate(() => {
      const el = document.querySelector('.tile--live .fx-laser');
      const m = el?.style.transform.match(/translate\(([\d.]+)cqw, ([\d.]+)cqh\)/);
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    });
  await a.page.locator('.fx-bar').getByRole('button', { name: 'Laser' }).click();
  const stage = await a.page.locator('.tile--live .fx-stage').boundingBox();
  const at = (x, y) => [stage.x + stage.width * x, stage.y + stage.height * y];
  // sem apertar o botão do mouse, o laser não aparece
  await a.page.mouse.move(...at(0.25, 0.5));
  await a.page.mouse.move(...at(0.3, 0.45), { steps: 5 });
  await b.page.waitForTimeout(600);
  if (await b.page.evaluate(() => !!document.querySelector('.tile--live .fx-laser'))) throw new Error('o laser apareceu sem apertar o botão');
  await a.page.mouse.down();
  await a.page.mouse.move(...at(0.3, 0.4), { steps: 5 });
  await waitFor(b.page, () => !!document.querySelector('.tile--live .fx-laser'), null, 10_000);
  await b.page.waitForTimeout(400);
  const laserAt = await laserOf(b.page);
  if (!laserAt || Math.abs(laserAt.x - 30) > 1.5 || Math.abs(laserAt.y - 40) > 1.5) throw new Error(`laser fora do lugar: ${JSON.stringify(laserAt)}`);
  await a.page.mouse.up();
  await waitFor(b.page, () => !document.querySelector('.tile--live .fx-laser'), null, 10_000);
  log('  laser ok: só com o botão apertado, na tela de quem transmite em', laserAt);

  // pincel: cor, estilo e tamanho escolhidos aparecem para os outros
  await a.page.locator('.fx-bar').getByRole('button', { name: 'Lápis' }).click();
  await a.page.locator('.fx-opts').getByRole('button', { name: 'Cor #22c55e' }).click();
  await a.page.locator('.fx-opts').getByRole('button', { name: 'Neon' }).click();
  await a.page.locator('.fx-opts input[type=range]').fill('20');
  await a.page.mouse.move(...at(0.2, 0.2));
  await a.page.mouse.down();
  await a.page.mouse.move(...at(0.6, 0.7), { steps: 16 });
  await a.page.mouse.up();
  await waitFor(
    b.page,
    () => {
      const g = document.querySelector('.tile--live .fx-strokes .fx-neon');
      const path = g?.querySelector('path');
      return path?.getAttribute('stroke') === '#22c55e' && (path.getAttribute('d')?.split('L').length ?? 0) > 8;
    },
    null,
    10_000,
  );
  log('  pincel ok: cor, estilo neon e tamanho chegaram para quem transmite');

  // borracha: corta o traço no meio, que vira dois pedaços (para todo mundo)
  await a.page.locator('.fx-bar').getByRole('button', { name: 'Borracha' }).click();
  await a.page.mouse.move(...at(0.3, 0.55));
  await a.page.mouse.down();
  await a.page.mouse.move(...at(0.5, 0.35), { steps: 8 });
  await a.page.mouse.up();
  for (const u of [a, b]) await waitFor(u.page, () => document.querySelectorAll('.tile--live .fx-strokes .fx-neon').length === 2, null, 10_000);
  // quem começa a assistir depois recebe o desenho como ficou (já cortado)
  await c.page.getByRole('button', { name: /Assistir live/ }).first().click();
  await waitFor(c.page, () => document.querySelectorAll('.tile--live .fx-strokes .fx-neon').length === 2, null, 20_000);
  log('  borracha ok: o traço virou dois pedaços para todos, inclusive para quem chegou depois');
  await a.page.mouse.move(5, 5);
  await shot(b.page, 'live-lapis-streamer');
  await a.page.locator('.tile--live').first().hover();
  await a.page.locator('.fx-bar').getByRole('button', { name: 'Apagar tudo' }).click();
  for (const u of [a, b, c]) await waitFor(u.page, () => !document.querySelector('.tile--live .fx-strokes path'), null, 10_000);
  log('  apagar tudo ok para todo mundo');
  await c.page.getByRole('button', { name: 'Parar de assistir' }).click().catch(() => {});

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
  // quem mandou o arquivo saiu: ele fica indisponível
  await waitFor(c.page, () => [...document.querySelectorAll('.file-card')].some((el) => el.textContent.includes('indisponível')));
  log('  arquivo de quem saiu aparece como indisponível');

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

/** Lista de órbitas: pedir para entrar, aceitar, recusar, esconder e o ponto de encontro trocando de aba. */
async function saguao(opened) {
  const a = await newUser('Ana', '#8b5cf6', opened);
  const b = await newUser('Bruno', '#22d3ee', opened);
  const c = await newUser('Carla', '#f472b6', opened);
  const code = await createRoom(a);
  const roomName = await a.page.evaluate(() => window.__orbita.getApp().room.name);
  await b.page.goto(BASE);
  await c.page.goto(BASE);
  const listed = (page) => waitFor(page, (n) => window.__orbita.getApp().lobbyRooms.some((r) => r.name === n), roomName, 40_000);
  await listed(b.page);
  await listed(c.page);
  const leak = await b.page.evaluate((cd) => JSON.stringify(window.__orbita.getApp().lobbyRooms).includes(cd), code);
  if (leak) throw new Error('o código da sala vazou na lista');
  log('  órbita apareceu na lista (sem o código) para quem está na tela inicial');

  // Bruno pede para entrar; a Ana aceita; ele entra sem nunca ter visto o código
  await b.page.locator('.lobby-room', { hasText: roomName }).getByRole('button', { name: /Pedir para entrar/ }).click();
  await a.page.locator('.knock', { hasText: 'Bruno' }).waitFor({ timeout: 20_000 });
  await a.page.locator('.knock', { hasText: 'Bruno' }).getByRole('button', { name: 'Aceitar' }).click();
  await waitFor(b.page, (cd) => window.__orbita.getApp().phase === 'room' && window.__orbita.getApp().code === cd, code, 40_000);
  log('  pedido aceito: Bruno entrou na órbita');

  // aviso de versão diferente: mesma versão, sem aviso; alguém de versão antiga (sem versão) ganha o ⚠
  await waitFor(a.page, () => window.__orbita.getApp().room.members.every((m) => typeof m.build === 'string' && m.build.length > 2));
  if (await a.page.locator('.person__version').count()) throw new Error('aviso de versão aparecendo com todo mundo na mesma versão');
  await a.page.evaluate(() => {
    // alguém de versão antiga (sem versão) entra no estado da sala, direto no hub da Ana
    const hub = window.__orbita.session().hub;
    const bruno = hub.state.members.find((m) => m.name === 'Bruno');
    hub.state.members.push({ ...bruno, id: 'velho1234abcd.zz99', peerId: 'velho-peer-x', name: 'Velho', build: undefined, voiceChannelId: null, live: null, cameraOn: false });
    hub.pushState();
  });
  await a.page.locator('.person', { hasText: 'Velho' }).locator('.person__version').waitFor({ timeout: 5_000 });
  log('  aviso de versão diferente ok');

  // Carla pede; a Ana recusa
  await c.page.locator('.lobby-room', { hasText: roomName }).getByRole('button', { name: /Pedir para entrar/ }).click();
  await a.page.locator('.knock', { hasText: 'Carla' }).waitFor({ timeout: 20_000 });
  await a.page.locator('.knock', { hasText: 'Carla' }).getByRole('button', { name: /Recusar/ }).click();
  await waitFor(c.page, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('recusou')), null, 20_000);
  if (await c.page.evaluate(() => window.__orbita.getApp().phase !== 'landing')) throw new Error('a Carla entrou mesmo recusada');
  log('  pedido recusado: Carla continuou de fora');

  // esconder e mostrar de novo
  await a.page.locator('.people__room').click();
  await a.page.getByRole('menuitem', { name: /Esconder da lista/ }).click();
  await waitFor(c.page, (n) => !window.__orbita.getApp().lobbyRooms.some((r) => r.name === n), roomName, 20_000);
  await a.page.locator('.people__room').click();
  await a.page.getByRole('menuitem', { name: /Mostrar na lista/ }).click();
  await listed(c.page);
  log('  host escondeu e mostrou a órbita na lista');
  await shot(c.page, 'saguao');

  // quem segura o ponto de encontro fecha: outra aba assume e a sala volta para a lista
  const holder = (await Promise.all([a, b, c].map((u) => u.page.evaluate(() => !!window.__orbitaLobby?.isServer)))).findIndex(Boolean);
  log('  ponto de encontro está com', ['Ana', 'Bruno', 'Carla'][holder] ?? 'ninguém visível');
  await a.context.close();
  await waitFor(b.page, () => window.__orbita.getApp().isHost === true, null, 60_000);
  await waitFor(c.page, (n) => window.__orbita.getApp().lobbyRooms.some((r) => r.name === n && r.hostName === 'Bruno'), roomName, 90_000);
  log('  Ana (host e ponto de encontro) saiu: a lista voltou com o Bruno de host');
}

/** Extensão de atalhos carregada no navegador: o atalho chega na página e liga/desliga o microfone. */
async function extensao(opened) {
  // cópia da extensão apontando para o servidor de teste
  const dir = mkdtempSync(join(tmpdir(), 'orbita-ext-'));
  const profile = mkdtempSync(join(tmpdir(), 'orbita-prof-'));
  cpSync(join(root, 'extension'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const origin = `${new URL(BASE).origin}/*`;
  manifest.host_permissions = [origin];
  manifest.content_scripts[0].matches = [origin];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: CHANNEL,
    headless: !process.env.E2E_HEADED,
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone', 'camera'],
    args: [
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });
  opened.push({ close: async () => { await context.close(); rmSync(dir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true }); } });
  await context.addInitScript((lobby) => localStorage.setItem('orbita.lobbyId', lobby), LOBBY);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (err) => console.log('        [extensão ERRO]', err.message));
  await page.goto(BASE);
  await waitFor(page, () => !!window.__orbita?.getApp().extension, null, 15_000);
  log('  a página reconheceu a extensão (versão', await page.evaluate(() => window.__orbita.getApp().extension), ')');
  await page.getByRole('button', { name: /Criar e virar host/ }).click();
  await waitFor(page, () => window.__orbita.getApp().inCall, null, 30_000);
  await page.keyboard.press('Escape');
  const before = await page.evaluate(() => window.__orbita.getApp().micOn);
  // o mesmo caminho do atalho: o service worker manda para a aba do Órbita
  const run = (command) =>
    worker.evaluate(async (cmd) => {
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getManifest().content_scripts[0].matches });
      const reply = await chrome.tabs.sendMessage(tabs[0].id, { orbita: cmd });
      return !!reply?.handled;
    }, command);
  if (!(await run('microfone'))) throw new Error('a página não cuidou do atalho do microfone');
  await waitFor(page, (b) => window.__orbita.getApp().micOn !== b, before);
  await run('ensurdecer');
  await waitFor(page, () => window.__orbita.getApp().deafened === true);
  log('  atalhos da extensão ok: microfone e ensurdecer mudaram na página');
}

// ───────────────────────── execução ─────────────────────────

let failed = false;
for (const [name, scenario] of [
  ['chamada completa + queda do host', chamadaCompleta],
  ['passar a coroa + celular', passarCoroa],
  ['lista de órbitas (saguão)', saguao],
  ['extensão de atalhos', extensao],
]) {
  // E2E_ONLY=trecho roda só os cenários cujo nome contém o trecho
  if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) continue;
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
