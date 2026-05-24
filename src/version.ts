// Versión de la app, horneada por Vite (`define: __APP_VERSION__`) desde
// package.json. `yarn release` la bumpea (npm version) antes de empaquetar, así
// el editor SIEMPRE muestra la versión real del build/dmg. Fallback 'dev'.
declare const __APP_VERSION__: string
export const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
