import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { zipExtension } from './scripts/zip-extension.mjs';

/** Identificador desta versão: o app compara com o version.json publicado para saber se saiu outra. */
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function versionFile(): Plugin {
  return {
    name: 'orbita-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
    },
  };
}

/** A extensão de atalhos, empacotada para o botão "Baixar a extensão" (no build e no servidor de dev). */
const EXTENSION_ZIP = 'orbita-atalhos.zip';
function extensionZip(): Plugin {
  const make = () => zipExtension();
  return {
    name: 'orbita-extension-zip',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: EXTENSION_ZIP, source: make() });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!(req as { url?: string }).url?.endsWith(`/${EXTENSION_ZIP}`)) return next();
        res.setHeader('Content-Type', 'application/zip');
        res.end(make());
      });
    },
  };
}

/**
 * Política de segurança (CSP) na própria página: o GitHub Pages não deixa mandar cabeçalhos.
 * Mesmo que algum texto de outra pessoa escape para o HTML, o navegador não roda script que
 * não seja do próprio Órbita.
 *  - script: só os arquivos do site (+ WebAssembly do filtro de ruído);
 *  - conexões: o site, servidores de sinalização (o padrão do PeerJS ou o que a pessoa
 *    configurar) e localhost (servidor de sinalização local / testes);
 *  - workers: do site e blob: (o relógio da gravação);
 *  - estilos inline: a janela flutuante copia as folhas de estilo para dentro dela.
 * No servidor de desenvolvimento, o Vite precisa de script inline e do WebSocket do HMR.
 */
function contentSecurityPolicy(): Plugin {
  let dev = false;
  return {
    name: 'orbita-csp',
    configResolved(config) {
      dev = config.command === 'serve';
    },
    transformIndexHtml() {
      const policy = [
        "default-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-inline'" : ''}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "connect-src 'self' data: blob: https: wss: ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
        "manifest-src 'self'",
        "object-src 'none'",
        "frame-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
      ].join('; ');
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }];
    },
  };
}

// base relativa: o mesmo build funciona no GitHub Pages (/orbita/) ou em qualquer pasta
export default defineConfig({
  base: './',
  plugins: [react(), versionFile(), extensionZip(), contentSecurityPolicy()],
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
