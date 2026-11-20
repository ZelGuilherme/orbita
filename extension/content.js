// Ponte entre a extensão e a página do Órbita: repassa o atalho e devolve se a página cuidou dele.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg.orbita !== 'string') return false;
  const id = Math.random().toString(36).slice(2);
  const done = (handled) => {
    window.removeEventListener('message', onReply);
    clearTimeout(timer);
    reply({ handled });
  };
  const onReply = (e) => {
    if (e.source === window && e.data && e.data.source === 'orbita-app' && e.data.id === id) done(!!e.data.handled);
  };
  const timer = setTimeout(() => done(false), 1000);
  window.addEventListener('message', onReply);
  window.postMessage({ source: 'orbita-extension', id, action: msg.orbita }, location.origin);
  return true;
});

// avisa a página que a extensão está instalada (a tela de atalhos mostra isso)
window.postMessage({ source: 'orbita-extension', action: 'hello', version: chrome.runtime.getManifest().version }, location.origin);
window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.source === 'orbita-app' && e.data.action === 'ping') {
    window.postMessage({ source: 'orbita-extension', action: 'hello', version: chrome.runtime.getManifest().version }, location.origin);
  }
});
