import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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

// base relativa: o mesmo build funciona no GitHub Pages (/orbita/) ou em qualquer pasta
export default defineConfig({
  base: './',
  plugins: [react(), versionFile()],
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
