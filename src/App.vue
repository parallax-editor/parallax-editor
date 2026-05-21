<script setup lang="ts">
import DialogHost from './components/ui/DialogHost.vue'
</script>

<template>
  <router-view />
  <!-- Host global de diálogos (confirm/alert/prompt propios). Montado una vez. -->
  <DialogHost />
</template>
