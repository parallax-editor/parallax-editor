#!/usr/bin/env node
// ─── Empaqueta el contrato de IA del engine dentro del editor ─────────────────
//
// El engine es la FUENTE DE VERDAD del contrato de autoría de site.json
// (`parallax-engine/ai/contract.md`). El editor lo inyecta en cada `claude -p`
// (server/claude.ts) para que los repos de contenido NO necesiten skill y para
// que TODO viaje dentro del .dmg empaquetado (la máquina del usuario no
// necesita tener el repo del engine).
//
// Este script lee ese contrato (vía el symlink `node_modules/parallax-engine`,
// o el repo vecino como fallback) y lo "hornea" en un módulo TS
// (`server/contract.generated.ts`) que esbuild/Vite bundlean como string. Así
// no hay archivo externo que buscar en runtime. Se ejecuta en los pre-hooks de
// build/dev (ver package.json) → siempre fresco desde el engine; el archivo
// generado se commitea para que un checkout limpio funcione sin build previo.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EDITOR_ROOT = resolve(__dirname, '..')

// Orden de búsqueda: el paquete instalado vía npm (scope @parallax-editor) y,
// como fallback de desarrollo, el repo del engine clonado al lado del editor.
const CANDIDATES = [
  resolve(EDITOR_ROOT, 'node_modules', '@parallax-editor', 'parallax-engine', 'ai', 'contract.md'),
  resolve(EDITOR_ROOT, '..', 'parallax-engine', 'ai', 'contract.md'),
]

const OUT = resolve(EDITOR_ROOT, 'server', 'contract.generated.ts')

function findContract() {
  for (const p of CANDIDATES) if (existsSync(p)) return p
  return null
}

const src = findContract()
let contract
if (src) {
  contract = readFileSync(src, 'utf-8').trim()
} else {
  // Sin el engine a mano: emitimos un stub mínimo y avisamos. El editor sigue
  // funcionando; Claude solo pierde el detalle fino del schema.
  console.warn(
    '[embed-contract] AVISO: no encontré parallax-engine/ai/contract.md. ' +
      'Genero un stub mínimo. Asegúrate de instalar/linkear el engine.',
  )
  contract =
    '# Contrato de site.json (stub)\n\n' +
    'Asistente de un sistema parallax. Solo edita `site.json` y assets dentro ' +
    'de `content/<slug>/`. Responde en el idioma del usuario. (Contrato completo ' +
    'no disponible: el engine no estaba presente al compilar el editor.)'
}

// Hornear como template literal crudo. Escapamos backtick y `${` para no romper
// el literal ni interpolar nada.
const escaped = contract.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

const banner =
  '// ARCHIVO GENERADO — NO EDITAR A MANO.\n' +
  '// Lo regenera scripts/embed-contract.mjs desde parallax-engine/ai/contract.md\n' +
  '// en los pre-hooks de build/dev. Edita el contrato en el ENGINE, no aquí.\n'

writeFileSync(
  OUT,
  `${banner}export const PARALLAX_CONTRACT = \`${escaped}\`\n`,
  'utf-8',
)

console.log(
  `[embed-contract] ${src ? 'OK' : 'STUB'} → server/contract.generated.ts (${contract.length} chars)`,
)
