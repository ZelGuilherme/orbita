// Órbita — atalhos. Fica dormindo até um atalho ser apertado (service worker por evento).
const APP_URL = 'https://zelguilherme.github.io/orbita/';
const MATCH = chrome.runtime.getManifest().content_scripts[0].matches;

async function orbitaTabs() {
  const tabs = await chrome.tabs.query({ url: MATCH });
  // a aba tocando som (na chamada) primeiro, depois a mais recente
  return tabs.sort((a, b) => Number(!!b.audible) - Number(!!a.audible) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
}

async function focus(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

chrome.commands.onCommand.addListener(async (command) => {
  const tabs = await orbitaTabs();
  if (command === 'abrir') {
    if (tabs[0]) await focus(tabs[0]);
    else await chrome.tabs.create({ url: APP_URL });
    return;
  }
  // a primeira aba que estiver numa chamada cuida do atalho
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { orbita: command });
      if (reply && reply.handled) return;
    } catch {
      // aba sem o script (aberta antes de instalar a extensão): recarregar resolve
    }
  }
});
