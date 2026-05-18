import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
// Engine stylesheet: split-text reveal, FormBlock layout, error overlay,
// gyro prompt, world transitions. Without this the canvas preview does NOT
// match the deployed sites. Use the package `exports` subpath (no /dist/).
import 'parallax-engine/style.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/ProjectSelector.vue') },
    { path: '/edit/:type/:slug', component: () => import('./views/EditorView.vue'), props: true },
  ],
})

createApp(App).use(router).mount('#app')
