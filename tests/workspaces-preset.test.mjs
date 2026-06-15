// Unit test del contrato preset en server/workspaces.ts:
//
//   • activateWorkspace acepta `preset` enum ('linked-home' | 'multi-tenant')
//     y cae a 'multi-tenant' cuando es undefined o desconocido (back-compat).
//   • presetPublishManifestDefault(linked-home) === true;
//     presetPublishManifestDefault(multi-tenant) === false.
//   • `publishManifestUserSet:true` respeta el valor que mande el cliente;
//     false/undefined aplica el default DERIVADO del preset.
//
// Por qué existe: este archivo cambia comportamiento del activate cuando llega
// un cliente nuevo (con preset) vs uno viejo (sin preset). Una regresión aquí
// rompe silenciosamente la migración back-compat. La prueba importa el TS real
// vía esbuild — no copia.

import { transform } from 'esbuild'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname

// Cargamos server/workspaces.ts transpilado. Lo aislamos para no arrastrar
// dependencias del resto del server. Quitamos los imports de fs/path para que
// el módulo sea importable como JS puro y stubbeamos lo que activateWorkspace
// necesita en runtime para los tests felices.
async function loadModule(stubs = {}) {
  const src = await readFile(`${repoRoot}server/workspaces.ts`, 'utf-8')
  // Reescribimos el `import { … } from 'fs'` y de 'path' por stubs que el test
  // controla, así no chocamos con el sistema de archivos real.
  const stubbed = src
    .replace(
      /import \{[^}]+\} from 'fs'/,
      `const __stubs = globalThis.__wsTestStubs__ || {};
const statSync = __stubs.statSync || (() => ({ isDirectory: () => true }));
const accessSync = __stubs.accessSync || (() => undefined);
const existsSync = __stubs.existsSync || (() => true);
const mkdirSync = __stubs.mkdirSync || (() => undefined);
const constants = { W_OK: 0 };`,
    )
    .replace(
      /import \{ resolve, isAbsolute \} from 'path'/,
      `const resolve = (...args) => args.filter(Boolean).join('/').replace(/\\/+/g, '/');
const isAbsolute = (p) => p.startsWith('/');`,
    )

  const out = await transform(stubbed, { loader: 'ts', format: 'esm' })
  const tmp = await mkdtemp(join(tmpdir(), 'ws-preset-test-'))
  const file = join(tmp, 'workspaces.mjs')
  await writeFile(file, out.code)
  globalThis.__wsTestStubs__ = stubs
  try {
    return await import(`file://${file}?t=${Date.now()}`)
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

const FAKE_REPO = '/tmp/__ws_test_repo__'
const stubs = {
  statSync: () => ({ isDirectory: () => true }),
  accessSync: () => undefined,
  existsSync: (p) => true, // hacemos pasar el chequeo de repo/.git
  mkdirSync: () => undefined,
}

const mod = await loadModule(stubs)
const { activateWorkspace, presetPublishManifestDefault } = mod

// ─── presetPublishManifestDefault: derivación pura ────────────────────────────
assert.equal(presetPublishManifestDefault('linked-home'), true, 'linked-home → manifest default true')
assert.equal(presetPublishManifestDefault('multi-tenant'), false, 'multi-tenant → manifest default false')
assert.equal(presetPublishManifestDefault(undefined), false, 'undefined → multi-tenant default → false')

// ─── activateWorkspace: enum válido se preserva ───────────────────────────────
const a = activateWorkspace({
  id: 'a',
  name: 'A',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'linked-home',
})
assert.equal(a.ok, true, 'linked-home válido debe activar')
assert.equal(a.workspace.preset, 'linked-home', 'preset se preserva tal cual')

// ─── activateWorkspace: enum desconocido cae a 'multi-tenant' ─────────────────
const b = activateWorkspace({
  id: 'b',
  name: 'B',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'garbage',
})
assert.equal(b.workspace.preset, 'multi-tenant', 'enum garbage → multi-tenant (back-compat)')

// ─── activateWorkspace: ausencia de preset → multi-tenant ─────────────────────
const c = activateWorkspace({
  id: 'c',
  name: 'C',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
})
assert.equal(c.workspace.preset, 'multi-tenant', 'sin preset → multi-tenant')

// ─── s3.publishManifest: default DERIVADO del preset cuando userSet=false ────
const d = activateWorkspace({
  id: 'd',
  name: 'D',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'linked-home',
  s3: { enabled: true, bucket: 'x', prefix: '', region: 'us-east-1' /* sin publishManifestUserSet */ },
})
assert.equal(d.workspace.s3.publishManifest, true, 'linked-home sin userSet → manifest=true (default)')

const e = activateWorkspace({
  id: 'e',
  name: 'E',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'multi-tenant',
  s3: { enabled: true, bucket: 'x', prefix: '', region: 'us-east-1' /* sin publishManifestUserSet */ },
})
assert.equal(e.workspace.s3.publishManifest, false, 'multi-tenant sin userSet → manifest=false (default)')

// ─── s3.publishManifest: userSet=true respeta el valor del cliente ───────────
const f = activateWorkspace({
  id: 'f',
  name: 'F',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'multi-tenant', // default sería false
  s3: {
    enabled: true,
    bucket: 'x',
    prefix: '',
    region: 'us-east-1',
    publishManifest: true,
    publishManifestUserSet: true, // el usuario quiere true aunque preset diga false
  },
})
assert.equal(f.workspace.s3.publishManifest, true, 'userSet=true → respeta valor del cliente aunque vaya contra el preset')
assert.equal(f.workspace.s3.publishManifestUserSet, true, 'userSet flag se preserva')

const g = activateWorkspace({
  id: 'g',
  name: 'G',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'linked-home',
  s3: {
    enabled: true,
    bucket: 'x',
    prefix: '',
    region: 'us-east-1',
    publishManifest: false,
    publishManifestUserSet: true, // usuario lo apagó explícitamente
  },
})
assert.equal(g.workspace.s3.publishManifest, false, 'userSet=true con false → respeta off aunque preset sea linked-home')

// ─── BACK-COMPAT: legacy localStorage con publishManifest:true sin flag ──────
// Un workspace creado antes de este feature tiene `s3.publishManifest:true`
// (lo activó manualmente) pero NO trae `publishManifestUserSet`. El default
// del preset es false → si no detectamos la intención, lo apagamos en silencio.
const legacyTrue = activateWorkspace({
  id: 'legacy-true',
  name: 'Legacy True',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  // sin preset → multi-tenant (default = false)
  s3: {
    enabled: true,
    bucket: 'x',
    prefix: '',
    region: 'us-east-1',
    publishManifest: true, // valor explícito del cliente legacy
    // sin publishManifestUserSet — el cliente legacy nunca supo del flag
  },
})
assert.equal(
  legacyTrue.workspace.s3.publishManifest,
  true,
  'BACK-COMPAT: publishManifest boolean explícito sin flag → respeta valor (no pisa)',
)
assert.equal(
  legacyTrue.workspace.s3.publishManifestUserSet,
  true,
  'BACK-COMPAT: el flag se promueve a true para que cambios de preset futuros respeten la elección',
)

// Mismo escenario con valor false:
const legacyFalse = activateWorkspace({
  id: 'legacy-false',
  name: 'Legacy False',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'linked-home', // default linked-home = true
  s3: {
    enabled: true,
    bucket: 'x',
    prefix: '',
    region: 'us-east-1',
    publishManifest: false, // lo apagó explícitamente
  },
})
assert.equal(
  legacyFalse.workspace.s3.publishManifest,
  false,
  'BACK-COMPAT: false explícito sin flag → respeta off aunque preset sea linked-home',
)

// ─── s3: undefined → no se materializa s3 en el workspace ────────────────────
const noS3 = activateWorkspace({
  id: 'no-s3',
  name: 'NoS3',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'multi-tenant',
})
assert.equal(noS3.ok, true, 'workspace sin s3 debe activar')
assert.equal(noS3.workspace.s3, undefined, 'sin s3 en input → s3 queda undefined (no se inventa)')

// ─── Round-trip por localStorage: JSON.parse(JSON.stringify(activated)) ─────
// El cliente persiste workspaces como JSON en localStorage. El round-trip debe
// preservar TODOS los campos relevantes para evitar drift entre reload y memoria.
const original = activateWorkspace({
  id: 'rt',
  name: 'RT',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  preset: 'linked-home',
  s3: {
    enabled: true,
    bucket: 'b',
    prefix: 'p',
    region: 'us-west-2',
    publishManifest: false,
    publishManifestUserSet: true,
  },
}).workspace

const restored = activateWorkspace(JSON.parse(JSON.stringify(original))).workspace
assert.equal(restored.preset, 'linked-home', 'round-trip preserva preset')
assert.equal(restored.s3.publishManifest, false, 'round-trip preserva publishManifest del usuario')
assert.equal(restored.s3.publishManifestUserSet, true, 'round-trip preserva userSet flag')
assert.equal(restored.s3.bucket, 'b', 'round-trip preserva bucket')
assert.equal(restored.s3.region, 'us-west-2', 'round-trip preserva region')

console.log('✓ workspaces preset contract OK')
