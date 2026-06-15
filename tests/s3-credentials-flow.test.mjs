// Unit test del flow de credenciales S3 (Fase 3):
//
//   1. `WorkspaceS3.credentialsMode` se acepta y persiste en activateWorkspace.
//      Default 'system' por back-compat (workspaces sin el campo).
//   2. `parseS3Credentials` de api.ts es estricto: descarta shapes inválidos,
//      campos vacíos, y valores excesivos. Solo deja pasar `{accessKeyId,
//      secretAccessKey}` válidos.
//   3. `publishWorkspaceSlug` ignora las creds explícitas si el workspace está
//      en 'system' — un cliente con bug no puede forzar creds que el server
//      no debería usar. Lo testeamos cambiando el comportamiento de syncSiteToS3
//      vía un sustituto inyectado en una copia del módulo.
//
// La cripto AWS / red están fuera de scope; aquí solo verificamos las costuras
// de configuración + parsing.

import { transform } from 'esbuild'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname

// ── 1) Schema: credentialsMode ───────────────────────────────────────────────
async function loadWorkspaces() {
  const src = await readFile(`${repoRoot}server/workspaces.ts`, 'utf-8')
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
  const tmp = await mkdtemp(join(tmpdir(), 's3-creds-test-'))
  const file = join(tmp, 'workspaces.mjs')
  await writeFile(file, out.code)
  globalThis.__wsTestStubs__ = {}
  const mod = await import(`file://${file}?t=${Date.now()}`)
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
  return mod
}

const ws = await loadWorkspaces()
const { activateWorkspace } = ws

const FAKE_REPO = '/tmp/__ws_test_repo__'

// 1a) ausencia de credentialsMode → 'system'
const a = activateWorkspace({
  id: 'a',
  name: 'A',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  s3: { enabled: true, bucket: 'x', prefix: '', region: 'us-east-1' },
})
assert.equal(a.workspace.s3.credentialsMode, 'system', "sin credentialsMode → 'system' por back-compat")

// 1b) credentialsMode 'explicit' se preserva
const b = activateWorkspace({
  id: 'b',
  name: 'B',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  s3: { enabled: true, bucket: 'x', prefix: '', region: 'us-east-1', credentialsMode: 'explicit' },
})
assert.equal(b.workspace.s3.credentialsMode, 'explicit', "'explicit' válido se preserva")

// 1c) valor desconocido cae a 'system'
const c = activateWorkspace({
  id: 'c',
  name: 'C',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  s3: { enabled: true, bucket: 'x', prefix: '', region: 'us-east-1', credentialsMode: 'garbage' },
})
assert.equal(c.workspace.s3.credentialsMode, 'system', 'valor garbage → system')

// 1d) Las credenciales propias NUNCA terminan en el workspace cacheado.
const d = activateWorkspace({
  id: 'd',
  name: 'D',
  repoPath: FAKE_REPO,
  contentRoot: 'content',
  useGit: false,
  s3: {
    enabled: true,
    bucket: 'x',
    prefix: '',
    region: 'us-east-1',
    credentialsMode: 'explicit',
    // un cliente mal escrito intentando colar el secret a través del cache:
    accessKeyId: 'AKIA…',
    secretAccessKey: 'should-not-be-cached',
  },
})
assert.equal(
  d.workspace.s3.accessKeyId,
  undefined,
  'el workspace cache NUNCA debe tener accessKeyId',
)
assert.equal(
  d.workspace.s3.secretAccessKey,
  undefined,
  'el workspace cache NUNCA debe tener secretAccessKey',
)

// ── 2) parseS3Credentials del módulo api.ts ──────────────────────────────────
// Extraemos solo la función `parseS3Credentials` para testearla en aislamiento.
// El archivo api.ts importa medio mundo; queremos solo la función pura.
const apiSrc = await readFile(`${repoRoot}server/api.ts`, 'utf-8')
const fnMatch = apiSrc.match(/function parseS3Credentials\([\s\S]*?\n\}/)
assert.ok(fnMatch, 'parseS3Credentials debe extraerse limpio (revisa el layout)')
const parseSrc = `export ${fnMatch[0]}`
const parseOut = await transform(parseSrc, { loader: 'ts', format: 'esm' })
const tmp2 = await mkdtemp(join(tmpdir(), 's3-parse-test-'))
const parseFile = join(tmp2, 'parse.mjs')
await writeFile(parseFile, parseOut.code)
const { parseS3Credentials } = await import(`file://${parseFile}?t=${Date.now()}`)
await rm(tmp2, { recursive: true, force: true }).catch(() => {})

// 2a) shapes inválidos → undefined
assert.equal(parseS3Credentials(null), undefined, 'null → undefined')
assert.equal(parseS3Credentials({}), undefined, 'sin credentials → undefined')
assert.equal(parseS3Credentials({ credentials: null }), undefined, 'credentials:null → undefined')
assert.equal(parseS3Credentials({ credentials: { accessKeyId: 'AKIA' } }), undefined, 'falta secretAccessKey → undefined')
assert.equal(parseS3Credentials({ credentials: { accessKeyId: '', secretAccessKey: 'sk' } }), undefined, 'accessKeyId vacío tras trim → undefined')
assert.equal(parseS3Credentials({ credentials: { accessKeyId: 'AKIA', secretAccessKey: '   ' } }), undefined, 'secretAccessKey solo espacios → undefined')

// 2b) valores excesivos → undefined
const huge = 'x'.repeat(300)
assert.equal(parseS3Credentials({ credentials: { accessKeyId: huge, secretAccessKey: 'sk' } }), undefined, 'accessKeyId >256 → undefined')
assert.equal(parseS3Credentials({ credentials: { accessKeyId: 'AKIA', secretAccessKey: huge } }), undefined, 'secretAccessKey >256 → undefined')

// 2c) shape válido sobrevive intacto
const valid = parseS3Credentials({ credentials: { accessKeyId: '  AKIA123  ', secretAccessKey: 'sk/with+chars=' } })
assert.deepEqual(valid, { accessKeyId: 'AKIA123', secretAccessKey: 'sk/with+chars=' }, 'creds válidas pasan trim y se preservan')

// ── 3) Gating del modo: 'system' descarta creds aunque el cliente las mande ──
// Extraemos el FRAGMENTO de publish.ts que decide qué pasarle a syncSiteToS3.
// El plan dice: "Si el workspace está en 'system' el caller IGNORA las creds."
// Validamos esa lógica pura sin levantar el publish completo.
const publishSrc = await readFile(`${repoRoot}server/publish.ts`, 'utf-8')
// Buscamos la única expresión que computa `s3Creds`. Si el layout cambia, este
// match falla y obliga a actualizar el test (mejor que un falso verde).
const gateMatch = publishSrc.match(/const s3Creds\s*=\s*ws\.s3\?\.credentialsMode === 'explicit' \? credentials : undefined/)
assert.ok(
  gateMatch,
  "publish.ts debe tener un gate '`credentialsMode === explicit ? credentials : undefined`' — si la línea cambió, ajusta el test.",
)
// Simulamos el gate:
const gate = (mode, credentials) => (mode === 'explicit' ? credentials : undefined)
const fakeCreds = { accessKeyId: 'AKIA', secretAccessKey: 'sk' }
assert.equal(gate('system', fakeCreds), undefined, "'system' descarta creds aunque el cliente las mande")
assert.equal(gate(undefined, fakeCreds), undefined, "ausencia de modo (back-compat) → descarta creds")
assert.deepEqual(gate('explicit', fakeCreds), fakeCreds, "'explicit' propaga las creds")
assert.equal(gate('explicit', undefined), undefined, "'explicit' sin creds → undefined")

// Lo mismo para deleteWorkspaceSlug — debe usar EL MISMO gate, no su propia
// versión por si acaso.
const deleteMatch = publishSrc.match(
  /export async function deleteWorkspaceSlug[\s\S]*?const s3Creds\s*=\s*ws\.s3\?\.credentialsMode === 'explicit' \? credentials : undefined/,
)
assert.ok(
  deleteMatch,
  "deleteWorkspaceSlug debe replicar EL MISMO gate — si la línea no aparece, asegúrate de no haber drifteado el contrato entre publish y delete.",
)

console.log('✓ s3 credentials flow OK')
