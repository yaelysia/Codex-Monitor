import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // The probe's existing dev dependency is now also used by the packaged app.
    plugins: [externalizeDepsPlugin({ exclude: ['ws'] })],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/main.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/preload.ts') } } },
  },
  renderer: {
    base: './',
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: {
      index: resolve(__dirname, 'src/renderer/index.html'),
      floating: resolve(__dirname, 'src/renderer/floating.html'),
      diagnostics: resolve(__dirname, 'src/renderer/diagnostics.html'),
    } } },
  },
});
