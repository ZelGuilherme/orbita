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

// base relativa: o mesmo build funciona no GitHub Pages (/orbita/) ou em qualquer pasta
export default defineConfig({
  base: './',
  plugins: [react(), versionFile(), extensionZip()],
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
