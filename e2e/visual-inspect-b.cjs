/**
 * Visual inspection Bloque B — settings screen dedicada.
 *
 * Recorre las 3 tabs (General / S3 / Git) del workspace linked-home y
 * multi-tenant + toma pantallazos del botón Publicar bloqueado en el editor.
 * Sin asserts — solo capturas para review humano.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const CHROME = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((c) => c && fs.existsSync(c))
if (!CHROME) { console.error('No Chrome'); process.exit(2) }

const BASE = 'http://localhost:3000'
const OUT = '/tmp/parallax-editor-shots-b'
fs.mkdirSync(OUT, { recursive: true })
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-vi-b-'))
fs.cpSync(path.join(__dirname, 'fixtures', 'content'), path.join(SANDBOX, 'content'), { recursive: true })
require('child_process').execSync('git init -q && git config user.email "t@t.t" && git config user.name "t" && git add -A && git commit --no-verify -q -m init', { cwd: SANDBOX, stdio: 'pipe' })

const wsLinked = {
  id: 'sandbox-linked',
  name: 'Portafolio',
  repoPath: SANDBOX,
  contentRoot: 'content',
  useGit: true,
  preset: 'linked-home',
  s3: { enabled: true, bucket: 'mi-bucket', prefix: '', region: 'us-east-1', publishManifest: true, publishManifestUserSet: false, credentialsMode: 'explicit' }, // marca explicit sin secreto guardado
  git: { authMode: 'pat', provider: 'github' }, // pat sin token guardado → bloqueo
}
const wsMulti = {
  id: 'sandbox-multi',
  name: 'Eventos',
  repoPath: SANDBOX,
  contentRoot: 'content',
  useGit: true,
  preset: 'multi-tenant',
  s3: { enabled: true, bucket: 'x', prefix: '', region: 'us-east-1', publishManifest: false, publishManifestUserSet: false, credentialsMode: 'system' },
  git: { authMode: 'system' },
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false })
  console.log('  📸 ' + name)
}

;(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true })
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('[pageerror]', e.message))

  await page.addInitScript(({ wsL, wsM }) => {
    localStorage.setItem('parallax-editor:workspaces', JSON.stringify([wsL, wsM]))
    localStorage.setItem('parallax-editor:active-workspace', wsL.id)
    localStorage.setItem('parallax-editor:seed-version', '3')
    localStorage.setItem('parallax-editor:onboarded', '1')
    localStorage.setItem('parallax-editor:locale', 'es')
  }, { wsL: wsLinked, wsM: wsMulti })

  for (const ws of [wsLinked, wsMulti]) {
    const r = await page.request.post(BASE + '/api/workspace/activate', { data: ws })
    console.log('activate', ws.id, '→', r.status())
  }

  // 1) Selector → gear del workspace linked (que apunta a settings)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await shot(page, '01-selector-gear-goes-to-settings')
  await page.click(`[data-test=workspace-gear-${wsLinked.id}]`)
  await page.waitForURL('**/workspace/**/settings', { timeout: 5000 })
  await page.waitForTimeout(600)

  // 2) Settings — tab General
  await shot(page, '02-settings-tab-general')

  // 3) Settings — tab S3
  await page.click('[data-test=wsSettings-tab-s3]')
  await page.waitForTimeout(400)
  await shot(page, '03-settings-tab-s3')

  // 4) Settings — tab Git
  await page.click('[data-test=wsSettings-tab-git]')
  await page.waitForTimeout(400)
  await shot(page, '04-settings-tab-git')

  // 5) Editor con el workspace linked (donde el botón Publicar debe estar bloqueado)
  const demo = SANDBOX + '/content'
  const slugs = fs.readdirSync(demo)
  const slug = slugs.find((s) => !s.startsWith('.'))
  if (slug) {
    await page.goto(`${BASE}/edit/${wsLinked.id}/${slug}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)
    await shot(page, '05-editor-publish-blocked')
    // 6) Hover para ver tooltip
    const btn = page.locator('[data-test=toggle-git]').first()
    await btn.hover()
    await page.waitForTimeout(600)
    await shot(page, '06-editor-publish-tooltip')
  }

  await b.close()
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
  console.log('\n✓ ' + OUT)
})().catch((e) => { console.error(e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch {}; process.exit(1) })
