<script setup lang="ts">
import DialogHost from './components/ui/DialogHost.vue'
import DoctorHost from './components/doctor/DoctorHost.vue'
</script>

<template>
  <router-view />
  <!-- Host global de diálogos (confirm/alert/prompt propios). Montado una vez. -->
  <DialogHost />
  <!-- Pantalla doctor (primer arranque / menú Ayuda). Montada una vez. -->
  <DoctorHost />
</template>
