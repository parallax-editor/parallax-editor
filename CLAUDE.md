# parallax-editor

Editor local tipo Illustrator para crear y editar sitios parallax. Solo corre en la máquina de Daniela, nunca se expone a internet.

## Estado actual

**Fase 4 del plan — aún no implementado.** Tiene package.json mínimo, bootstrap.sh para setup de máquinas nuevas, y GUIA.md (esqueleto para Daniela).

## Lo que será (Fase 4)

- Servidor Node local + Vue 3 + Vite (no Nuxt)
- Canvas tipo Illustrator con preview real del engine
- Panel de capas (drag & drop, z-index)
- Panel de propiedades reactivo
- Switch mobile/desktop
- Manipulación visual: bounding box, handles resize/rotate, shift-proportion, snap-to-grid, smart guides
- Importador de PNGs + análisis con Claude (`claude -p`)
- Botón "Preguntarle a Claude" + file watcher
- Descubrimiento de componentes vía `parallax.config.ts`
- Auto-commit local + botón "Publicar" con confirmación
- Un archivo abierto a la vez (sin tabs)

## Relación con otros repos

- Lee/escribe archivos de `daniela-reyes-site/content/` y `daniela-reyes-eventos/content/`
- Consume parallax-engine para el preview real
- Ejecuta `git` y `claude -p` por shell

## Archivos clave

- `bootstrap.sh` — Setup de máquina nueva (clona repos, instala deps, configura links)
- `GUIA.md` — Guía en español para Daniela (esqueleto, se completa en Fase 4)

## Comandos actuales

```bash
yarn test         # Smoke test — verifica import del engine
./bootstrap.sh    # Setup completo (clona, instala, linkea)
./bootstrap.sh --check  # Solo verifica prerequisitos
```
