// Версия сборки («v1.08.26»): подставляет Vite из package.json → releaseName (vite.config.ts).
declare const __APP_VERSION__: string | undefined;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
