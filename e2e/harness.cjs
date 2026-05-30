/**
 * E2E harness — editor parallax (AUTOCONTENIDO).
 *
 * Conduce un Chrome real (headless por defecto) contra el editor que el usuario
 * tiene corriendo en :3000 y lo maneja COMO LO HARÍA EL USUARIO, pero SIN depender
 * del contenido externo del usuario. Todo el contenido de prueba
 * vive en `e2e/fixtures/content/` y se monta en un workspace "sandbox" efímero:
 *   - al arrancar, se copian las fixtures a un directorio temporal (mkdtemp),
 *   - se inyecta ese workspace en el localStorage del editor (useGit:false → el
 *     editor escribe a disco pero NUNCA hace git commit), y se activa en el host,
 *   - al terminar, el temporal se borra. El repo del editor NO se toca jamás.
 *
 * El render del ENGINE (anclas, posiciones, animaciones, etc.) ya NO se prueba
 * aquí contra sitios vivos: lo cubre la matriz OFFLINE y autocontenida
 * `yarn test:e2e:matrix` (e2e/suites/engine-matrix.cjs), que monta el engine
 * BUILT contra sus propias fixtures sin necesitar ningún dev server.
 *
 * Uso:
 *   yarn test:e2e             # suite del editor (necesita el editor en :3000)
 *   HEADLESS=0 yarn test:e2e  # con ventana visible
 *
 * Env: BASE_EDITOR, CHROME_BIN, HEADLESS (0/1).
 *
 * Salida: ./shots/<timestamp>/*.png  y  ./shots/<timestamp>/report.txt
 * Exit code 0 si todos los checks PASS, 1 si algún FAIL, 2 si error de setup.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

// ─── Config ────────────────────────────────────────────────────────────────
const CFG = {
  editor: process.env.BASE_EDITOR || 'http://localhost:3000',
  headless: process.env.HEADLESS !== '0',
  vw: 1280, vh: 800,
};
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/homebrew/bin/chromium',
  '/usr/bin/chromium',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const SUITE = arg('suite', 'editor'); // 'editor' es la única suite viva aquí

// ─── Sandbox workspace (contenido de prueba propio, NO el del usuario) ────────
const FIXTURES = path.join(__dirname, 'fixtures', 'content');
const WS = 'sandbox';
const SLUG_MUNDO = 'demo-mundo';
const SLUG_EVENTO = 'demo-evento';
let SANDBOX_DIR = null; // temp dir; se borra al final

// Crea un directorio temporal y copia ahí las fixtures versionadas. El editor
// edita/guarda en ESTA copia, así que ninguna corrida ensucia el árbol del repo.
function setupSandbox() {
  SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-e2e-'));
  fs.cpSync(FIXTURES, path.join(SANDBOX_DIR, 'content'), { recursive: true });
  return {
    id: WS,
    name: 'Sandbox E2E',
    repoPath: SANDBOX_DIR,
    contentRoot: 'content',
    useGit: false,
  };
}
function teardownSandbox() {
  if (SANDBOX_DIR) { try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch {} }
}

// ─── Reporte ───────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const SHOTS = path.join(__dirname, 'shots', stamp);
fs.mkdirSync(SHOTS, { recursive: true });
const lines = [];
let failures = 0;
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const check = (label, ok, detail = '') => { if (!ok) failures++; log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); return ok; };

// El engine pinta [data-parallax-id] con pointer-events:none; la selección del
// editor hace hit-test geométrico sobre clientX/Y. Por eso clickeamos el canvas
// en las coordenadas del elemento, no el elemento (Playwright no lo "clickearía").
async function selectElementByPoint(page, idx = 0) {
  const t = await page.evaluate((i) => {
    const e = [...document.querySelectorAll('[data-parallax-id]')][i];
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { id: e.getAttribute('data-parallax-id'), cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
  }, idx);
  if (!t) return null;
  await page.mouse.click(t.cx, t.cy);
  await page.waitForTimeout(700);
  return t;
}

// Abre un proyecto del workspace sandbox de forma robusta:
//   1) recarga el landing, 2) activa el workspace por su chip,
//   3) clica la card del proyecto, 4) fallback: navega directo a /edit/<ws>/<slug>.
// Devuelve true si el editor cargó.
async function openProject(page, wsId, slug) {
  // Detect editor by stable DOM markers, not localized panel titles:
  // `.layers-panel` / `.properties-panel` are CSS classes (locale-agnostic),
  // and `[data-parallax-id]` only appears once the canvas mounted a site.
  const inEditor = () => page.evaluate(() =>
    !!document.querySelector('[data-parallax-id]')
    || !!document.querySelector('.layers-panel, .properties-panel'));
  try { await page.goto(CFG.editor + '/', { waitUntil: 'load', timeout: 25000 }); } catch {}
  await page.waitForTimeout(1800);
  const chip = page.locator(`[data-test=workspace-chip-${wsId}] .ws-chip-name`).first();
  if (await chip.count().catch(() => 0)) { await chip.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(1300); }
  const card = page.locator(`[data-test="project-card-${wsId}-${slug}"]`).first();
  if (await card.count().catch(() => 0)) { await card.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(2800); }
  if (await inEditor()) return true;
  try { await page.goto(`${CFG.editor}/edit/${wsId}/${slug}`, { waitUntil: 'load', timeout: 25000 }); } catch {}
  await page.waitForTimeout(2800);
  return inEditor();
}

// ─── Editor suite (como el usuario, sobre el sandbox) ──────────────────────────
async function runEditor(page) {
  log(`\n=== EDITOR :3000 (como el usuario, workspace sandbox) ===`);
  try {
    await page.goto(CFG.editor + '/', { waitUntil: 'load', timeout: 25000 });
    await page.waitForTimeout(2500);
  } catch (e) { check('carga editor', false, e.message); return; }
  await page.screenshot({ path: path.join(SHOTS, 'editor-00-landing.png'), fullPage: true });

  const landing = await page.evaluate(() => ({
    clickables: [...document.querySelectorAll('button,a,[role=button],[class*=card],[class*=Card]')]
      .map(e => e.innerText.trim()).filter(Boolean).slice(0, 40),
  }));
  log('landing clickables: ' + JSON.stringify(landing.clickables));

  // [#64] panel de creación: nombre libre → slug kebab read-only en vivo (no crea nada)
  try {
    // Scope to the project selector's "New" CTA (.btn-new). `hasText` would
    // also match the WebMenu's hidden "Nuevo proyecto" menu item — that's in
    // the DOM but invisible, so `.first()` resolved to it and clicks timed out.
    const nuevo = page.locator('button.btn-new').first();
    if (await nuevo.count()) { await nuevo.click().catch(() => {}); await page.waitForTimeout(500); }
    const nameInput = page.locator('[data-test=new-site-name]').first();
    if (await nameInput.count()) {
      await nameInput.fill('Mundo Demo & Pruebas — 15 de Marzo!'); await page.waitForTimeout(400);
      const slug = (await page.locator('[data-test=new-site-slug]').first().innerText().catch(() => '')).trim();
      check('[#64] slug kebab en vivo (nombre libre → title; slug auto)', slug === 'mundo-demo-pruebas-15-de-marzo', JSON.stringify(slug));
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    } else check('[#64] input [data-test=new-site-name] en panel de creación', false);
  } catch (e) { check('[#64] panel de creación', false, e.message); }

  // Barra de workspaces (Fase 2): chips + lista de proyectos del activo.
  const wsBar = await page.evaluate(() => ({
    bar: !!document.querySelector('[data-test=workspace-bar]'),
    chips: document.querySelectorAll('[data-test^=workspace-chip-]').length,
  }));
  check('[ws] barra de workspaces con chips', wsBar.bar && wsBar.chips >= 1, JSON.stringify(wsBar));

  const opened = await openProject(page, WS, SLUG_MUNDO);
  log(`abrió proyecto ${WS}/${SLUG_MUNDO}: ${opened}`);
  await page.screenshot({ path: path.join(SHOTS, 'editor-01-opened.png'), fullPage: true });

  const ed = await page.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/(\d{1,3})\s*%/);
    return {
      // Locale-agnostic: structural panels + canvas marker, no panel-title text.
      isEditor: !!document.querySelector('[data-parallax-id]')
        || !!document.querySelector('.layers-panel, .properties-panel'),
      hasSeleccionar: /Seleccionar/i.test(txt),
      hasMano: /Mano/i.test(txt),
      plusBtns: [...document.querySelectorAll('button')].map(b => (b.innerText || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim())
        .filter(s => /\+|secci[oó]n|capa|texto|imagen/i.test(s)),
      zoom: m ? +m[1] : null,
      ids: [...document.querySelectorAll('[data-parallax-id]')].map(e => e.getAttribute('data-parallax-id')),
    };
  });
  check('editor abrió un proyecto (.layers-panel/.properties-panel o canvas)', ed.isEditor);
  check('[#1] hay controles para crear (sección/capa/texto/imagen)', ed.plusBtns.length > 0, JSON.stringify(ed.plusBtns));
  check('[#4] herramientas legibles (Seleccionar + Mano, no V/H pelados)', ed.hasSeleccionar && ed.hasMano);
  check('[#2] hay indicador de zoom', ed.zoom != null, `zoom=${ed.zoom}%`);

  // [#2] zoom reactivo
  const zin = page.locator('button', { hasText: /^\+$/ }).first();
  if (await zin.count().catch(() => 0)) {
    await zin.click(); await zin.click(); await page.waitForTimeout(500);
    const z1 = await page.evaluate(() => { const m = document.body.innerText.match(/(\d{1,3})\s*%/); return m ? +m[1] : null; });
    check('[#2] zoom cambia al pulsar "+"', z1 != null && z1 !== ed.zoom, `${ed.zoom}% -> ${z1}%`);
  } else { check('[#2] botón "+" de zoom encontrado', false); }

  // [#5/#6] overlay de selección alineado (selectores reales: .selection-box / .empty-state)
  {
    const t = await selectElementByPoint(page, 0);
    if (!t) { check('[#5/#6] hay elementos en el canvas para seleccionar', false); }
    else {
      await page.screenshot({ path: path.join(SHOTS, 'editor-02-selected.png'), fullPage: true });
      const cmp = await page.evaluate((tid) => {
        const e = document.querySelector(`[data-parallax-id="${tid}"]`);
        const ov = document.querySelector('.editor-canvas .selection-box, .selection-box');
        const R = n => n ? (b => ({ x: b.x, y: b.y }))(n.getBoundingClientRect()) : null;
        return { er: R(e), ov: R(ov), emptyGone: !document.querySelector('.empty-state') };
      }, t.id);
      log(`selección "${t.id}" elem=${JSON.stringify(cmp.er && {x:Math.round(cmp.er.x),y:Math.round(cmp.er.y)})} box=${JSON.stringify(cmp.ov && {x:Math.round(cmp.ov.x),y:Math.round(cmp.ov.y)})}`);
      check('[#5/#6] click selecciona (empty-state desaparece)', cmp.emptyGone);
      if (cmp.er && cmp.ov) {
        const dx = Math.abs(cmp.er.x - cmp.ov.x), dy = Math.abs(cmp.er.y - cmp.ov.y);
        check('[#5/#6] .selection-box alineado con el elemento', dx < 14 && dy < 14, `dx=${Math.round(dx)} dy=${Math.round(dy)}`);
      } else { check('[#5/#6] .selection-box presente', false, `box=${!!cmp.ov} elem=${!!cmp.er}`); }
    }
  }

  // ── Editor deep: scroll preview, agregar elemento, tipo read-only, animaciones, preview toggle ──
  // [#13] scroll del preview
  try {
    const before = await page.evaluate(() => {
      const e = document.querySelector('[data-parallax-id]'); return e ? Math.round(e.getBoundingClientRect().top) : null;
    });
    const canvas = page.locator('.editor-canvas, [class*=canvas]').first();
    const box = await canvas.boundingBox().catch(() => null);
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 1200); await page.waitForTimeout(700); }
    const after = await page.evaluate(() => {
      const e = document.querySelector('[data-parallax-id]'); return e ? Math.round(e.getBoundingClientRect().top) : null;
    });
    await page.screenshot({ path: path.join(SHOTS, 'editor-03-scrolled.png'), fullPage: true });
    check('[#13] scroll del preview mueve el contenido', before != null && after != null && Math.abs(after - before) > 30, `top ${before}->${after}`);
  } catch (e) { check('[#13] scroll del preview', false, e.message); }

  // [#14] botón "+ Elemento" abre menú con 4 tipos; tipo read-only en propiedades
  try {
    const addBtn = page.locator('button:not(.webmenu-item)', { hasText: /\+ ?Elemento|Agregar elemento/i }).first();
    if (await addBtn.count()) {
      await addBtn.click(); await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, 'editor-04-addmenu.png'), fullPage: true });
      const menu = await page.evaluate(() => {
        const txt = document.body.innerText;
        return ['Texto', 'Imagen', 'Video', 'Audio'].filter(t => new RegExp(`\\b${t}\\b`, 'i').test(txt));
      });
      check('[#14] menú de tipo con Texto/Imagen/Video/Audio', menu.length >= 4, JSON.stringify(menu));
    } else check('[#14] botón "+ Elemento" presente', false);
    const typeEditable = await page.evaluate(() => {
      const lab = [...document.querySelectorAll('label,div,span')].find(n => /^\s*Tipo\s*$/i.test(n.textContent || ''));
      if (!lab) return null;
      const row = lab.closest('[class*=field],[class*=prop],div'); return row ? !!row.querySelector('input:not([readonly]),select') : null;
    });
    check('[#14] "Tipo" no editable en propiedades', typeEditable === false || typeEditable === null, `editable=${typeEditable}`);
  } catch (e) { check('[#14] add-element/tipo', false, e.message); }

  // [#16] sub-panel de animaciones + toggle Edición/Preview
  try {
    await page.keyboard.press('Escape').catch(() => {}); // cerrar menú de tipo si quedó abierto
    await selectElementByPoint(page, 0);
    const anim = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.anim-header span, .prop-group-title span')].map(s => s.textContent.trim());
      return { hasHeader: spans.some(t => /^Animaciones \(\d+\)$/.test(t)), addBtn: !!document.querySelector('.anim-add'), sample: spans.slice(0, 6) };
    });
    check('[#16] sub-panel de animaciones (Animaciones (N) + add)', anim.hasHeader && anim.addBtn, JSON.stringify(anim.sample));
    // Detect the Edit/Preview toggle by its structural marker (the `.mode-toggle`
    // group has two `.mode-btn` children) instead of localized button text,
    // so the assertion survives an `en` locale where the labels are "Edit"/"Preview".
    const toggle = await page.evaluate(() => {
      const grp = document.querySelector('.mode-toggle');
      return !!grp && grp.querySelectorAll('.mode-btn').length >= 2;
    });
    check('[#16] toggle Edición/Preview presente', toggle);
  } catch (e) { check('[#16] animaciones/preview', false, e.message); }

  // [#21] video seleccionable + [#22] grid overlay — estado limpio (reload + reabrir)
  try {
    await openProject(page, WS, SLUG_MUNDO);
    let menuOpen = await page.evaluate(() => !!document.querySelector('.add-element-menu'));
    if (!menuOpen) {
      const addBtn = page.locator('button:not(.webmenu-item)', { hasText: /\+ ?Elemento|Agregar elemento/i }).first();
      if (await addBtn.count()) { await addBtn.click(); await page.waitForTimeout(400); menuOpen = true; }
    }
    if (menuOpen) {
      const vid = page.locator('.add-element-menu').getByText(/^\s*Video\s*$/).first();
      if (await vid.count()) { await vid.click(); await page.waitForTimeout(1000); }
    }
    const v = await page.evaluate(() => {
      const n = document.querySelector('.parallax-video-element');
      const r = n && n.getBoundingClientRect();
      return { host: !!n, hasId: !!document.querySelector('.parallax-video-element[data-parallax-id]'),
               cx: r ? r.x + r.width / 2 : null, cy: r ? r.y + r.height / 2 : null };
    });
    check('[#21] host de video con data-parallax-id (stamp editor)', v.hasId, `host=${v.host}`);
    // Al crear el video se auto-selecciona: el .selection-box debe caer sobre el video.
    const vsel = await page.evaluate(() => {
      const n = document.querySelector('.parallax-video-element[data-parallax-id]');
      const sb = document.querySelector('.editor-canvas .selection-box');
      const R = e => e ? (b => ({ x: b.x, y: b.y }))(e.getBoundingClientRect()) : null;
      return { nr: R(n), sbr: R(sb), sb: !!sb };
    });
    await page.screenshot({ path: path.join(SHOTS, 'editor-06-video.png'), fullPage: true });
    if (vsel.sb && vsel.nr && vsel.sbr) {
      const dx = Math.abs(vsel.nr.x - vsel.sbr.x), dy = Math.abs(vsel.nr.y - vsel.sbr.y);
      check('[#21] video seleccionable (.selection-box sobre el video)', dx < 14 && dy < 14, `dx=${Math.round(dx)} dy=${Math.round(dy)}`);
    } else check('[#21] video seleccionable (.selection-box presente)', false, `sb=${vsel.sb}`);

    const gridBefore = await page.evaluate(() => !!document.querySelector('[data-test=grid-overlay]'));
    // El control de grid vive en el popover "Grid y guías ▾": hay que abrirlo
    // antes de togglear "Mostrar grid" (data-test=grid-visible-toggle).
    const ensureGridOpen = async () => {
      const open = await page.evaluate(() => !!document.querySelector('[data-test=grid-guides-popover]'));
      if (!open) { await page.locator('[data-test=grid-guides-trigger]').first().click().catch(() => {}); await page.waitForTimeout(300); }
    };
    await ensureGridOpen();
    await page.locator('[data-test=grid-visible-toggle]').first().click().catch(() => {}); await page.waitForTimeout(400);
    const gridOn = await page.evaluate(() => !!document.querySelector('[data-test=grid-overlay]'));
    await page.screenshot({ path: path.join(SHOTS, 'editor-07-grid.png'), fullPage: true });
    check('[#22] Grid muestra overlay al activar', !gridBefore && gridOn, `before=${gridBefore} on=${gridOn}`);
    await ensureGridOpen();
    await page.locator('[data-test=grid-visible-toggle]').first().click().catch(() => {}); await page.waitForTimeout(300);
    check('[#22] Grid oculta overlay al desactivar',
      await page.evaluate(() => !document.querySelector('[data-test=grid-overlay]')));
  } catch (e) { check('[#21/#22] video/grid', false, e.message); }

  // ── Polish: #26 fontsize, #29 no-overflow, #30 tooltip, #31 units, #27 FormBlock, #24 scroll panel, #32 wheel ──
  try {
    // seleccionar un TEXTO vía el árbol de CAPAS (determinista, sin overlap del video de #21)
    const treeText = page.locator('.layers-panel').getByText(/^demo-titulo$|^demo-subtitulo$/).first();
    if (await treeText.count()) { await treeText.click().catch(() => {}); await page.waitForTimeout(600); }
    else await selectElementByPoint(page, 0);
    await page.waitForTimeout(400);
    const probe = await page.evaluate(() => {
      const pb = document.querySelector('.properties-panel .panel-body') || document.querySelector('.properties-panel');
      const pbr = pb && pb.getBoundingClientRect();
      const btns = [...document.querySelectorAll('.properties-panel [data-test=help-hint-btn]')];
      const over = btns.filter(b => pbr && b.getBoundingClientRect().right > pbr.right + 2).length;
      const unit = [...document.querySelectorAll('.properties-panel [data-test=field-unit]')].map(u => u.textContent.trim());
      return {
        fontsize: !!document.querySelector('[data-test=fontsize-field]'),
        helpBtns: btns.length, helpOverflow: over,
        units: unit, hasPct: unit.includes('%'),
        panelScrollable: pb ? pb.scrollHeight > pb.clientHeight + 2 : null,
      };
    });
    check('[#26] control de tamaño amigable ([data-test=fontsize-field])', probe.fontsize);
    const typo = await page.evaluate(() => ({
      align: !!document.querySelector('[data-test=text-align-select]'),
      ls: !!document.querySelector('[data-test=letter-spacing-field]'),
      lh: !!document.querySelector('[data-test=line-height-field]'),
    }));
    check('[#49] controles tipográficos (alineación/interletra/interlínea)', typo.align && typo.ls && typo.lh, JSON.stringify(typo));
    check('[#29] iconos "?" sin desbordar el panel', probe.helpBtns > 0 && probe.helpOverflow === 0, `btns=${probe.helpBtns} overflow=${probe.helpOverflow}`);
    check('[#31] unidades visibles (% en posición)', probe.hasPct, JSON.stringify(probe.units.slice(0, 8)));

    // #30 tooltip no recortado (teleport a body, dentro del viewport)
    const hb = page.locator('.properties-panel [data-test=help-hint-btn]').first();
    if (await hb.count()) {
      await hb.click(); await page.waitForTimeout(300);
      const tip = await page.evaluate(() => {
        const t = document.querySelector('[data-test=help-hint-pop]');
        if (!t) return { found: false };
        const r = t.getBoundingClientRect();
        return { found: true, txt: (t.textContent || '').trim().length,
          inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 };
      });
      check('[#30] tooltip visible y no recortado', tip.found && tip.txt > 0 && tip.inView, JSON.stringify(tip));
      await page.keyboard.press('Escape').catch(() => {});
    } else check('[#30] hay icono de ayuda para abrir tooltip', false);

    // #27 FormBlock: menú -> Formulario -> editor de FormBlock
    let menuOpen = await page.evaluate(() => !!document.querySelector('.add-element-menu'));
    if (!menuOpen) {
      const ab = page.locator('button:not(.webmenu-item)', { hasText: /\+ ?Elemento|Agregar elemento/i }).first();
      if (await ab.count()) { await ab.click(); await page.waitForTimeout(400); }
    }
    const formOpt = page.locator('[data-test=add-element-form]').first();
    if (await formOpt.count()) {
      await formOpt.click(); await page.waitForTimeout(900);
      const fb = await page.evaluate(() => ({
        editor: !!document.querySelector('[data-test=formblock-editor]'),
        addField: !!document.querySelector('[data-test=formblock-add-field]'),
      }));
      check('[#27] FormBlock: editor + CRUD de campos', fb.editor && fb.addField, JSON.stringify(fb));
      // #24 con RUEDA REAL (reproduce el hijack de Lenis; scrollTop programático daba PASS falso)
      const pbBox = await page.locator('.properties-panel .panel-body').first().boundingBox().catch(() => null);
      let pb2 = null;
      if (pbBox) {
        const can = await page.evaluate(() => { const p = document.querySelector('.properties-panel .panel-body'); return p ? p.scrollHeight > p.clientHeight + 2 : false; });
        await page.mouse.move(pbBox.x + pbBox.width / 2, pbBox.y + pbBox.height / 2);
        for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(90); }
        await page.waitForTimeout(300);
        const top = await page.evaluate(() => { const p = document.querySelector('.properties-panel .panel-body'); return p ? Math.round(p.scrollTop) : -1; });
        pb2 = { can, scrolledByWheel: top > 20, top };
      }
      check('[#24] panel de propiedades scrollea con RUEDA real (sin hijack de Lenis)', !!pb2 && pb2.can && pb2.scrolledByWheel, JSON.stringify(pb2));
    } else check('[#27] opción "Formulario" en el menú', false);

    // #32 wheel con herramienta Seleccionar, sin click previo
    const seleccionar = page.locator('button', { hasText: /Seleccionar/i }).first();
    if (await seleccionar.count()) { await seleccionar.click().catch(() => {}); await page.waitForTimeout(200); }
    const cv = await page.locator('.editor-canvas').boundingBox().catch(() => null);
    if (cv) {
      const pre = await page.evaluate(() => {
        const s = document.querySelector('.preview-scroll');
        const pw = document.querySelector('.pan-wrapper');
        return { sl: s ? s.scrollLeft : 0, st: s ? s.scrollTop : 0, tf: pw ? getComputedStyle(pw).transform : '' };
      });
      await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
      await page.mouse.wheel(120, 240);
      await page.waitForTimeout(500);
      const post = await page.evaluate(() => {
        const s = document.querySelector('.preview-scroll');
        const pw = document.querySelector('.pan-wrapper');
        return { sl: s ? s.scrollLeft : 0, st: s ? s.scrollTop : 0, tf: pw ? getComputedStyle(pw).transform : '' };
      });
      const moved = Math.abs(post.sl - pre.sl) > 3 || Math.abs(post.st - pre.st) > 3 || post.tf !== pre.tf;
      check('[#32] wheel mueve el canvas con Seleccionar (sin click)', moved, `dSL=${Math.round(post.sl-pre.sl)} dST=${Math.round(post.st-pre.st)} tfChg=${post.tf!==pre.tf}`);
    } else check('[#32] canvas presente para scroll', false);
  } catch (e) { check('[polish #24-#32]', false, e.message); }

  // ── #27/#35 FormBlock real (estado limpio: demo-evento → elemento rsvp-form) ──
  try {
    await openProject(page, WS, SLUG_EVENTO);
    const fbNode = page.locator('.layers-panel').getByText(/rsvp-form|FormBlock/i).first();
    if (await fbNode.count()) { await fbNode.click().catch(() => {}); await page.waitForTimeout(800); }
    const fe = await page.evaluate(() => {
      const g = [...document.querySelectorAll('[data-test^="formblock-group-"]')]
        .map(n => n.getAttribute('data-test')).filter(t => !/-toggle|-body/.test(t));
      return { editor: !!document.querySelector('[data-test=formblock-editor]'), firstGroup: g[0] || '' };
    });
    check('[#27] FormBlock editor presente', fe.editor);
    check('[#35] CAMPOS es el primer grupo del editor', /campos/.test(fe.firstGroup), fe.firstGroup);
    const lbl = page.locator('[data-test=formblock-field]').first().locator('.prop-field', { hasText: 'Etiqueta' }).locator('input').first();
    let persisted = false;
    if (await lbl.count()) { await lbl.fill('E2E LABEL'); await lbl.blur(); await page.waitForTimeout(300); persisted = (await lbl.inputValue()) === 'E2E LABEL'; }
    check('[#27] editar Etiqueta de campo persiste', persisted);
    const b4 = await page.locator('[data-test=formblock-field]').count();
    await page.locator('[data-test=formblock-add-field]').first().click().catch(() => {}); await page.waitForTimeout(400);
    check('[#27] "+" agrega un campo', (await page.locator('[data-test=formblock-field]').count()) > b4);
    await page.locator('[data-test=formblock-group-estilo]').first().click().catch(() => {}); await page.waitForTimeout(300);
    const sw = page.locator('[data-test=formblock-swatch-buttonBg-accent]').first();
    if (await sw.count()) {
      await sw.click().catch(() => {}); await page.waitForTimeout(300);
      const raw = await page.locator('[data-test=formblock-style-buttonBg-raw]').first().inputValue().catch(() => '');
      check('[#35] swatch del theme escribe var(--color-accent)', /var\(--color-accent\)/.test(raw), raw);
    } else check('[#35] swatch de estilo presente', false);
  } catch (e) { check('[#27/#35] FormBlock', false, e.message); }

  // ── #66/#67: panel Claude tipo chat + adjuntar imágenes (UI, sin llamar a Claude) ──
  try {
    const tgl = page.locator('[data-test=toggle-claude]').first();
    if (await tgl.count()) { await tgl.click().catch(() => {}); await page.waitForTimeout(500); }
    const ui = await page.evaluate(() => ({
      panel: !!document.querySelector('[data-test=claude-panel]'),
      chat: !!document.querySelector('[data-test=claude-chat]'),
      input: !!document.querySelector('[data-test=claude-input]'),
      attach: !!document.querySelector('[data-test=claude-attach]'),
    }));
    check('[#66/#67] panel Claude: chat + input + adjuntar imágenes', ui.panel && ui.chat && ui.input && ui.attach, JSON.stringify(ui));
    const tglOff = page.locator('[data-test=toggle-claude]').first();
    if (await tglOff.count()) { await tglOff.click().catch(() => {}); await page.waitForTimeout(300); }
  } catch (e) { check('[#66/#67] panel Claude UI', false, e.message); }

  // ── #54: editar meta/tema global desde el árbol ──
  try {
    const siteEntry = page.locator('[data-test=tree-site]').first();
    const themeEntry = page.locator('[data-test=tree-theme]').first();
    check('[#54] entradas "Sitio" y "Tema" en el árbol', (await siteEntry.count()) > 0 && (await themeEntry.count()) > 0);
    if (await siteEntry.count()) {
      await siteEntry.click(); await page.waitForTimeout(500);
      const siteForm = await page.evaluate(() => ({
        panel: !!document.querySelector('[data-test=props-site]'),
        title: !!document.querySelector('[data-test=meta-title-field]'),
        noOverlay: !document.querySelector('.editor-canvas .selection-box'),
      }));
      check('[#54] "Sitio" muestra form de meta y limpia selección', siteForm.panel && siteForm.title && siteForm.noOverlay, JSON.stringify(siteForm));
    }
    if (await themeEntry.count()) {
      await themeEntry.click(); await page.waitForTimeout(400);
      check('[#54] "Tema" muestra form de theme', await page.evaluate(() => !!document.querySelector('[data-test=props-theme]')));
    }
  } catch (e) { check('[#54] meta/tema global', false, e.message); }

  // ── GAP4: visibilidad / lock / draggable cross-parent (sigue en demo-evento) ──
  try {
    const vis = page.locator('[data-test="layer-visibility-evento-fecha"]').first();
    if (await vis.count()) {
      await vis.click(); await page.waitForTimeout(500);
      const hidden = await page.evaluate(() => !document.querySelector('[data-parallax-id="evento-fecha"]'));
      check('[GAP4] toggle visibilidad oculta el elemento en el preview', hidden);
      await vis.click(); await page.waitForTimeout(500);
      check('[GAP4] visibilidad reversible', await page.evaluate(() => !!document.querySelector('[data-parallax-id="evento-fecha"]')));
    } else check('[GAP4] botón de visibilidad presente', false);

    const lock = page.locator('[data-test="layer-lock-evento-titulo"]').first();
    if (await lock.count()) {
      await lock.click(); await page.waitForTimeout(300);
      await page.locator('.layers-panel').getByText(/^evento-titulo$/).first().click().catch(() => {});
      await page.waitForTimeout(500);
      check('[GAP4] elemento bloqueado: overlay muestra badge bloqueado', await page.locator('[data-test=overlay-locked]').count() > 0);
      await lock.click(); await page.waitForTimeout(300);
    } else check('[GAP4] botón de lock presente', false);

    const drag = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-test^="layer-row-"]')];
      return { rows: rows.length, draggable: rows.filter(r => r.getAttribute('draggable') === 'true').length };
    });
    check('[GAP4] secciones/layers/elementos draggable (cross-parent habilitado)', drag.rows > 0 && drag.draggable >= 3, JSON.stringify(drag));
  } catch (e) { check('[GAP4] visibilidad/lock/drag', false, e.message); }

  // ── #19/#28 endpoint de assets (PROYECTO TEMPORAL aislado dentro del sandbox) ──
  // El proyecto se crea+borra vía API en el workspace sandbox efímero — nada toca
  // el repo del editor ni el contenido real.
  try {
    const tmpName = 'zz-e2e-assets-' + Date.now();
    const cr = await page.request.post(`${CFG.editor}/api/projects/${WS}`, { data: { name: tmpName } });
    const tmpSlug = (await cr.json().catch(() => ({}))).slug;
    if (!tmpSlug) { check('[#19/#28] crear proyecto temporal para assets', false, `status=${cr.status()}`); }
    else {
      const post = async (fn, dataUrl) => {
        const r = await page.request.post(`${CFG.editor}/api/projects/${WS}/${tmpSlug}/assets`, { data: { filename: fn, dataUrl } });
        return { status: r.status(), body: await r.json().catch(() => ({})) };
      };
      const img = await post('e2e.png', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=');
      check('[#19] upload imagen → src images/', img.status === 200 && /^images\//.test(img.body.src || ''), JSON.stringify(img.body));
      const vid = await post('e2e.mp4', 'data:video/mp4;base64,AAAAIGZ0eXBpc29t');
      check('[#28] upload video → src video/', vid.status === 200 && /^video\//.test(vid.body.src || ''), JSON.stringify(vid.body));
      await page.request.delete(`${CFG.editor}/api/projects/${WS}/${tmpSlug}`).catch(() => {}); // borra el proyecto temporal entero
    }
  } catch (e) { check('[#19/#28] assets', false, e.message); }

  // ── #38/#39/#40 vistas independientes + copy-paste (estado limpio) ──
  try {
    await openProject(page, WS, SLUG_MUNDO);

    const enable = page.locator('[data-test=enable-independent-views]').first();
    const indPre = await page.locator('[data-test=view-mode-indicator]').count();
    check('[#38] proyecto legacy arranca en modo compartido', (await enable.count()) > 0 && indPre === 0);

    if (await enable.count()) {
      await enable.click().catch(() => {});
      await page.waitForTimeout(500);
      // "Separar vistas" pide confirmación con el modal propio (DialogHost, no
      // window.confirm) → hay que aceptar [data-test=dialog-confirm].
      const confirmBtn = page.locator('[data-test=dialog-confirm]').first();
      if (await confirmBtn.count().catch(() => 0)) { await confirmBtn.click().catch(() => {}); }
      await page.waitForTimeout(1200);
    }
    const ind = page.locator('[data-test=view-mode-indicator]').first();
    const indOn = await ind.count();
    const av1 = indOn ? await ind.getAttribute('data-active-view').catch(() => null) : null;
    check('[#38] modo independiente activado (indicador desktop)', indOn > 0 && av1 === 'desktop', `activeView=${av1}`);

    const devM = page.locator('[data-test=device-mobile]').first();
    if (await devM.count()) { await devM.click().catch(() => {}); await page.waitForTimeout(600); }
    const av2 = await page.locator('[data-test=view-mode-indicator]').first().getAttribute('data-active-view').catch(() => null);
    check('[#38] toggle de dispositivo cambia la vista activa', av2 === 'mobile', `activeView=${av2}`);

    // copy en desktop → paste en mobile
    const devD = page.locator('[data-test=device-desktop]').first();
    if (await devD.count()) { await devD.click().catch(() => {}); await page.waitForTimeout(500); }
    const node = page.locator('.layers-panel').getByText(/^demo-titulo$|^demo-subtitulo$/).first();
    if (await node.count()) { await node.click().catch(() => {}); await page.waitForTimeout(400); }
    const copyBtn = page.locator('[data-test=layers-copy]').first();
    if (await copyBtn.count()) { await copyBtn.click().catch(() => {}); await page.waitForTimeout(300); }
    const clipTxt = await page.locator('[data-test=layers-clip-status]').first().innerText().catch(() => '');
    check('[#39] copiar elemento (clipboard con contenido)', /copiad|elemento/i.test(clipTxt), JSON.stringify(clipTxt.slice(0, 60)));

    if (await devM.count()) { await devM.click().catch(() => {}); await page.waitForTimeout(600); }
    const tgt = page.locator('.layers-panel').getByText(/hero-content|^hero$/).first();
    if (await tgt.count()) { await tgt.click().catch(() => {}); await page.waitForTimeout(400); }
    const beforePaste = await page.locator('.layers-panel').getByText(/demo-titulo/).count();
    const pasteBtn = page.locator('[data-test=layers-paste]').first();
    if (await pasteBtn.count()) { await pasteBtn.click().catch(() => {}); await page.waitForTimeout(600); }
    const clip2 = await page.locator('[data-test=layers-clip-status]').first().innerText().catch(() => '');
    const afterPaste = await page.locator('.layers-panel').getByText(/demo-titulo/).count();
    check('[#39] pegar en vista mobile (cross-view)', /pegad/i.test(clip2) || afterPaste > beforePaste, `hint=${JSON.stringify(clip2.slice(0,40))} ${beforePaste}->${afterPaste}`);
  } catch (e) { check('[#38/#39/#40 vistas+clipboard]', false, e.message); }

  // ── REGRESSIONS (this session) ────────────────────────────────────────────
  // The tests below guard fixes landed in the multi-phase tweaks branch and
  // are intentionally placed BEFORE the destructive Preview toggle.

  // (A) Inline-edit caret lands AT THE DOUBLE-CLICK POINT, not at the end.
  // The original bug was that `caretPositionFromPoint` saw the overlay's
  // `.move-area` covering the text and returned a position outside the text
  // node — code fell through to "caret at end" so every dblclick started
  // editing at the LAST character. After the fix (text-node walk in
  // SelectionOverlay.vue → caretRangeInsideAtPoint), the caret lands at the
  // closest character to the click. Verifies caret offset is well below the
  // text length when the user clicks near the LEFT of the text.
  try {
    await openProject(page, WS, SLUG_MUNDO)
    // Pick the first text element via the layers panel (deterministic) — the
    // canvas-point selection in [#5/#6] above could land on a non-text element.
    const treeText = page.locator('.layers-panel').getByText(/^demo-titulo$|^demo-subtitulo$/).first()
    if (await treeText.count()) { await treeText.click().catch(() => {}); await page.waitForTimeout(500) }
    const probe = await page.evaluate(() => {
      // Find any selected text element by data-parallax-id (the inline editor
      // turns the host into contenteditable — pick the host that the overlay
      // is sitting on).
      const sb = document.querySelector('.editor-canvas .selection-box')
      if (!sb) return null
      const sbr = sb.getBoundingClientRect()
      // Find a text-element host underneath the overlay.
      const host = [...document.querySelectorAll('[data-parallax-id]')]
        .find((n) => {
          const r = n.getBoundingClientRect()
          return Math.abs(r.x - sbr.x) < 10 && Math.abs(r.y - sbr.y) < 10 && (n.innerText || '').trim().length > 6
        })
      if (!host) return null
      const r = host.getBoundingClientRect()
      const text = (host.innerText || '').trim()
      return {
        id: host.getAttribute('data-parallax-id'),
        textLen: text.length,
        // Click ~15% from the left edge of the text — well before the end.
        clickX: Math.round(r.left + r.width * 0.15),
        clickY: Math.round(r.top + r.height * 0.5),
      }
    })
    if (!probe) {
      check('[regression caret] text element under overlay encontrado', false)
    } else {
      await page.mouse.dblclick(probe.clickX, probe.clickY)
      await page.waitForTimeout(400)
      const caret = await page.evaluate(() => {
        const sel = window.getSelection()
        if (!sel || sel.rangeCount === 0) return null
        const r = sel.getRangeAt(0)
        // Find the host with data-parallax-id this caret is inside, so we can
        // measure the offset as a fraction of the text length.
        let n = r.startContainer
        while (n && n.nodeType === 3) n = n.parentNode
        let host = n
        while (host && !(host.getAttribute && host.getAttribute('data-parallax-id'))) host = host.parentElement
        const text = host ? (host.innerText || '') : ''
        return {
          offset: r.startOffset,
          collapsed: r.collapsed,
          textLen: text.length,
          // Caret rect — proxies the on-screen position of the inserted cursor.
          caretRect: (() => { const rr = r.getBoundingClientRect(); return { x: rr.left, y: rr.top } })(),
        }
      })
      // Two complementary signals: (1) caret is collapsed (a real insertion
      // point, not a selection of "all content"), (2) caret rect's x is in
      // the LEFT THIRD of the text element's box (proxy for "near the click,
      // not at the end"). The old broken behavior landed the caret at the
      // FAR RIGHT of the box every time.
      const fracX = caret && probe.textLen ? (caret.caretRect.x - probe.clickX) : null
      check(
        '[regression caret] dblclick coloca caret CERCA del punto de click (no al final)',
        !!caret && caret.collapsed && fracX !== null && Math.abs(fracX) < 40,
        `offset=${caret && caret.offset} textLen=${caret && caret.textLen} click.x=${probe.clickX} caret.x=${caret && Math.round(caret.caretRect.x)} dx=${fracX !== null && Math.round(fracX)}`,
      )
      // Exit inline editing so subsequent tests are not in contenteditable.
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(200)
    }
  } catch (e) { check('[regression caret] inline-edit caret position', false, e.message) }

  // (B) Locale toggle: switching language in the web menu re-renders UI text.
  // Guards: the new keys (properties.animHeader / loadFromPC / dropImage /
  // sizeField.* etc.) actually wire to the live locale dictionary. The
  // smoke probe just checks the localized webmenu trigger label flips
  // between "Idioma" and "Language" — that is enough to prove the boot-time
  // sync + reactivity round-trip end-to-end without depending on any one
  // panel being open.
  try {
    const lang = page.locator('[data-test=webmenu-language]').first()
    if (await lang.count()) {
      // Boot locale is pinned to ES by the init script — start in Spanish.
      const labelEs = (await lang.innerText().catch(() => '')).trim()
      await lang.click(); await page.waitForTimeout(300)
      const enRow = page.locator('[data-test=webmenu-pop-language] .webmenu-item', { hasText: /English|Inglés/i }).first()
      if (await enRow.count()) { await enRow.click(); await page.waitForTimeout(400) }
      const labelEn = (await lang.innerText().catch(() => '')).trim()
      check(
        '[regression i18n] cambiar a EN re-renderiza el label del menú',
        /^Language$/i.test(labelEn) && labelEn !== labelEs,
        `ES=${JSON.stringify(labelEs)} → EN=${JSON.stringify(labelEn)}`,
      )
      // Revert to ES so the rest of the session sees the same defaults.
      await lang.click(); await page.waitForTimeout(300)
      const esRow = page.locator('[data-test=webmenu-pop-language] .webmenu-item', { hasText: /Español|Spanish/i }).first()
      if (await esRow.count()) { await esRow.click(); await page.waitForTimeout(400) }
      const labelEs2 = (await lang.innerText().catch(() => '')).trim()
      check(
        '[regression i18n] volver a ES restaura el label localizado',
        /^Idioma$/i.test(labelEs2) && labelEs2 === labelEs,
        `${JSON.stringify(labelEs2)} ?= ${JSON.stringify(labelEs)}`,
      )
    } else {
      check('[regression i18n] WebMenu trigger de idioma encontrado', false)
    }
  } catch (e) { check('[regression i18n] locale toggle', false, e.message) }

  // [#16b] toggle a Preview al final (cambia el modo de forma destructiva)
  try {
    // Cerrar cualquier modal propio que haya quedado abierto (su backdrop
    // interceptaría el clic en Preview).
    const lingering = page.locator('[data-test=dialog-confirm], [data-test=dialog-ok]').first();
    if (await lingering.count().catch(() => 0)) { await lingering.click().catch(() => {}); await page.waitForTimeout(400); }
    // Preview button = the second `.mode-btn` inside `.mode-toggle` (locale-agnostic).
    // Falls back to the text-based locator for safety on either locale.
    const pv = page.locator('.mode-toggle .mode-btn').nth(1);
    if (await pv.count()) {
      await pv.click(); await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(SHOTS, 'editor-05-preview.png'), fullPage: true });
      check('[#16] clic en Preview no rompe (canvas con elementos)',
        await page.evaluate(() => !!document.querySelector('[data-parallax-id]')));
    }
  } catch (e) { check('[#16] preview toggle', false, e.message); }
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  if (!CHROME) { console.error('No encontré Chrome/Chromium. Define CHROME_BIN.'); process.exit(2); }
  if (SUITE === 'engine') {
    console.error('La suite "engine" (render contra sitios vivos) se retiró. El render del engine se prueba offline con: yarn test:e2e:matrix');
    process.exit(2);
  }
  log(`Chrome: ${CHROME}`);
  log(`Target: editor=${CFG.editor} headless=${CFG.headless} suite=${SUITE}`);

  const sandboxWs = setupSandbox();
  log(`Sandbox: ${SANDBOX_DIR} (workspace "${WS}", useGit:false)`);

  const b = await chromium.launch({ executablePath: CHROME, headless: CFG.headless });
  const ctx = await b.newContext({ viewport: { width: CFG.vw, height: CFG.vh } });
  const page = await ctx.newPage();
  page.on('pageerror', e => log(`[pageerror] ${e.message}`));
  page.on('dialog', d => d.accept().catch(() => {})); // confirmaciones (ej. separar vistas)

  // Sembrar el workspace sandbox en el localStorage del editor ANTES de cargar
  // la app (en cada navegación, idempotente) y activarlo en el host para que las
  // rutas :ws resuelvan al directorio temporal.
  await page.addInitScript((ws) => {
    try {
      localStorage.setItem('parallax-editor:workspaces', JSON.stringify([ws]));
      localStorage.setItem('parallax-editor:active-workspace', ws.id);
      localStorage.setItem('parallax-editor:seed-version', '3');
      // Saltar la pantalla "doctor" de primer arranque (su backdrop intercepta
      // los clics y haría timeout toda la suite).
      localStorage.setItem('parallax-editor:onboarded', '1');
      // Pin the locale to ES so the existing tests (which match literal Spanish
      // strings like "+ Elemento" / "Animaciones (N)" / "Formulario") are
      // deterministic regardless of the navigator.language or whatever the
      // tester's local browser profile happens to have. The new i18n
      // regression tests further down toggle locale explicitly and revert.
      localStorage.setItem('parallax-editor:locale', 'es');
    } catch {}
  }, sandboxWs);
  try {
    const act = await page.request.post(`${CFG.editor}/api/workspace/activate`, { data: sandboxWs });
    log(`activate sandbox → ${act.status()}`);
  } catch (e) {
    check('activar workspace sandbox en el host', false, e.message);
  }

  try {
    await runEditor(page);
  } finally {
    await b.close();
    teardownSandbox();
  }

  const summary = `\n==== RESUMEN: ${failures === 0 ? 'TODO PASS ✅' : failures + ' FAIL ❌'} ====`;
  log(summary);
  fs.writeFileSync(path.join(SHOTS, 'report.txt'), lines.join('\n'));
  log(`screenshots+reporte: ${SHOTS}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { teardownSandbox(); console.error('HARNESS FAIL:', e.stack); process.exit(2); });
