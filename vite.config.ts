import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json';

// `npm run dev`   — dev-сервер с горячей перезагрузкой (подсказки из src/content/*.md
//                   подхватываются на лету).
// `npm run build` — один самодостаточный dist/index.html: воркер встроен inline,
//                   открывается двойным кликом без сервера.
export default defineConfig({
  base: './',
  // версия сборки в интерфейсе и отчётах: «v1.08.26» (package.json → releaseName)
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.releaseName}`) },
  plugins: [viteSingleFile()],
  // iife, а не es: module-воркер из blob не стартует на file:// (null origin) — проверено
  worker: { format: 'iife' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: {
    port: 5181,
    open: true,
  },
  test: {
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
  },
});
