/**
 * #8 — Guardar en el editor → persiste y se refleja (AUTOCONTENIDO).
 *
 * Sin depender del contenido externo del usuario ni de un sitio consumidor vivo: monta
 * las fixtures del editor en un workspace "sandbox" efímero (mkdtemp, useGit:false),
 * edita el contenido de un texto vía el editor, Guarda, y verifica:
 *   - que el cambio quedó en DISCO (el site.json del sandbox), JSON válido, y
 *   - que se REFLEJA en el preview real del engine dentro del propio editor.
 * Al terminar borra el temporal. El repo del editor NO se toca.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EDITOR = process.env.BASE_EDITOR || 'http://localhost:3000';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'content');
const WS = 'sandbox';
const SLUG = 'demo-mundo';
const TARGET_ID = 'demo-titulo';
const SENTINEL = 'E2E-SAVE-' + Date.now();

let SANDBOX_DIR = null;
let fails = 0;
const check = (l, ok, d = '') => { if (!ok) fails++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ' — ' + d : ''}`); };
const cleanup = () => { if (SANDBOX_DIR) { try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch {} } };

(async () => {
  SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-e2e-save-'));
  fs.cpSync(FIXTURES, path.join(SANDBOX_DIR, 'content'), { recursive: true });
  const SITE_JSON = path.join(SANDBOX_DIR, 'content', SLUG, 'site.json');
  const sandboxWs = { id: WS, name: 'Sandbox E2E', repoPath: SANDBOX_DIR, contentRoot: 'content', useGit: false };

  const b = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADLESS !== '0' });
  const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.addInitScript((ws) => {
    try {
      localStorage.setItem('parallax-editor:workspaces', JSON.stringify([ws]));
      localStorage.setItem('parallax-editor:active-workspace', ws.id);
      localStorage.setItem('parallax-editor:seed-version', '3');
      localStorage.setItem('parallax-editor:onboarded', '1');
    } catch {}
  }, sandboxWs);

  try {
    await page.request.post(`${EDITOR}/api/workspace/activate`, { data: sandboxWs });
    console.log(`=== #8 Guardar → persiste + refleja (${WS}/${SLUG}) ===`);

    // Abrir el proyecto (card o fallback por URL).
    await page.goto(EDITOR + '/', { waitUntil: 'load', timeout: 25000 }); await page.waitForTimeout(2000);
    const card = page.locator(`[data-test="project-card-${WS}-${SLUG}"]`).first();
    if (await card.count().catch(() => 0)) { await card.click().catch(() => {}); await page.waitForTimeout(2800); }
    // Detect "we're in the editor" via the stable `.layers-panel`/`.properties-panel`
    // CSS classes instead of the localized panel titles ("CAPAS"/"PROPIEDADES"),
    // so the fallback URL nav doesn't fire spuriously under an `en` locale.
    if (!(await page.evaluate(() => !!document.querySelector('.layers-panel, .properties-panel')))) {
      await page.goto(`${EDITOR}/edit/${WS}/${SLUG}`, { waitUntil: 'load', timeout: 25000 }); await page.waitForTimeout(2800);
    }

    // Seleccionar el texto por el árbol de capas y editar su Contenido.
    await page.locator('.layers-panel').getByText(new RegExp(`^${TARGET_ID}$`)).first().click(); await page.waitForTimeout(700);
    const contenido = page.locator('.prop-field', { hasText: /Contenido/i }).locator('textarea, input').first();
    check('campo Contenido visible para el texto', await contenido.count() > 0);
    await contenido.fill(SENTINEL); await contenido.blur(); await page.waitForTimeout(400);

    // Guardar — selector by data-test attribute so the test survives i18n
    // (the button text is `t('toolbar.save')` and varies with the active
    // locale; the data-test attribute stays byte-identical regardless).
    const saveBtn = page.locator('[data-test="save"]').first();
    if (await saveBtn.count()) await saveBtn.click();
    else await page.keyboard.press('Meta+s');
    await page.waitForTimeout(2500);

    // Verificar en disco (site.json del sandbox)
    const onDisk = fs.readFileSync(SITE_JSON, 'utf8');
    check('#8 site.json en disco contiene el cambio guardado', onDisk.includes(SENTINEL));
    let validJson = false;
    try { JSON.parse(onDisk); validJson = true; } catch {}
    check('#8 site.json sigue siendo JSON válido', validJson);

    // Verificar reflejado en el preview real del engine (dentro del editor).
    // El engine puede partir el texto (splitMode chars) → comparamos sin espacios.
    const reflected = await page.evaluate(({ id, sentinel }) => {
      const e = document.querySelector(`[data-parallax-id="${id}"]`);
      if (!e) return false;
      const txt = (e.innerText || e.textContent || '').replace(/\s+/g, '');
      return txt.includes(sentinel.replace(/\s+/g, ''));
    }, { id: TARGET_ID, sentinel: SENTINEL });
    check('#8 el cambio se refleja en el preview del engine', reflected);
  } catch (e) {
    check('#8 flujo guardar→persiste→refleja', false, e.message);
  } finally {
    await b.close();
    cleanup();
  }
  console.log(`==== #8: ${fails === 0 ? 'PASS ✅' : fails + ' FAIL ❌'} ====`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { cleanup(); console.error('SAVE-REFLECT FAIL:', e.stack); process.exit(2); });
