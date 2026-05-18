import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/ProjectSelector.vue') },
    { path: '/edit/:type/:slug', component: () => import('./views/EditorView.vue'), props: true },
  ],
})

createApp(App).use(router).mount('#app')
