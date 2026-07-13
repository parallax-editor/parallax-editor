/**
 * Visual inspection — toma pantallazos de cada surface UI nuevo del PR
 * "workspace presets + S3/Git creds via Keychain" para revisión humana.
 *
 * No es una suite de tests con asserts visuales — es solo el "recorrido" que un
 * humano haría: abrir cada modal/sección y dejar un PNG, para validar padding,
 * legibilidad, alineación, copy, etc. Output: /tmp/parallax-editor-shots/
 *
 * Reusa el patrón sandbox del harness e2e (mkdtemp + localStorage seed +
 * activate host) para que ningún proyecto real se vea afectado.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean)
function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && fs.existsSync(c)) return c
  return null
}
const CHROME = findChrome()
if (!CHROME) { console.error('No Chrome encontrado'); process.exit(2) }

const BASE = process.env.BASE_EDITOR || 'http://localhost:3000'
const OUT = process.env.OUT_DIR || '/tmp/parallax-editor-shots'
fs.mkdirSync(OUT, { recursive: true })
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-vi-'))
fs.cpSync(path.join(__dirname, 'fixtures', 'content'), path.join(SANDBOX, 'content'), { recursive: true })
// Inicializa el sandbox como repo git real para que el workspace con
// useGit:true pueda activarse en el host y mostremos la sección Git auth.
require('child_process').execSync('git init -q && git config user.email "t@t.t" && git config user.name "t" && git add -A && git commit --no-verify -q -m init', { cwd: SANDBOX, stdio: 'pipe' })

const wsLinked = {
  id: 'sandbox-linked',
  name: 'Portafolio (linked-home)',
  repoPath: SANDBOX,
  contentRoot: 'content',
  useGit: false,
  preset: 'linked-home',
  s3: { enabled: true, bucket: 'mi-bucket', prefix: '', region: 'us-east-1', publishManifest: true, publishManifestUserSet: false, credentialsMode: 'system' },
  git: { authMode: 'system', provider: 'github' },
}
const wsMulti = {
  id: 'sandbox-multi',
  name: 'Eventos (multi-tenant)',
  repoPath: SANDBOX,
  contentRoot: 'content',
  useGit: true,
  preset: 'multi-tenant',
  gitRemote: 'https://github.com/usuario/eventos.git',
  s3: { enabled: true, bucket: 'mi-bucket', prefix: '', region: 'us-east-1', publishManifest: false, publishManifestUserSet: false, credentialsMode: 'system' },
  git: { authMode: 'system', provider: 'github' },
}

async function shot(page, name) {
  const file = path.join(OUT, name + '.png')
  await page.screenshot({ path: file, fullPage: false })
  console.log('  📸 ' + name)
  return file
}

;(async () => {
  console.log('Chrome:', CHROME)
  console.log('Output:', OUT)
  console.log('Sandbox:', SANDBOX)

  const b = await chromium.launch({ executablePath: CHROME, headless: true })
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('[pageerror]', e.message))

  // Seed: dos workspaces, el linked-home activo primero.
  await page.addInitScript(({ wsL, wsM }) => {
    localStorage.setItem('parallax-editor:workspaces', JSON.stringify([wsL, wsM]))
    localStorage.setItem('parallax-editor:active-workspace', wsL.id)
    localStorage.setItem('parallax-editor:seed-version', '3')
    localStorage.setItem('parallax-editor:onboarded', '1')
    localStorage.setItem('parallax-editor:locale', 'es')
  }, { wsL: wsLinked, wsM: wsMulti })

  // Activamos AMBOS en el host para que el switch funcione.
  for (const ws of [wsLinked, wsMulti]) {
    const r = await page.request.post(BASE + '/api/workspace/activate', { data: ws })
    console.log('activate', ws.id, '→', r.status())
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  // ─── 1) Selector con linked-home: home pineado arriba ────────────────────
  await shot(page, '01-selector-linked-home-pin')

  // ─── 2) Modal "Nuevo proyecto" en linked-home → copy + placeholder ──────
  await page.click('[data-test=btn-new-project]')
  await page.waitForSelector('[data-test=create-dialog]')
  await page.waitForTimeout(200)
  await shot(page, '02-create-dialog-linked-home')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // ─── 3) Switch a multi-tenant ───────────────────────────────────────────
  await page.click(`[data-test=workspace-chip-${wsMulti.id}] .ws-chip-name`)
  await page.waitForTimeout(800)
  await shot(page, '03-selector-multi-tenant-flat')

  // ─── 4) Modal "Nuevo evento" en multi-tenant ───────────────────────────
  await page.click('[data-test=btn-new-project]')
  await page.waitForSelector('[data-test=create-dialog]')
  await page.waitForTimeout(200)
  await shot(page, '04-create-dialog-multi-tenant')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // ─── 5) Config modal del workspace multi-tenant — sección preset arriba ─
  await page.click(`[data-test=workspace-gear-${wsMulti.id}]`)
  await page.waitForSelector('[data-test=workspace-config]')
  await page.waitForTimeout(300)
  await shot(page, '05-config-modal-top-preset-multi')

  // ─── 6) Scroll al bloque S3 credentials (modo system) ───────────────────
  await page.evaluate(() => {
    const sec = document.querySelector('[data-test=ws-cfg-s3-creds-section]')
    if (sec) sec.scrollIntoView({ block: 'center' })
  })
  await page.waitForTimeout(200)
  await shot(page, '06-config-s3-creds-system')

  // ─── 7) Cambia a S3 explicit → aparecen los campos ─────────────────────
  await page.click('[data-test=ws-cfg-s3-creds-explicit]')
  await page.waitForTimeout(200)
  await page.fill('[data-test=ws-cfg-s3-accesskeyid]', 'AKIAEXAMPLEKEYID00')
  await page.fill('[data-test=ws-cfg-s3-secretkey]', 'wJalrXUtnFEMIK7MDENGEXAMPLESECRET')
  await page.waitForTimeout(200)
  await shot(page, '07-config-s3-creds-explicit-fields')

  // ─── 8) Modal de ayuda IAM policy ──────────────────────────────────────
  await page.click('[data-test=ws-cfg-s3-policy-help]')
  await page.waitForSelector('[data-test=s3-policy-help]')
  await page.waitForTimeout(300)
  await shot(page, '08-modal-s3-policy-help')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // ─── 9) Sección Git auth (workspace usa git en multi-tenant) ───────────
  await page.evaluate(() => {
    const sec = document.querySelector('[data-test=ws-cfg-git-auth-section]')
    if (sec) sec.scrollIntoView({ block: 'center' })
  })
  await page.waitForTimeout(200)
  await shot(page, '09-config-git-auth-system')

  // ─── 10) Git → modo PAT → aparecen los campos ──────────────────────────
  await page.click('[data-test=ws-cfg-git-mode-pat]')
  await page.waitForTimeout(200)
  await page.fill('[data-test=ws-cfg-git-pat-username]', 'mi-usuario-github')
  await page.fill('[data-test=ws-cfg-git-pat-token]', 'ghp_ExampleTokenValue1234567890abcd')
  await page.waitForTimeout(200)
  await shot(page, '10-config-git-pat-fields')

  // ─── 11) Modal de ayuda PAT (GitHub) ───────────────────────────────────
  await page.click('[data-test=ws-cfg-git-pat-help]')
  await page.waitForSelector('[data-test=git-pat-help]')
  await page.waitForTimeout(300)
  await shot(page, '11-modal-git-pat-help-github')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // ─── 12) Cambia provider a GitLab → re-abre help para ver el contenido ──
  await page.selectOption('[data-test=ws-cfg-git-provider]', 'gitlab')
  await page.click('[data-test=ws-cfg-git-pat-help]')
  await page.waitForSelector('[data-test=git-pat-help]')
  await page.waitForTimeout(300)
  await shot(page, '12-modal-git-pat-help-gitlab')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // ─── 13) Modal preset explain ──────────────────────────────────────────
  // Cierra el config, vuelve al config para activar el header con el botón "?"
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(200)
  // El modal de config sigue abierto → solo scroll up.
  await page.evaluate(() => {
    const body = document.querySelector('[data-test=workspace-config] .cd-body')
    if (body) body.scrollTop = 0
  })
  await page.waitForTimeout(200)
  await page.click('[data-test=ws-cfg-preset-help]')
  await page.waitForSelector('[data-test=preset-explain]')
  await page.waitForTimeout(300)
  await shot(page, '13-modal-preset-explain')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // Cierra el config
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // ─── 14) Selector linked-home — pin del home destacado ─────────────────
  await page.click(`[data-test=workspace-chip-${wsLinked.id}] .ws-chip-name`)
  await page.waitForTimeout(800)
  // Scroll arriba para ver el pin
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(200)
  await shot(page, '14-home-pin-empty-state')

  await b.close()
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch {}

  console.log('\n✓ pantallazos en ' + OUT)
  console.log('  archivos:', fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length)
})().catch((e) => {
  console.error('FAIL:', e.stack)
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
