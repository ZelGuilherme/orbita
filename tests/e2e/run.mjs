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

// servidor de sinalização local (não depende do servidor público do PeerJS, que limita conexões)
const { PeerServer } = await import('peer');
const SIGNAL_PORT = 9411;
const signaling = PeerServer({ port: SIGNAL_PORT, path: '/' });
const NETWORK = { host: 'localhost', port: SIGNAL_PORT, path: '/', secure: false, key: 'peerjs', iceServersJson: '' };

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
    ([n, c, extra, lobby, network]) => {
      localStorage.setItem('orbita.lobbyId', lobby);
      if (!sessionStorage.getItem('e2e.init')) {
        sessionStorage.setItem('e2e.init', '1');
        localStorage.setItem(
          'orbita.profile.v1',
          JSON.stringify({ id: (Math.random().toString(36).slice(2, 12) + 'abcdefgh').slice(0, 16), name: n, color: c }),
        );
        localStorage.setItem('orbita.settings.v1', JSON.stringify({ ...(extra ?? {}), network }));
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
    [name, color, settings, LOBBY, NETWORK],
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

/** Fecha a janela de convite que abre ao criar a sala (ela carrega sob demanda). */
async function closeInvite(page) {
  await page.locator('.modal-backdrop').waitFor({ timeout: 10_000 }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
}

async function createRoom(user) {
  await user.page.goto(BASE);
  await user.page.getByRole('button', { name: /Criar e virar host/ }).click();
  await waitFor(user.page, () => window.__orbita?.getApp().phase === 'room');
  await closeInvite(user.page);
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

  // arquivo grande: grava direto no "disco" (janela de salvar simulada) e continua depois de uma queda
  const huge = Buffer.alloc(24 * 1024 * 1024 + 77);
  for (let i = 0; i < huge.length; i += 4096) huge[i] = (i / 4096) & 255;
  await a.page.locator('input[aria-label="Escolher arquivo"]').setInputFiles({ name: 'grande.bin', mimeType: 'application/octet-stream', buffer: huge });
  await a.page.locator('.composer__file').waitFor();
  await a.page.keyboard.press('Enter');
  await b.page.evaluate(() => {
    localStorage.setItem('orbita.diskFrom', String(10 * 1024 * 1024));
    window.__disk = { bytes: 0, sum: 0, closed: false, states: [] };
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (blob) => {
          const buf = new Uint8Array(await blob.arrayBuffer());
          for (let i = 0; i < buf.length; i++) if ((window.__disk.bytes + i) % 4096 === 0) window.__disk.sum += buf[i];
          window.__disk.bytes += buf.length;
        },
        close: async () => {
          window.__disk.closed = true;
        },
        abort: async () => {},
      }),
    });
  });
  const bigCard = b.page.locator('.file-card', { hasText: 'grande.bin' });
  await bigCard.waitFor();
  await bigCard.getByRole('button', { name: /Baixar/ }).click();
  const bigId = await b.page.evaluate(() => window.__orbita.getApp().messages.find((m) => m.attachment?.name === 'grande.bin').attachment.fileId);
  // derruba a conexão no meio: tem que voltar sozinho e continuar de onde parou
  await waitFor(b.page, (id) => (window.__orbita.getApp().transfers[id]?.received ?? 0) > 1024 * 1024, bigId, 30_000);
  const before = await b.page.evaluate((id) => window.__orbita.getApp().transfers[id].received, bigId);
  await b.page.evaluate((id) => window.__orbitaFiles.breakConnection(id), bigId);
  await waitFor(b.page, (id) => window.__orbita.getApp().transfers[id]?.status === 'retrying', bigId, 5_000);
  await waitFor(b.page, () => window.__disk.closed, null, 90_000);
  const disk = await b.page.evaluate(() => window.__disk);
  let expectedSum = 0;
  for (let i = 0; i < huge.length; i += 4096) expectedSum += huge[i];
  if (disk.bytes !== huge.length || disk.sum !== expectedSum) throw new Error(`arquivo grande chegou errado: ${disk.bytes} bytes (esperado ${huge.length}), soma ${disk.sum}/${expectedSum}`);
  log('  arquivo grande ok: gravado direto no disco, a conexão caiu em', (before / 1024 / 1024).toFixed(1), 'MB e continuou de onde parou');

  // foto de perfil: o Bruno escolhe uma foto e a Ana vê na lista de pessoas
  const png = await b.page.screenshot({ clip: { x: 0, y: 0, width: 64, height: 64 } });
  await b.page.getByRole('button', { name: 'Configurações' }).last().click();
  await b.page.locator('.avatar-buttons input[type=file]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
  await b.page.locator('.settings__close').click();
  await waitFor(
    a.page,
    () => {
      const s = window.__orbita.getApp();
      const bruno = s.room.members.find((m) => m.name === 'Bruno');
      const row = [...document.querySelectorAll('.people .person')].find((el) => el.textContent.includes('Bruno'));
      return !!bruno && !!s.avatars[bruno.id] && !!row?.querySelector('img.planet__photo, img.planet__img');
    },
    null,
    15_000,
  );
  log('  foto de perfil ok');

  // planeta personalizado (anéis e luas) aparece para os outros; o host tem coroa
  await b.page.getByRole('button', { name: 'Configurações' }).last().click();
  await b.page.locator('.settings__nav button', { hasText: 'Planeta' }).click();
  // superfície: lava com cores escolhidas e a foto menos visível
  await b.page.locator('.texture-tile', { hasText: 'Lava' }).click();
  await b.page.locator('input[aria-label="Cor: Lava"]').fill('#22d3ee');
  await b.page.getByLabel('Visibilidade da foto').fill('30');
  await b.page.locator('.studio__tab', { hasText: 'Anéis' }).click();
  await b.page.getByRole('radio', { name: '2', exact: true }).click();
  await b.page.locator('.studio__tab', { hasText: 'Luas' }).click();
  await b.page.getByRole('radio', { name: '3', exact: true }).click();
  await b.page.locator('.settings__close').click();
  await waitFor(
    a.page,
    () => {
      const bruno = window.__orbita.getApp().room.members.find((m) => m.name === 'Bruno');
      const row = [...document.querySelectorAll('.people .person')].find((el) => el.textContent.includes('Bruno'));
      // no 3D a lista mostra uma imagem do planeta; no 2D, os anéis e luas em CSS
      const drawn = row && (row.querySelector('img.planet__img') || (row.querySelectorAll('.planet__ring').length === 4 && row.querySelectorAll('.planet__moon').length === 3));
      const p = bruno?.planet;
      return p?.rings === 2 && p.moons === 3 && p.texture === 'lava' && p.texColors?.lava === '#22d3ee' && p.photoMix === 0.3 && !!drawn;
    },
    null,
    10_000,
  );
  const crown = await b.page.evaluate(() => !![...document.querySelectorAll('.people .person')].find((el) => el.textContent.includes('Ana'))?.querySelector('.planet__crown'));
  if (!crown) throw new Error('o host (Ana) está sem a coroa');
  log('  planeta personalizado (lava com cor escolhida, foto a 30%, anéis e luas) e coroa do host ok');

  for (const u of [a, b, c]) {
    await waitFor(u.page, () => Object.keys(window.__orbita.getApp().voiceStreams).length === 2, null, 45_000);
  }
  log('  malha de voz completa');

  // órbita em 3D: a cena desenha; o Bruno arrasta o próprio planeta e a órbita nova chega para a Ana
  await waitFor(b.page, () => !!window.__orbitaScene && !!document.querySelector('.orbit3d__canvas'), null, 30_000);
  await b.page.waitForTimeout(1_500);
  const dragId = await b.page.evaluate(() => window.__orbita.getApp().meId);
  const box3d = await b.page.locator('.call .orbit3d').first().boundingBox();
  // espera o planeta do Bruno estar à vista (não escondido atrás do host)
  await waitFor(b.page, (id) => {
    const p = window.__orbitaScene.screenPosition(id);
    return !!p && window.__orbitaScene.pickAt(p.x, p.y) === id;
  }, dragId, 20_000);
  const dragAt = await b.page.evaluate((id) => window.__orbitaScene.screenPosition(id), dragId);
  await b.page.mouse.move(box3d.x + dragAt.x, box3d.y + dragAt.y);
  await b.page.mouse.down();
  const to = { x: box3d.x + box3d.width * 0.85, y: box3d.y + box3d.height * 0.32 };
  for (let i = 1; i <= 10; i++) {
    await b.page.mouse.move(box3d.x + dragAt.x + ((to.x - box3d.x - dragAt.x) * i) / 10, box3d.y + dragAt.y + ((to.y - box3d.y - dragAt.y) * i) / 10);
    await b.page.waitForTimeout(16);
  }
  for (let i = 1; i <= 4; i++) {
    await b.page.mouse.move(to.x, to.y + i * 20);
    await b.page.waitForTimeout(12);
  }
  await b.page.mouse.up();
  const myOrbit = await b.page.evaluate(() => window.__orbita.getApp().profile.orbit);
  if (!myOrbit || !(myOrbit.radius > 2)) throw new Error('arrastar o planeta não mudou a órbita');
  await waitFor(a.page, ([id, r]) => window.__orbita.getApp().room.members.find((m) => m.id === id)?.orbit?.radius === r, [dragId, myOrbit.radius], 10_000);
  log('  órbita 3D: Bruno arrastou o planeta (raio', myOrbit.radius, 'inclinação', myOrbit.incl, 'velocidade', myOrbit.speed, 'sentido', myOrbit.dir, ') e a Ana recebeu');
  // ninguém entra em ninguém: Bruno e Carla na mesma órbita, em sentidos opostos (batem a cada ~3,5 s)
  const setOrbit = (page, orbit) =>
    page.evaluate((o) => {
      const p = JSON.parse(localStorage.getItem('orbita.profile.v1'));
      localStorage.setItem('orbita.profile.v1', JSON.stringify({ ...p, orbit: o }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'orbita.profile.v1', storageArea: localStorage }));
    }, orbit);
  await setOrbit(b.page, { radius: 3.8, incl: 0, node: 0, speed: 0.9, dir: 1, phase: 0 });
  await setOrbit(c.page, { radius: 3.8, incl: 0, node: 0, speed: 0.9, dir: -1, phase: 0 });
  await waitFor(a.page, () => window.__orbita.getApp().room.members.filter((m) => m.orbit?.speed === 0.9).length === 2, null, 10_000);
  const gaps = await a.page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 80; i++) {
      out.push(window.__orbitaScene.minGap());
      await new Promise((r) => setTimeout(r, 100));
    }
    return out;
  });
  const worst = Math.min(...gaps);
  if (worst < 0) throw new Error(`um planeta entrou no outro (folga mínima ${worst.toFixed(2)})`);
  log('  planetas se desviam: em 8 s de encontros de frente, a menor folga foi', worst.toFixed(2));

  // reações: clique estoura em volta de quem mandou; arrastar até um planeta voa até essa pessoa
  await a.page.getByRole('button', { name: 'Reações' }).click();
  await a.page.getByRole('button', { name: 'Reagir com 🔥' }).click();
  await waitFor(b.page, () => [...document.querySelectorAll('.fling')].some((el) => el.textContent === '🔥'), null, 10_000);
  await a.page.waitForTimeout(1_100);
  const brunoAt = await a.page.evaluate((id) => window.__orbitaScene.screenPosition(id), dragId);
  const orbitBox = await a.page.locator('.call .orbit3d').first().boundingBox();
  const pick = await a.page.getByRole('button', { name: 'Reagir com 😂' }).boundingBox();
  await a.page.mouse.move(pick.x + pick.width / 2, pick.y + pick.height / 2);
  await a.page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const tx = orbitBox.x + brunoAt.x;
    const ty = orbitBox.y + brunoAt.y;
    await a.page.mouse.move(pick.x + ((tx - pick.x) * i) / 12, pick.y + ((ty - pick.y) * i) / 12);
  }
  // o Bruno pode ter andado na órbita: mira onde ele está agora
  const nowAt = await a.page.evaluate((id) => window.__orbitaScene.screenPosition(id), dragId);
  await a.page.mouse.move(orbitBox.x + nowAt.x, orbitBox.y + nowAt.y);
  await a.page.mouse.up();
  await waitFor(c.page, () => [...document.querySelectorAll('.fling--big')].some((el) => el.textContent === '😂'), null, 10_000);
  await a.page.mouse.click(5, 5);
  log('  reações ok: estourou em volta de quem mandou e voou até o planeta do Bruno');

  // câmera: centralizar e desligar/ligar o 3D (imagem parada)
  await a.page.getByRole('button', { name: 'Centralizar a câmera' }).first().click();
  // modos: 2D (órbita plana), anéis (host no meio) e de volta ao 3D; as reações funcionam em todos
  await a.page.getByRole('radio', { name: /2D/ }).first().click();
  await waitFor(a.page, () => !!document.querySelector('.call .orbit') && !document.querySelector('.orbit3d__canvas'), null, 10_000);
  await a.page.getByRole('radio', { name: /Anéis/ }).first().click();
  await waitFor(a.page, () => {
    const box = document.querySelector('.call .orbit-rings')?.getBoundingClientRect();
    const items = [...document.querySelectorAll('.orbit-rings__item')];
    const host = items.find((el) => el.classList.contains('is-host'));
    if (!box || items.length !== 3 || !host) return false;
    // tudo dentro da área (sem barra de rolagem) e o host no meio
    const inside = items.every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
    });
    const h = host.querySelector('.planet').getBoundingClientRect();
    return inside && Math.abs(h.left + h.width / 2 - (box.left + box.width / 2)) < 4;
  }, null, 10_000);
  await a.page.waitForTimeout(1_100);
  await a.page.getByRole('button', { name: 'Reações' }).click();
  await a.page.getByRole('button', { name: 'Reagir com 🎉' }).click();
  await waitFor(a.page, () => [...document.querySelectorAll('.orbit-rings .fling')].some((el) => el.textContent === '🎉'), null, 5_000);
  await a.page.mouse.click(5, 5);
  await a.page.getByRole('radio', { name: /3D/ }).first().click();
  await waitFor(a.page, () => !!document.querySelector('.orbit3d__canvas'), null, 20_000);
  log('  modos ok: 2D, anéis com o host no meio (com reação) e de volta ao 3D');

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
  await waitFor(b.page, () => {
    const s = window.__orbita.getApp();
    const ana = s.room.members.find((m) => m.name === 'Ana');
    const v3d = window.__orbitaScene?.entries?.get(ana.id)?.videoEl;
    return (v3d && v3d.videoWidth > 0) || [...document.querySelectorAll('.orbit .planet.has-video video')].some((v) => v.videoWidth > 0);
  });
  // clicar no planeta com câmera abre grande no centro; fechar volta para a órbita
  await b.page.getByRole('button', { name: 'Ana: ver câmera' }).click();
  await waitFor(b.page, () => [...document.querySelectorAll('.stage-featured .tile video')].some((v) => v.videoWidth > 0), null, 10_000);
  await b.page.locator('.stage-featured .tile').hover();
  await b.page.getByRole('button', { name: /Fechar a câmera/ }).click();
  await waitFor(b.page, () => !document.querySelector('.stage-featured') && !!document.querySelector('.orbit, .orbit3d'), null, 10_000);
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
  if (!(await a.page.evaluate(() => !!document.querySelector('.stage-featured .tile--live') && !!document.querySelector('.orbit-strip .orbit, .orbit-strip .orbit3d')))) {
    throw new Error('a live não ficou em destaque com a faixa de órbita embaixo');
  }
  await a.page.getByRole('button', { name: 'Esconder os planetas' }).click();
  await waitFor(a.page, () => !document.querySelector('.orbit-strip') && !!document.querySelector('.orbit-strip__show'));
  await a.page.locator('.orbit-strip__show').click();
  await waitFor(a.page, () => !!document.querySelector('.orbit-strip .orbit, .orbit-strip .orbit3d'));
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

  // zoom na live (só para quem deu zoom); com o lápis, o traço cai embaixo do cursor mesmo com zoom
  const liveTile = a.page.locator('.stage-featured .tile--live');
  const tb = await liveTile.boundingBox();
  await a.page.mouse.move(tb.x + tb.width * 0.3, tb.y + tb.height * 0.35);
  for (let i = 0; i < 6; i++) await a.page.mouse.wheel(0, -240);
  await waitFor(a.page, () => !!document.querySelector('.zoom-box.is-zoomed') && !!document.querySelector('.zoom-pill'));
  if (await b.page.evaluate(() => !!document.querySelector('.zoom-box.is-zoomed'))) throw new Error('o zoom da Ana apareceu para o Bruno');
  await liveTile.hover();
  await a.page.getByRole('button', { name: /Lápis/ }).click();
  const q = { x: tb.x + tb.width * 0.55, y: tb.y + tb.height * 0.5 };
  await a.page.mouse.move(q.x, q.y);
  await a.page.mouse.down();
  await a.page.mouse.move(q.x + 30, q.y + 10, { steps: 6 });
  await a.page.mouse.up();
  const under = await a.page.evaluate(([x, y]) => {
    const paths = [...document.querySelectorAll('.stage-featured .fx-strokes path')];
    const r = paths[paths.length - 1]?.getBoundingClientRect();
    return r ? x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12 : false;
  }, [q.x, q.y]);
  if (!under) throw new Error('com zoom, o traço não ficou embaixo do cursor');
  await a.page.getByRole('button', { name: /Lápis/ }).click();
  await a.page.locator('.zoom-pill').click();
  await waitFor(a.page, () => !document.querySelector('.zoom-box.is-zoomed'));
  await a.page.getByRole('button', { name: /Apagar tudo/ }).click().catch(() => {});
  log('  zoom na live ok: só para quem deu zoom, o lápis desenha no lugar certo e o botão volta ao normal');

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
  await context.addInitScript(
    ([lobby, network]) => {
      localStorage.setItem('orbita.lobbyId', lobby);
      if (!localStorage.getItem('orbita.settings.v1')) localStorage.setItem('orbita.settings.v1', JSON.stringify({ network }));
    },
    [LOBBY, NETWORK],
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (err) => console.log('        [extensão ERRO]', err.message));
  await page.goto(BASE);
  await waitFor(page, () => !!window.__orbita?.getApp().extension, null, 15_000);
  log('  a página reconheceu a extensão (versão', await page.evaluate(() => window.__orbita.getApp().extension), ')');
  await page.getByRole('button', { name: /Criar e virar host/ }).click();
  await waitFor(page, () => window.__orbita.getApp().inCall, null, 30_000);
  await closeInvite(page);
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

/** Órbita fixa: o mesmo link sempre; quem já entrou reabre com o histórico; a coroa volta para quem criou. */
async function orbitaFixa(opened) {
  const a = await newUser('Ana', '#8b5cf6', opened);
  const b = await newUser('Bruno', '#22d3ee', opened);
  await a.page.goto(BASE);
  await a.page.getByLabel('Nome da sala').fill('Fixa da Ana');
  await a.page.locator('.check-row input').check();
  await a.page.getByRole('button', { name: /Criar e virar host/ }).click();
  await waitFor(a.page, () => window.__orbita?.getApp().phase === 'room');
  await closeInvite(a.page);
  const code = await a.page.evaluate(() => window.__orbita.getApp().code);
  if (!(await a.page.evaluate(() => window.__orbita.getApp().room.fixed))) throw new Error('a sala não ficou fixa');
  await joinRoom(b, code);
  await a.page.locator('.composer textarea').fill('mensagem que tem que voltar');
  await a.page.keyboard.press('Enter');
  const msg = a.page.locator('.msg', { hasText: 'mensagem que tem que voltar' }).first();
  await msg.waitFor();
  await msg.hover();
  await msg.getByRole('button', { name: 'Fixar' }).click();
  await waitFor(b.page, () => !!document.querySelector('.pinned-bar'));
  log('  órbita fixa criada:', code);

  // os dois saem: a sala fica vazia, mas cada um guardou a cópia
  await b.page.evaluate(() => window.__orbita.session().leave());
  await waitFor(b.page, () => window.__orbita.getApp().phase === 'landing', null, 15_000);
  await a.page.evaluate(() => window.__orbita.session().endForAll());
  await waitFor(a.page, () => window.__orbita.getApp().phase === 'landing', null, 15_000);
  await waitFor(b.page, (c) => window.__orbita.getApp().fixedRooms.some((r) => r.code === c), code);
  await b.page.locator('.fixed-rooms .lobby-room', { hasText: 'Fixa da Ana' }).waitFor();
  await a.page.waitForTimeout(2_500);
  log('  sala vazia; a cópia ficou guardada com quem já tinha entrado');

  // o Bruno (que só tinha entrado) reabre: volta com o histórico e a mensagem fixada
  await b.page.locator('.fixed-rooms .lobby-room', { hasText: 'Fixa da Ana' }).getByRole('button', { name: /Abrir/ }).click();
  await waitFor(b.page, (c) => window.__orbita.getApp().phase === 'room' && window.__orbita.getApp().code === c && window.__orbita.getApp().isHost, code, 40_000);
  await waitFor(b.page, () => document.querySelector('.pinned-bar')?.textContent?.includes('mensagem que tem que voltar'), null, 10_000);
  log('  Bruno reabriu a órbita pelo mesmo código, com o histórico e a fixada');

  // a Ana (quem criou) chega pelo mesmo link: a coroa volta para ela
  await joinRoom(a, code);
  await waitFor(a.page, () => window.__orbita.getApp().isHost === true, null, 40_000);
  await waitFor(b.page, () => window.__orbita.getApp().net === 'connected' && !window.__orbita.getApp().isHost, null, 40_000);
  log('  a criadora chegou e recebeu a coroa de volta; Bruno continuou na sala');
}

// ───────────────────────── execução ─────────────────────────

let failed = false;
for (const [name, scenario] of [
  ['chamada completa + queda do host', chamadaCompleta],
  ['passar a coroa + celular', passarCoroa],
  ['lista de órbitas (saguão)', saguao],
  ['órbita fixa', orbitaFixa],
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
signaling.close?.();
log(failed ? 'algum cenário falhou' : 'todos os cenários passaram');
process.exit(failed ? 1 : 0);
