import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import { i18n } from './i18n'
// Engine stylesheet: split-text reveal, FormBlock layout, error overlay,
// gyro prompt, world transitions. Without this the canvas preview does NOT
// match the deployed sites. Use the package `exports` subpath (no /dist/).
import '@parallax-editor/parallax-engine/style.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/ProjectSelector.vue') },
    { path: '/edit/:type/:slug', component: () => import('./views/EditorView.vue'), props: true },
    // Full-viewport live demo of the CURRENT (possibly unsaved) doc, rendered
    // by the editor itself in a new SAME-ORIGIN tab. No editor chrome, no save,
    // zero dependency on the eventos/site dev servers. Doc handed over tab→tab
    // via localStorage snapshot + per-project BroadcastChannel (see the
    // toolbar's openLivePreview + views/LivePreview.vue).
    { path: '/live', component: () => import('./views/LivePreview.vue') },
  ],
})

import { state, getAtPath, hydratePrefs } from './stores/editor'

// Restore persisted UI prefs (Autosave, Grid, Vista completa) BEFORE the app
// mounts so the first render already reflects them. Overview is hydrated as a
// pending intent (prefsWantOverview) and applied by the canvas via the real
// enable/fit path once the project + canvas are measured.
hydratePrefs()

createApp(App).use(router).use(i18n).mount('#app')

// Read-only debug surface for the local editor (localhost-only, never deployed)
// and the E2E harness: lets a test assert the canonical written values
// (unit-preserved position/size), the live editor view state (overviewMode,
// canvasPan/zoom), and resolve a path without scraping the UI. Read-only by
// contract — the harness only inspects, it does not mutate through this.
;(window as any).__editor = {
  get state() {
    return state
  },
  getAtPath,
}
