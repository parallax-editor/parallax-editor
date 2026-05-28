/**
 * engine-matrix — isolated, offline render-matrix suite for parallax-engine.
 *
 * UNLIKE harness.cjs (which drives the user's live dev servers on
 * :3000/:3001/:3002 against the 2 real sites), this suite is fully
 * self-contained:
 *
 *   - starts the e2e repo's OWN tiny static server (enginematrix/server.cjs)
 *     on an unused high port (41789, fail-loud if taken),
 *   - serves the engine's BUILT dist/ + the engine's own node_modules Vue/lenis
 *     (offline, via the page's import map — single Vue instance),
 *   - mounts the REAL <ParallaxSite> against crafted site.json FIXTURES that
 *     isolate/combine the full schema-v1.1 feature matrix,
 *   - asserts measured geometry / transforms / animation / responsive / a11y
 *     against values DERIVED from the engine's documented semantics.
 *
 * No content repo is touched; no user dev server is needed; nothing on
 * :300x is contacted. The engine's `yarn dev` watch must have produced
 * ../../parallax-engine/dist/ (index.js, schema.js, style.css) — this suite
 * consumes that built dist and fails loudly if it is missing.
 *
 * Usage (from e2e/):  node suites/engine-matrix.cjs
 *                      yarn test:matrix
 *                      HEADLESS=0 node suites/engine-matrix.cjs   # headed
 *
 * Output: ./shots/matrix-<timestamp>/{*.png,report.txt}
 * Exit 0 = all PASS, 1 = some FAIL, 2 = harness/setup error.
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')
const matrixServer = require(path.join(__dirname, '..', 'enginematrix', 'server.cjs'))

// ─── Config ────────────────────────────────────────────────────────────────
const HEADLESS = process.env.HEADLESS !== '0'
const VW = 1280
const VH = 800
const MOBILE_VW = 390
const MOBILE_VH = 780

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/homebrew/bin/chromium',
  '/usr/bin/chromium',
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find((p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
})

// e2e/ vive dentro de parallax-editor; parallax-engine es su hermano → 3 niveles
// arriba desde e2e/suites/ (suites → e2e → parallax-editor → workspace).
// Resolve the engine's dist/: prefer a sibling-cloned `parallax-engine`
// (the dev workflow with yarn link), fall back to the npm-installed
// package under node_modules (CI / fresh clones).
const ENGINE_DIST = (function () {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'parallax-engine', 'dist'),
    path.resolve(__dirname, '..', '..', 'node_modules', '@parallax-editor', 'parallax-engine', 'dist'),
    path.resolve(__dirname, '..', 'node_modules', '@parallax-editor', 'parallax-engine', 'dist'),
  ]
  for (const p of candidates) {
    try { if (require('fs').existsSync(path.join(p, 'index.js'))) return p } catch {}
  }
  return candidates[0]
})()

// ─── Report ────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const SHOTS = path.join(__dirname, '..', 'shots', `matrix-${stamp}`)
fs.mkdirSync(SHOTS, { recursive: true })
const lines = []
let failures = 0
let checksRun = 0
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s) }
const check = (label, ok, detail = '') => {
  checksRun++
  if (!ok) failures++
  log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  return ok
}
// Per-area tallies for the RESUMEN.
const area = {}
function startArea(name) {
  area[name] = { fail0: failures, run0: checksRun }
  log(`\n=== ${name} ===`)
}
function endArea(name) {
  const a = area[name]
  if (!a) return
  a.failed = failures - a.fail0
  a.ran = checksRun - a.run0
}

// ─── Browser helpers ───────────────────────────────────────────────────────
let browser, ctx, page
const pageErrors = []

async function newPage(viewport) {
  if (page) await page.close().catch(() => {})
  if (ctx) await ctx.close().catch(() => {})
  ctx = await browser.newContext({ viewport })
  page = await ctx.newPage()
  page.on('pageerror', (e) => {
    pageErrors.push(String(e.message))
    log(`  [pageerror] ${e.message}`)
  })
  page.on('dialog', (d) => d.accept().catch(() => {}))
}

function clearErrors() { pageErrors.length = 0 }

async function open(origin, query, { reduced = false } = {}) {
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
  else await page.emulateMedia({ reducedMotion: 'no-preference' })
  clearErrors()
  await page.goto(`${origin}/?${query}`, { waitUntil: 'load', timeout: 20000 })
  await page.waitForFunction(
    () => window.__matrixReady === true || typeof window.__matrixError === 'string',
    { timeout: 15000 },
  )
  return page.evaluate(() => ({
    ready: window.__matrixReady === true,
    error: typeof window.__matrixError === 'string' ? window.__matrixError : null,
    info: window.__matrixInfo || null,
  }))
}

// Geometry of every [data-parallax-id] as % of its OWN section box, plus the
// extra hosts (audio/video) which carry no data-parallax-id.
async function geometry() {
  return page.evaluate(() => {
    function sectionOf(el) {
      return el.closest('section.parallax-section, .parallax-section') ||
             document.querySelector('.parallax-section')
    }
    const out = {}
    for (const el of document.querySelectorAll('[data-parallax-id]')) {
      const b = el.getBoundingClientRect()
      const s = sectionOf(el)
      const sb = s ? s.getBoundingClientRect() : null
      const id = el.getAttribute('data-parallax-id')
      out[id] = sb ? {
        cx: +(((b.x + b.width / 2 - sb.x) / sb.width) * 100).toFixed(2),
        cy: +(((b.y + b.height / 2 - sb.y) / sb.height) * 100).toFixed(2),
        L: +(((b.x - sb.x) / sb.width) * 100).toFixed(2),
        T: +(((b.y - sb.y) / sb.height) * 100).toFixed(2),
        R: +(((b.right - sb.x) / sb.width) * 100).toFixed(2),
        B: +(((b.bottom - sb.y) / sb.height) * 100).toFixed(2),
        w: Math.round(b.width), h: Math.round(b.height),
        secW: Math.round(sb.width), secH: Math.round(sb.height),
        opacity: parseFloat(getComputedStyle(el).opacity),
        transform: getComputedStyle(el).transform,
        visible: b.width > 0 && b.height > 0,
      } : null
    }
    return out
  })
}

async function shot(name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {})
}

// Approx equality on a % coordinate. tol in percentage points.
function near(actual, expected, tol, label, extra = '') {
  return check(
    `${label} ≈ ${expected}%`,
    actual != null && Math.abs(actual - expected) <= tol,
    `got ${actual}%${extra ? ' ' + extra : ''} (tol ±${tol})`,
  )
}

// ─── Suites ────────────────────────────────────────────────────────────────

async function suiteAnchors(O) {
  startArea('ANCHORS — point lands at position{x,y}% (no size & with size)')

  // --- anchors-all: shrink-to-fit text, each anchor's NAMED point at pos ---
  let r = await open(O, 'fixture=anchors-all')
  check('anchors-all monta sin error', r.ready && !r.error, r.error || '')
  await shot('anchors-all')
  let g = await geometry()
  // center → element center at (x,y); top-left → element L/T at (x,y); etc.
  near(g['a-center'] && g['a-center'].cx, 50, 1.5, 'a-center cx')
  near(g['a-center'] && g['a-center'].cy, 50, 2, 'a-center cy')
  near(g['a-top-left'] && g['a-top-left'].L, 10, 1.5, 'a-top-left left@')
  near(g['a-top-left'] && g['a-top-left'].T, 10, 2, 'a-top-left top@')
  near(g['a-top-right'] && g['a-top-right'].R, 90, 1.5, 'a-top-right right@')
  near(g['a-top-right'] && g['a-top-right'].T, 10, 2, 'a-top-right top@')
  near(g['a-bottom-left'] && g['a-bottom-left'].L, 10, 1.5, 'a-bottom-left left@')
  near(g['a-bottom-left'] && g['a-bottom-left'].B, 90, 2, 'a-bottom-left bottom@')
  near(g['a-bottom-right'] && g['a-bottom-right'].R, 90, 1.5, 'a-bottom-right right@')
  near(g['a-bottom-right'] && g['a-bottom-right'].B, 90, 2, 'a-bottom-right bottom@')
  near(g['a-top'] && g['a-top'].cx, 50, 1.5, 'a-top cx')
  near(g['a-top'] && g['a-top'].T, 15, 2, 'a-top top@')
  near(g['a-bottom'] && g['a-bottom'].cx, 50, 1.5, 'a-bottom cx')
  near(g['a-bottom'] && g['a-bottom'].B, 85, 2, 'a-bottom bottom@')
  near(g['a-left'] && g['a-left'].L, 15, 1.5, 'a-left left@')
  near(g['a-left'] && g['a-left'].cy, 50, 2, 'a-left cy')
  near(g['a-right'] && g['a-right'].R, 85, 1.5, 'a-right right@')
  near(g['a-right'] && g['a-right'].cy, 50, 2, 'a-right cy')

  // --- anchors-sized: explicit size in %, px, clamp()/min() ---
  r = await open(O, 'fixture=anchors-sized')
  check('anchors-sized monta sin error', r.ready && !r.error, r.error || '')
  await shot('anchors-sized')
  g = await geometry()
  // Anchor point still lands at pos regardless of explicit size.
  near(g['s-center'] && g['s-center'].cx, 50, 1, 's-center cx (px size)')
  near(g['s-center'] && g['s-center'].cy, 50, 1.5, 's-center cy (px size)')
  near(g['s-top-left'] && g['s-top-left'].L, 8, 1, 's-top-left left@ (% width)')
  near(g['s-top-left'] && g['s-top-left'].T, 8, 1.5, 's-top-left top@')
  near(g['s-top-right'] && g['s-top-right'].R, 92, 1, 's-top-right right@ (% height)')
  near(g['s-bottom-left'] && g['s-bottom-left'].L, 8, 1, 's-bottom-left left@ (clamp width)')
  near(g['s-bottom-left'] && g['s-bottom-left'].B, 92, 1.5, 's-bottom-left bottom@')
  near(g['s-bottom-right'] && g['s-bottom-right'].R, 92, 1, 's-bottom-right right@ (min() width)')
  near(g['s-bottom-right'] && g['s-bottom-right'].B, 92, 1.5, 's-bottom-right bottom@')
  // explicit px size honored: 60px box on a 1280×800 section ≈ 4.69% × 7.5%
  const sc = g['s-center']
  check('s-center honra size 60px', sc && Math.abs(sc.w - 60) <= 2 && Math.abs(sc.h - 60) <= 2,
    sc ? `w=${sc.w} h=${sc.h}` : 'missing')
  // % width honored: 10% of 1280 = 128px
  const stl = g['s-top-left']
  check('s-top-left honra width 10%', stl && Math.abs(stl.w - 128) <= 4, stl ? `w=${stl.w}` : 'missing')
  // clamp(50px,8vw,120px) at 1280px → 8vw=102.4px → 102px
  const sbl = g['s-bottom-left']
  check('s-bottom-left honra clamp() width', sbl && Math.abs(sbl.w - 102) <= 4, sbl ? `w=${sbl.w}` : 'missing')
  // min(120px,15%) at 1280 → 15%=192 vs 120 → 120px
  const sbr = g['s-bottom-right']
  check('s-bottom-right honra min() width', sbr && Math.abs(sbr.w - 120) <= 4, sbr ? `w=${sbr.w}` : 'missing')
  check('anchors: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))

  // --- png-fullbleed: a png intended as a FULL-BLEED layer background ---
  // (regression #87): position{0,0} size{100%,100%} anchor top-left MUST
  // cover its layer/section box (dx/dy≈0, w/h≈section box) with NO distortion
  // (object-fit:cover) and the crop following the anchor (object-position).
  // wide.png is 200×100 (2:1) so cover (no distortion) is measurably distinct
  // from the previous fill-stretch / intrinsic-letterbox behavior. This is the
  // SAME engine the real eventos/site render, so a green check here means a
  // hard refresh of the real site (after the dev watch rebuilds dist/) shows
  // the background correctly too.
  r = await open(O, 'fixture=png-fullbleed')
  check('png-fullbleed monta sin error', r.ready && !r.error, r.error || '')
  await shot('png-fullbleed')
  g = await geometry()
  const fit = await page.evaluate(() => {
    const out = {}
    for (const id of ['fb-bg', 'fb-corner']) {
      const e = document.querySelector(`[data-parallax-id="${id}"]`)
      if (!e) { out[id] = null; continue }
      const cs = getComputedStyle(e)
      out[id] = { objectFit: cs.objectFit, objectPosition: cs.objectPosition }
    }
    return out
  })
  const fb = g['fb-bg']
  // The full-bleed png box IS the layer/section box: top-left at (0,0)% and
  // exactly the section's pixel dimensions (the layer is absolute; inset:0).
  near(fb && fb.L, 0, 1, 'fb-bg left@ (cubre desde la esquina)')
  near(fb && fb.T, 0, 1, 'fb-bg top@ (cubre desde la esquina)')
  near(fb && fb.R, 100, 1, 'fb-bg right@ (cubre hasta el borde)')
  near(fb && fb.B, 100, 1, 'fb-bg bottom@ (cubre hasta el borde)')
  check('png-fullbleed: la caja del png == caja de su capa/sección (cubre, dx/dy≈0)',
    fb && Math.abs(fb.w - fb.secW) <= 2 && Math.abs(fb.h - fb.secH) <= 2,
    fb ? `png ${fb.w}x${fb.h} vs sección ${fb.secW}x${fb.secH}` : 'missing')
  check('png-fullbleed: object-fit:cover (foto llena la caja SIN distorsión, no fill/letterbox)',
    fit['fb-bg'] && fit['fb-bg'].objectFit === 'cover',
    fit['fb-bg'] ? `object-fit=${fit['fb-bg'].objectFit}` : 'missing')
  check('png-fullbleed: object-position sigue al anchor top-left (recorte 0% 0%)',
    fit['fb-bg'] && /^(0%|left)\s+(0%|top)$/.test(fit['fb-bg'].objectPosition),
    fit['fb-bg'] ? `object-position=${fit['fb-bg'].objectPosition}` : 'missing')
  // A SIZED png with a non-center anchor still positions correctly AND the
  // cover crop follows that anchor (no anchor regression with explicit size).
  const fc = g['fb-corner']
  near(fc && fc.R, 92, 1.5, 'fb-corner right@ (anchor bottom-right intacto)')
  near(fc && fc.B, 92, 1.5, 'fb-corner bottom@ (anchor bottom-right intacto)')
  check('png-fullbleed: png con size honra 160px (cover no rompe el box)',
    fc && Math.abs(fc.w - 160) <= 3 && Math.abs(fc.h - 160) <= 3,
    fc ? `w=${fc.w} h=${fc.h}` : 'missing')
  check('png-fullbleed: object-fit:cover también en png con size + anchor no-centro',
    fit['fb-corner'] && fit['fb-corner'].objectFit === 'cover',
    fit['fb-corner'] ? `object-fit=${fit['fb-corner'].objectFit}` : 'missing')
  check('png-fullbleed: object-position sigue bottom-right (recorte 100% 100%)',
    fit['fb-corner'] && /^(100%|right)\s+(100%|bottom)$/.test(fit['fb-corner'].objectPosition),
    fit['fb-corner'] ? `object-position=${fit['fb-corner'].objectPosition}` : 'missing')
  check('png-fullbleed: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('ANCHORS — point lands at position{x,y}% (no size & with size)')
}

async function suiteScroll(O) {
  startArea('SCROLL BEHAVIOR — continuous / pinned / snap / horizontal-dir')

  // continuous: each section is its own configured height.
  let r = await open(O, 'fixture=scroll-continuous')
  check('scroll-continuous monta', r.ready && !r.error, r.error || '')
  let m = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.parallax-section')]
    return secs.map((s) => Math.round(s.getBoundingClientRect().height))
  })
  check('continuous: 2 secciones', m.length === 2, JSON.stringify(m))
  check('continuous: sec1 ≈ 100vh', Math.abs(m[0] - VH) < VH * 0.05, `h=${m[0]} (vh=${VH})`)
  check('continuous: sec2 ≈ 120vh', Math.abs(m[1] - VH * 1.2) < VH * 0.06, `h=${m[1]} (≈${VH * 1.2})`)
  await shot('scroll-continuous')

  // pinned: outer wrapper height = section.height (250vh = 2000px); inner
  // sticky .parallax-section = 100vh. The element stays viewport-locked while
  // scrolling within the pin range.
  r = await open(O, 'fixture=scroll-pinned')
  check('scroll-pinned monta', r.ready && !r.error, r.error || '')
  const pin = await page.evaluate((vh) => {
    const inner = document.querySelector('#pin-1, .parallax-section')
    const outer = inner ? inner.parentElement : null
    return {
      innerH: inner ? Math.round(inner.getBoundingClientRect().height) : null,
      outerH: outer ? Math.round(outer.getBoundingClientRect().height) : null,
      sticky: inner ? getComputedStyle(inner).position : null,
      docScrollable: document.documentElement.scrollHeight > vh + 50,
      scrollH: document.documentElement.scrollHeight,
    }
  }, VH)
  check('pinned: .parallax-section es sticky', pin.sticky === 'sticky', `position=${pin.sticky}`)
  check('pinned: sticky inner ≈ 100vh', pin.innerH != null && Math.abs(pin.innerH - VH) < VH * 0.05, `innerH=${pin.innerH}`)
  check('pinned: outer wrapper ≈ 250vh', pin.outerH != null && Math.abs(pin.outerH - VH * 2.5) < VH * 0.1, `outerH=${pin.outerH}`)
  check('pinned: doc scrolleable (pin range + section after)', pin.docScrollable, `scrollH=${pin.scrollH}`)
  // Structural pin contract the engine guarantees IN ISOLATION:
  //   outer wrapper height = section.height (the scroll travel = the pin),
  //   inner is position:sticky; top:0; height:100vh.
  // We assert the contract structurally (above) rather than runtime
  // sticky-hold: whether sticky visually engages depends on which element
  // owns the scroll, and the engine's own `.parallax-site{overflow-x:hidden}`
  // (computes `overflow:hidden auto` in Chrome) makes `.parallax-site` a
  // scroll container while the document is what scrolls — so a bare-page mount
  // cannot exhibit viewport-locking. The real consumers drive scroll through
  // Lenis on the document with the site as a normal-flow child, where the
  // sticky engages. Asserting the contract keeps this suite a deterministic
  // regression of the ENGINE's structure, not of the host scroll wiring.
  const stickyTop = await page.evaluate(() => {
    const inner = document.querySelector('#pin-1, .parallax-section')
    return inner ? getComputedStyle(inner).top : null
  })
  check('pinned: sticky inner fija top:0 (contrato de anclaje)',
    stickyTop === '0px', `top=${stickyTop}`)
  // The section AFTER the pin must follow it in normal flow (not overlap):
  // its document-space top ≈ the pin's outer wrapper height.
  const flow = await page.evaluate(() => {
    const after = document.querySelector('#pin-after')
    const outer = document.querySelector('#pin-1, .parallax-section')
    const ow = outer ? (outer.parentElement || outer) : null
    return {
      afterTop: after ? Math.round(after.getBoundingClientRect().top + window.scrollY) : null,
      pinTravel: ow ? Math.round(ow.getBoundingClientRect().height) : null,
    }
  })
  check('pinned: la sección posterior fluye DESPUÉS del rango de pin (sin solape)',
    flow.afterTop != null && flow.pinTravel != null &&
      Math.abs(flow.afterTop - flow.pinTravel) < VH * 0.1,
    `afterTop=${flow.afterTop} pinTravel=${flow.pinTravel}`)
  await shot('scroll-pinned')

  // snap: scroll-snap-align:start on each section + parent scroll-snap-type
  // (only when a snap section exists — driven via theme/hasSnap, but here no
  // theme; the engine sets scrollSnapType only with theme. We still assert the
  // per-section scrollSnapAlign which is unconditional).
  r = await open(O, 'fixture=scroll-snap')
  check('scroll-snap monta', r.ready && !r.error, r.error || '')
  const snap = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.parallax-section')]
    return {
      n: secs.length,
      aligns: secs.map((s) => getComputedStyle(s).scrollSnapAlign),
      heights: secs.map((s) => Math.round(s.getBoundingClientRect().height)),
    }
  })
  check('snap: 2 secciones', snap.n === 2, JSON.stringify(snap.heights))
  check('snap: scroll-snap-align:start en cada sección',
    snap.aligns.every((a) => a === 'start'), JSON.stringify(snap.aligns))
  check('snap: cada sección ≈ 100vh',
    snap.heights.every((h) => Math.abs(h - VH) < VH * 0.05), JSON.stringify(snap.heights))
  await shot('scroll-snap')

  // horizontal scrollDirection: flex .horizontal-track with translateX driven
  // by sectionProgress; both panels present and full-viewport-width cells.
  r = await open(O, 'fixture=scroll-horizontal-dir')
  check('scroll-horizontal-dir monta', r.ready && !r.error, r.error || '')
  const hor = await page.evaluate(() => {
    const track = document.querySelector('.horizontal-track')
    return {
      hasTrack: !!track,
      display: track ? getComputedStyle(track).display : null,
      panels: [...document.querySelectorAll('[data-parallax-id]')].map((e) => e.getAttribute('data-parallax-id')),
    }
  })
  check('horizontal-dir: .horizontal-track flex existe',
    hor.hasTrack && hor.display === 'flex', `display=${hor.display}`)
  check('horizontal-dir: ambos paneles presentes',
    hor.panels.includes('hd-panel-1') && hor.panels.includes('hd-panel-2'), JSON.stringify(hor.panels))
  await shot('scroll-horizontal-dir')
  check('scroll: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('SCROLL BEHAVIOR — continuous / pinned / snap / horizontal-dir')
}

async function suiteParallaxModes(O) {
  startArea('PARALLAX MODES — scroll-v/h, mouse, gyroscope, tilt(perspective3d)')

  let r = await open(O, 'fixture=parallax-modes')
  check('parallax-modes monta', r.ready && !r.error, r.error || '')
  await shot('parallax-modes-top')

  // perspective3d wrapper: layer wrapper gets perspective + preserve-3d.
  const persp = await page.evaluate(() => {
    const el = document.querySelector('[data-parallax-id="pm-tilt-el"]')
    // walk up to the wrapper that carries `perspective`
    let n = el, found = null
    while (n && n !== document.body) {
      const cs = getComputedStyle(n)
      if (cs.perspective && cs.perspective !== 'none') { found = cs.perspective; break }
      n = n.parentElement
    }
    return found
  })
  check('tilt: layer perspective3d aplica perspective al wrapper',
    persp && persp !== 'none', `perspective=${persp}`)

  // Static layer (depth 0, no parallaxMode) must NOT transform on scroll.
  // scroll-vertical layer (depth .8) MUST change transform as we scroll.
  const tf = (id) => page.evaluate(
    (i) => {
      const e = document.querySelector(`[data-parallax-id="${i}"]`)
      if (!e) return null
      const layer = e.closest('.parallax-layer')
      return layer ? getComputedStyle(layer).transform : null
    }, id)

  const svBefore = await tf('pm-sv-el')
  const shBefore = await tf('pm-sh-el')
  const stBefore = await tf('pm-static-el')
  // Scroll into the pm-main section so sectionProgress advances.
  await page.evaluate(() => window.scrollTo(0, Math.round(window.innerHeight * 1.2)))
  await page.waitForTimeout(700)
  const svAfter = await tf('pm-sv-el')
  const shAfter = await tf('pm-sh-el')
  const stAfter = await tf('pm-static-el')
  await shot('parallax-modes-scrolled')
  check('scroll-vertical: layer transform cambia al scrollear',
    svBefore !== svAfter && svAfter && svAfter !== 'none', `${svBefore} -> ${svAfter}`)
  check('scroll-horizontal: layer transform cambia al scrollear',
    shBefore !== shAfter && shAfter && shAfter !== 'none', `${shBefore} -> ${shAfter}`)
  check('static layer (depth 0, sin parallaxMode): NO transform por scroll',
    stBefore === stAfter && (stAfter === 'none' || stAfter == null), `${stBefore} -> ${stAfter}`)

  // mouse parallax: moving the mouse changes the mouse layer transform.
  await open(O, 'fixture=parallax-modes')
  const mBefore = await tf('pm-mouse-el')
  await page.mouse.move(VW * 0.1, VH * 0.5)
  await page.waitForTimeout(120)
  await page.mouse.move(VW * 0.9, VH * 0.5)
  await page.waitForTimeout(250)
  const mAfter = await tf('pm-mouse-el')
  check('mouse: layer transform responde al movimiento del ratón',
    mBefore !== mAfter && mAfter && mAfter !== 'none', `${mBefore} -> ${mAfter}`)

  // gyroscope (separate fixture): simulate a deviceorientation event; the
  // gyroscope layer must become non-identity (available flips true on event).
  r = await open(O, 'fixture=parallax-gyroscope')
  check('parallax-gyroscope monta', r.ready && !r.error, r.error || '')
  const gBefore = await tf('gyro-el')
  await page.evaluate(() => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
      alpha: 0, beta: 30, gamma: 35, absolute: true,
    }))
  })
  await page.waitForTimeout(300)
  const gAfter = await tf('gyro-el')
  check('gyroscope: deviceorientation activa el parallax del layer',
    gAfter && gAfter !== 'none' && gAfter !== gBefore, `${gBefore} -> ${gAfter}`)
  await shot('parallax-gyroscope')
  check('parallax-modes: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('PARALLAX MODES — scroll-v/h, mouse, gyroscope, tilt(perspective3d)')
}

async function suiteElementTypes(O) {
  startArea('ELEMENT TYPES — png / text / component(FormBlock) / audio / video')

  const r = await open(O, 'fixture=element-types')
  check('element-types monta', r.ready && !r.error, r.error || '')
  await shot('element-types')
  const dom = await page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const png = q('.parallax-png-element')
    const txt = q('.parallax-text-element')
    const comp = q('.parallax-component-element')
    const form = q('.parallax-form')
    const audio = q('.parallax-audio-element audio')
    const video = q('.parallax-video-element video')
    const rect = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) } }
    return {
      png: !!png, pngSrc: png ? png.getAttribute('src') : null, pngBox: rect(png),
      txt: !!txt, txtText: txt ? txt.textContent.trim() : null,
      comp: !!comp, compId: comp ? comp.getAttribute('data-parallax-id') : null,
      form: !!form,
      formInputs: document.querySelectorAll('.parallax-form input, .parallax-form select').length,
      formButton: !!q('.parallax-form .form-submit'),
      audio: !!audio, video: !!video,
      audioHost: !!q('.parallax-audio-element'), videoHost: !!q('.parallax-video-element'),
    }
  })
  check('png: <img.parallax-png-element> con src', dom.png && /dot\.png/.test(dom.pngSrc || ''), dom.pngSrc || '')
  check('png: dimensiones del size aplicadas (~60px)',
    dom.pngBox && Math.abs(dom.pngBox.w - 60) <= 3 && Math.abs(dom.pngBox.h - 60) <= 3, JSON.stringify(dom.pngBox))
  check('text: .parallax-text-element con contenido', dom.txt && dom.txtText === 'Texto de prueba', dom.txtText || '')
  check('component: .parallax-component-element[data-parallax-id]', dom.comp && dom.compId === 'et-form', dom.compId || '')
  check('component: FormBlock built-in renderiza (<form.parallax-form>)', dom.form, '')
  check('component: FormBlock pinta los 3 campos + botón',
    dom.formInputs >= 3 && dom.formButton, `inputs=${dom.formInputs} btn=${dom.formButton}`)
  check('audio: host .parallax-audio-element + <audio>', dom.audioHost && dom.audio, '')
  check('video: host .parallax-video-element + <video>', dom.videoHost && dom.video, '')
  check('element-types: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('ELEMENT TYPES — png / text / component(FormBlock) / audio / video')
}

async function suiteAnimations(O) {
  startArea('ANIMATIONS — enter / loop+yoyo / scroll(range) / hover / click / depends / mouse / gyro')

  // enter fadeIn ends visible; loop transform changes over time.
  let r = await open(O, 'fixture=anim-enter-loop')
  check('anim-enter-loop monta', r.ready && !r.error, r.error || '')
  await page.waitForTimeout(900) // let the 500ms enter fade complete
  let g = await geometry()
  check('enter fadeIn: elemento queda visible (opacity > 0.85)',
    g['el-enter'] && g['el-enter'].opacity > 0.85, g['el-enter'] ? `opacity=${g['el-enter'].opacity}` : 'missing')
  const loop0 = g['el-loop'] && g['el-loop'].transform
  await page.waitForTimeout(700)
  const loop1 = await page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="el-loop"]')
    return e ? getComputedStyle(e).transform : null
  })
  check('loop+yoyo: transform cambia en el tiempo (animación corre)',
    loop0 && loop1 && loop0 !== loop1, `${loop0} -> ${loop1}`)
  check('loop: elemento sigue visible (no clipado)',
    g['el-loop'] && g['el-loop'].visible, '')
  await shot('anim-enter-loop')

  // scroll(range): translateX interpolates from -200 to 200 across range
  // [0.2,0.8] of section progress. Sample at low vs high progress.
  r = await open(O, 'fixture=anim-scroll-range')
  check('anim-scroll-range monta', r.ready && !r.error, r.error || '')
  const sx = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="el-scroll"]')
    if (!e) return null
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform)
    return Math.round(m.m41) // translateX in px
  })
  // scroll so the el-scroll section is near the bottom of viewport (low prog)
  await page.evaluate(() => window.scrollTo(0, Math.round(window.innerHeight * 0.6)))
  await page.waitForTimeout(500)
  const xLow = await sx()
  // scroll further so the section is high in the viewport (high progress)
  await page.evaluate(() => window.scrollTo(0, Math.round(window.innerHeight * 1.8)))
  await page.waitForTimeout(500)
  const xHigh = await sx()
  await shot('anim-scroll-range')
  check('scroll(range): translateX interpola con el progreso (cambia y avanza)',
    xLow != null && xHigh != null && xHigh > xLow && Math.abs(xHigh - xLow) > 30,
    `x ${xLow} -> ${xHigh}`)
  check('scroll(range): elemento visible durante la animación',
    await page.evaluate(() => {
      const e = document.querySelector('[data-parallax-id="el-scroll"]')
      const b = e && e.getBoundingClientRect()
      return !!(b && b.width > 0 && b.height > 0)
    }), '')

  // hover: scale 1 -> 1.5 on mouseenter. click: rotate 0 -> 45 on click.
  r = await open(O, 'fixture=anim-hover-click')
  check('anim-hover-click monta', r.ready && !r.error, r.error || '')
  const scaleOf = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="el-hover"]')
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform)
    return +Math.hypot(m.a, m.b).toFixed(3) // scale magnitude
  })
  const hScale0 = await scaleOf()
  await page.hover('[data-parallax-id="el-hover"]')
  await page.waitForTimeout(400)
  const hScale1 = await scaleOf()
  check('hover: scale crece al pasar el ratón (≈1 -> ≈1.5)',
    hScale1 > hScale0 + 0.2, `scale ${hScale0} -> ${hScale1}`)
  const rotOf = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="el-click"]')
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform)
    return +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(1)
  })
  const cRot0 = await rotOf()
  await page.click('[data-parallax-id="el-click"]')
  await page.waitForTimeout(400)
  const cRot1 = await rotOf()
  check('click: rotate cambia al hacer click (≈0 -> ≈45°)',
    Math.abs(cRot1 - cRot0) > 20, `rot ${cRot0}° -> ${cRot1}°`)
  await shot('anim-hover-click')

  // depends: hovering dep-source raises dep-target opacity (0.15 -> 1).
  r = await open(O, 'fixture=anim-depends')
  check('anim-depends monta', r.ready && !r.error, r.error || '')
  const tgtOpacity = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="dep-target"]')
    return e ? parseFloat(getComputedStyle(e).opacity) : null
  })
  const dOp0 = await tgtOpacity()
  await page.hover('[data-parallax-id="dep-source"]')
  await page.waitForTimeout(450)
  const dOp1 = await tgtOpacity()
  await page.mouse.move(VW / 2, 10)
  await page.waitForTimeout(450)
  const dOp2 = await tgtOpacity()
  check('depends: target oculto/atenuado antes (opacity ≈ 0.15)',
    dOp0 != null && dOp0 < 0.4, `opacity=${dOp0}`)
  check('depends: hover en source revela el target (opacity -> ~1)',
    dOp1 != null && dOp1 > 0.85, `opacity=${dOp1}`)
  check('depends: al salir del source el target vuelve a atenuarse',
    dOp2 != null && dOp2 < 0.4, `opacity=${dOp2}`)
  await shot('anim-depends')

  // mouse / gyroscope animation triggers.
  r = await open(O, 'fixture=anim-mouse-gyro')
  check('anim-mouse-gyro monta', r.ready && !r.error, r.error || '')
  const mtx = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="el-mouse-anim"]')
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform)
    return Math.round(m.m41)
  })
  await page.mouse.move(VW * 0.05, VH * 0.5)
  await page.waitForTimeout(150)
  const mLeft = await mtx()
  await page.mouse.move(VW * 0.95, VH * 0.5)
  await page.waitForTimeout(250)
  const mRight = await mtx()
  // from -120 (mouseX=-1) to 120 (mouseX=1); left side ≈ negative, right ≈ positive
  check('mouse trigger: translateX sigue al ratón (izq negativo -> der positivo)',
    mLeft != null && mRight != null && mRight > mLeft + 60, `x ${mLeft} -> ${mRight}`)
  const gty = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="el-gyro-anim"]')
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform)
    return Math.round(m.m42)
  })
  const gy0 = await gty()
  await page.evaluate(() => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 40 }))
  })
  await page.waitForTimeout(300)
  const gy1 = await gty()
  check('gyroscope trigger: translateY responde a deviceorientation',
    gy0 != null && gy1 != null && gy0 !== gy1, `y ${gy0} -> ${gy1}`)
  await shot('anim-mouse-gyro')
  check('animations: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))

  // ── REACTIVE EDIT (editor live preview): patch an element's animations array
  // on the LIVE reactive site (no engine remount) and assert useElementAnimations
  // reacts — the exact bug: changing/adding an animation in the editor did not
  // update the preview until a manual refresh, because the composable captured
  // the animations array by reference at setup. With the reactive-getter fix,
  // the patch must take effect without a remount.
  r = await open(O, 'fixture=anim-reactive')
  check('anim-reactive monta', r.ready && !r.error, r.error || '')
  const arScale = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="ar-hover"]')
    if (!e) return null
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform)
    return +Math.hypot(m.a, m.b).toFixed(3)
  })
  // Baseline: no hover animation yet → hovering must NOT scale.
  await page.hover('[data-parallax-id="ar-hover"]')
  await page.waitForTimeout(250)
  const arScaleNoAnim = await arScale()
  check('reactive: sin animacion el hover NO escala (baseline)',
    arScaleNoAnim != null && Math.abs(arScaleNoAnim - 1) < 0.2, `scale=${arScaleNoAnim}`)
  // Patch a hover-scale onto the LIVE site (what the editor does on edit).
  const patchedHover = await page.evaluate(() =>
    window.__matrixPatchAnimations('ar-hover', [
      { type: 'scale', trigger: 'hover', from: 1, to: 1.6, duration: 150, easing: 'easeOut',
        loop: false, yoyo: false, delay: 0 },
    ]))
  check('reactive: __matrixPatchAnimations encontró el elemento', patchedHover === true, `patched=${patchedHover}`)
  // Re-hover (move out then in) so mouseenter fires with the new animation present.
  await page.mouse.move(VW / 2, 10)
  await page.waitForTimeout(60)
  await page.hover('[data-parallax-id="ar-hover"]')
  await page.waitForTimeout(350)
  const arScaleAfter = await arScale()
  check('reactive: tras parchear hover-scale, el hover SÍ escala (sin remount)',
    arScaleAfter != null && arScaleAfter > 1.25, `scale ${arScaleNoAnim} -> ${arScaleAfter}`)

  const arLoopTf = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="ar-loop"]')
    return e ? getComputedStyle(e).transform : null
  })
  const arLoopOff = await arLoopTf()
  // Patch a loop animation in → the rAF must START without a remount.
  const patchedLoop = await page.evaluate(() =>
    window.__matrixPatchAnimations('ar-loop', [
      { type: 'translateY', trigger: 'loop', from: -25, to: 25, duration: 400, easing: 'easeInOut',
        loop: true, yoyo: true, delay: 0 },
    ]))
  check('reactive: __matrixPatchAnimations encontró ar-loop', patchedLoop === true, `patched=${patchedLoop}`)
  await page.waitForTimeout(250)
  const arLoopA = await arLoopTf()
  await page.waitForTimeout(250)
  const arLoopB = await arLoopTf()
  check('reactive: añadir un loop arranca la animación (transform cambia en el tiempo, sin remount)',
    arLoopA && arLoopB && arLoopA !== arLoopB, `${arLoopA} -> ${arLoopB}`)
  // Remove the loop → the rAF must STOP (transform settles, stops changing).
  await page.evaluate(() => window.__matrixPatchAnimations('ar-loop', []))
  await page.waitForTimeout(250)
  const arStop0 = await arLoopTf()
  await page.waitForTimeout(300)
  const arStop1 = await arLoopTf()
  check('reactive: quitar el loop lo detiene (transform deja de cambiar)',
    arStop0 === arStop1, `${arStop0} === ${arStop1}? off-baseline=${arLoopOff}`)
  await shot('anim-reactive')
  check('animations(reactive): sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('ANIMATIONS — enter / loop+yoyo / scroll(range) / hover / click / depends / mouse / gyro')
}

async function suiteInteractive(O) {
  startArea('INTERACTIVE — png hover-scale gates on hover (not on load) + link navigates on click')

  // ── interactive-hover-scale ─────────────────────────────────────────────
  // A PNG with interactive:true and a single hover-trigger scale animation
  // {from:1, to:1.3}. Reported by user: "the scale runs immediately on page
  // load instead of on hover, and never reacts to hovering." Ground truth:
  // the engine computes `value = isHovered ? to : from`, so at MOUNT (before
  // any pointer) the rendered transform scale must be the identity/`from`
  // (≈1), NOT `to` (1.3). Then a real mouseenter must scale to ≈1.3, and a
  // mouseleave must return it to ≈1. This isolates the hover GATE in the real
  // prod mount — independent of any editor preview overlay.
  let r = await open(O, 'fixture=interactive-hover-scale')
  check('interactive-hover-scale monta sin error', r.ready && !r.error, r.error || '')
  await shot('interactive-hover-scale-load')
  // Scale magnitude of the png element (sqrt(a^2+b^2) of its 2D matrix).
  const hoverScale = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="ihs-png"]')
    if (!e) return null
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform)
    return +Math.hypot(m.a, m.b).toFixed(3)
  })
  // Let any (erroneous) entry transition settle before sampling the at-load state.
  await page.waitForTimeout(350)
  const sLoad = await hoverScale()
  check('hover: NO escala en carga (transform ≈ from=1, no se dispara solo)',
    sLoad != null && Math.abs(sLoad - 1) <= 0.05, `scale@load=${sLoad} (esperado ≈1, NO 1.3)`)

  // Dispatch a REAL mouseenter on the png and confirm it scales to `to`.
  await page.hover('[data-parallax-id="ihs-png"]')
  await page.waitForTimeout(350)
  const sHover = await hoverScale()
  await shot('interactive-hover-scale-hover')
  check('hover: al pasar el ratón escala a to=1.3 (el gate reacciona al hover)',
    sHover != null && Math.abs(sHover - 1.3) <= 0.08, `scale@hover=${sHover} (esperado ≈1.3)`)
  check('hover: el hover SÍ cambia el estado (load ≠ hover)',
    sLoad != null && sHover != null && sHover > sLoad + 0.15, `${sLoad} -> ${sHover}`)

  // Move the mouse away (mouseleave) → returns to `from`.
  await page.mouse.move(VW * 0.05, VH * 0.05)
  await page.waitForTimeout(350)
  const sLeave = await hoverScale()
  check('hover: al salir el ratón vuelve a from=1 (no se queda escalado)',
    sLeave != null && Math.abs(sLeave - 1) <= 0.06, `scale@leave=${sLeave} (esperado ≈1)`)
  check('interactive-hover-scale: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))

  // ── interactive-link ────────────────────────────────────────────────────
  // A PNG wrapped in a link {href, target:_blank}. Reported by user:
  // "clicking the image does NOT open the URL." Ground truth: the engine
  // renders an <a> (ElementLink) with the correct href/target/rel, the png
  // image is pointer-events:auto (interactive), and NOTHING in the engine
  // calls preventDefault on the click — the useElementAnimations click
  // listener only toggles isClicked, it does not cancel the event. So a click
  // reaching the <img> must bubble to the <a> without being canceled (the
  // browser would then navigate). We do NOT actually navigate: we attach a
  // capture-phase click listener on <a>, preventDefault inside it so the test
  // never leaves the page, and assert the event arrived NOT already canceled.
  r = await open(O, 'fixture=interactive-link')
  check('interactive-link monta sin error', r.ready && !r.error, r.error || '')
  await shot('interactive-link')
  const link = await page.evaluate(() => {
    const img = document.querySelector('[data-parallax-id="il-png"]')
    if (!img) return null
    const a = img.closest('a.parallax-element-link')
    return {
      hasAnchor: !!a,
      href: a ? a.getAttribute('href') : null,
      target: a ? a.getAttribute('target') : null,
      rel: a ? a.getAttribute('rel') : null,
      imgPointer: getComputedStyle(img).pointerEvents,
      anchorPointer: a ? getComputedStyle(a).pointerEvents : null,
      // Is the png the topmost element at its own center? (the layer's
      // pointer-events:none must NOT shadow it — confirms events reach it.)
      topmostAtCenter: (() => {
        const b = img.getBoundingClientRect()
        const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
        return top === img || (a ? a.contains(top) : false)
      })(),
    }
  })
  check('link: el png se envuelve en <a class="parallax-element-link">',
    link && link.hasAnchor, link ? JSON.stringify(link) : 'missing img')
  check('link: href correcto (https://example.com/x)',
    link && link.href === 'https://example.com/x', link ? `href=${link.href}` : '')
  check('link: target=_blank',
    link && link.target === '_blank', link ? `target=${link.target}` : '')
  check('link: rel=noopener noreferrer (auto para _blank)',
    link && link.rel === 'noopener noreferrer', link ? `rel=${link.rel}` : '')
  check('link: el png recibe pointer-events:auto (interactive)',
    link && link.imgPointer === 'auto', link ? `pointer-events=${link.imgPointer}` : '')
  check('link: el png ES el elemento más alto en su centro (la capa no lo tapa)',
    link && link.topmostAtCenter, link ? `topmost=${link.topmostAtCenter}` : '')

  // Dispatch a real click at the png's center and confirm it reaches the <a>
  // NOT pre-canceled (no engine listener calls preventDefault). Our own
  // capture listener cancels it so the page never navigates away.
  const clickReached = await page.evaluate(() => {
    const img = document.querySelector('[data-parallax-id="il-png"]')
    const a = img.closest('a.parallax-element-link')
    const probe = { reachedAnchor: false, canceledBeforeAnchor: null }
    const onAnchor = (ev) => {
      probe.reachedAnchor = true
      // defaultPrevented here would mean some prior (engine) listener canceled it.
      probe.canceledBeforeAnchor = ev.defaultPrevented
      ev.preventDefault() // keep the test from actually navigating
    }
    a.addEventListener('click', onAnchor, { capture: true })
    const b = img.getBoundingClientRect()
    const evt = new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: b.x + b.width / 2, clientY: b.y + b.height / 2,
    })
    img.dispatchEvent(evt)
    a.removeEventListener('click', onAnchor, { capture: true })
    return probe
  })
  check('link: el click LLEGA al <a> (no es tragado por la capa/overlay)',
    clickReached.reachedAnchor, JSON.stringify(clickReached))
  check('link: NADA hace preventDefault del click antes del <a> (la navegación NO se bloquea)',
    clickReached.canceledBeforeAnchor === false, `canceledBeforeAnchor=${clickReached.canceledBeforeAnchor}`)
  check('interactive-link: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('INTERACTIVE — png hover-scale gates on hover (not on load) + link navigates on click')
}

async function suiteReal(O) {
  startArea('REAL (bestiario-botanico) — text hover-rotate fires + png link navigates with 3 concurrent anims')

  // ── real-text-hover-rotate ───────────────────────────────────────────────
  // EXACT mirror of content/portafolio/bestiario-botanico `concepto-titulo`:
  // a TEXT element with interactive:false, NO link, and a hover-trigger rotate
  // {from:0,to:180}. User confirmed on the REAL site + editor preview that
  // it does NOT rotate on hover. Root cause hypothesis: isInteractive =
  // interactive || !!link is false, so the text box is pointer-events:none,
  // the mouseenter never reaches it, and the hover animation never activates.
  // Ground truth from the engine's hover semantics: value = isHovered ? to :
  // from, so at MOUNT rotation must be 0deg, and after a REAL mouseenter it
  // must rotate toward 180. The element MUST be pointer-events != none for the
  // hover to ever fire (this check FAILS before the fix, PASSES after).
  let r = await open(O, 'fixture=real-text-hover-rotate')
  check('real-text-hover-rotate monta sin error', r.ready && !r.error, r.error || '')
  await shot('real-text-hover-rotate-load')

  // Rotation angle (deg) decoded from the element's computed 2D matrix. The
  // anchor translate(-50%,-50%) carries NO rotation, so atan2(b,a) isolates
  // the animated rotate().
  const textRotation = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="concepto-titulo"]')
    if (!e) return null
    const m = new DOMMatrixReadOnly(getComputedStyle(e).transform)
    let deg = Math.atan2(m.b, m.a) * 180 / Math.PI
    if (deg < -0.5) deg += 360 // normalize to [0,360) so 180 is unambiguous
    return +deg.toFixed(2)
  })
  const textPointer = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="concepto-titulo"]')
    return e ? getComputedStyle(e).pointerEvents : null
  })

  await page.waitForTimeout(300)
  const tLoad = await textRotation()
  check('texto hover: en carga la rotación es 0deg (no se dispara solo)',
    tLoad != null && Math.abs(tLoad) <= 1.5, `rot@load=${tLoad} (esperado ≈0)`)

  // The element must be clickable/hoverable: pointer-events NOT none, else the
  // hover listener can never receive mouseenter. THIS is the Bug 1 gate.
  const tPointerLoad = await textPointer()
  check('texto hover: pointer-events NO es none (si no, el hover nunca llega) [Bug 1]',
    tPointerLoad != null && tPointerLoad !== 'none', `pointer-events=${tPointerLoad}`)

  // Dispatch a REAL mouseenter (cannot use page.hover if pointer-events:none —
  // elementFromPoint would skip it — so we synthesize the event on the node).
  await page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="concepto-titulo"]')
    e.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  })
  await page.waitForTimeout(600)
  const tHover = await textRotation()
  await shot('real-text-hover-rotate-hover')
  check('texto hover: tras mouseenter rota hacia 180 (el hover SÍ se activa) [Bug 1]',
    tHover != null && tHover > 30, `rot@hover=${tHover} (esperado avanzando hacia 180, >30)`)

  await page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="concepto-titulo"]')
    e.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
  })
  await page.waitForTimeout(1000)
  const tLeave = await textRotation()
  check('texto hover: al salir el ratón vuelve hacia 0',
    tLeave != null && Math.abs(tLeave) <= 5, `rot@leave=${tLeave} (esperado ≈0)`)
  check('real-text-hover-rotate: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))

  // ── real-png-link-multianim ──────────────────────────────────────────────
  // EXACT mirror of content/portafolio/bestiario-botanico `flor-surreal`:
  // a PNG with interactive:true, link {href, target:_blank}, AND THREE
  // concurrent animations writing transform (scroll-scale + loop-rotate +
  // hover-scale). User confirmed clicking it does NOT open the URL — yet a
  // plain link with no animations navigated fine. The difference is the 3
  // concurrent transform writers, one of which (the hover one) was emitting a
  // CSS `transition: transform ...`. We assert: anchor is correct, the click
  // reaches the <a> NOT pre-canceled (capture-phase, defaultPrevented===false),
  // and — the real fix — that the engine does NOT put a CSS transition on
  // `transform` while a continuous (loop/scroll) trigger also writes transform
  // every frame (that conflict froze/lerped the continuous motion).
  r = await open(O, 'fixture=real-png-link-multianim')
  check('real-png-link-multianim monta sin error', r.ready && !r.error, r.error || '')

  // The flor sits in the first viewport (y:18% of the 260vh section) and is
  // covered, in the DOM, by a LATER text layer (concepto-encima) whose
  // full-section wrapper overlaps it — exactly the real bestiario stacking
  // (capa-flor UNDER capa-concepto). So elementFromPoint at the flor's center
  // and a real user click are meaningful right at load: this is where the user
  // actually clicks. The bare matrix mount has no Lenis, so we do not scroll.
  await page.waitForTimeout(300)
  await shot('real-png-link-multianim')

  const linkInfo = await page.evaluate(() => {
    const img = document.querySelector('[data-parallax-id="flor-surreal"]')
    if (!img) return null
    const a = img.closest('a.parallax-element-link')
    const cs = getComputedStyle(img)
    // A REAL transition on transform = some segment names `transform` (or the
    // CSS-default `all`) AND has a NON-zero duration. `all 0s` is the browser
    // default (no transition actually runs) and must NOT count — otherwise the
    // check can never pass. Pair each transition-property with its duration.
    const props = cs.transitionProperty.split(',').map((s) => s.trim())
    const durs = cs.transitionDuration.split(',').map((s) => parseFloat(s) || 0)
    const hasTransformTransition = props.some((p, i) => {
      const d = durs[i % durs.length] || 0
      return (p === 'transform' || p === 'all') && d > 0
    })
    const b = img.getBoundingClientRect()
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    return {
      hasAnchor: !!a,
      href: a ? a.getAttribute('href') : null,
      target: a ? a.getAttribute('target') : null,
      rel: a ? a.getAttribute('rel') : null,
      imgPointer: cs.pointerEvents,
      transitionProperty: cs.transitionProperty,
      transitionDuration: cs.transitionDuration,
      hasTransformTransition,
      topmostAtCenter: top === img || (a ? a.contains(top) : false),
    }
  })
  check('link(multianim): el png se envuelve en <a class="parallax-element-link">',
    linkInfo && linkInfo.hasAnchor, linkInfo ? JSON.stringify(linkInfo) : 'missing img')
  check('link(multianim): href correcto (https://example.com/x)',
    linkInfo && linkInfo.href === 'https://example.com/x', linkInfo ? `href=${linkInfo.href}` : '')
  check('link(multianim): target=_blank',
    linkInfo && linkInfo.target === '_blank', linkInfo ? `target=${linkInfo.target}` : '')
  check('link(multianim): rel=noopener noreferrer (auto para _blank)',
    linkInfo && linkInfo.rel === 'noopener noreferrer', linkInfo ? `rel=${linkInfo.rel}` : '')
  check('link(multianim): el png recibe pointer-events:auto',
    linkInfo && linkInfo.imgPointer === 'auto', linkInfo ? `pointer-events=${linkInfo.imgPointer}` : '')
  check('link(multianim): el png ES el elemento más alto en su centro',
    linkInfo && linkInfo.topmostAtCenter, linkInfo ? `topmost=${linkInfo.topmostAtCenter}` : '')
  // The fix: loop/scroll write transform every rAF frame, so a CSS transition
  // on transform must NOT be present (it lerps the continuous motion toward a
  // moving target — frozen/laggy on load). [Bug 2 visual half]
  check('link(multianim): NO hay transition CSS sobre `transform` (loop/scroll lo escriben por frame) [Bug 2]',
    linkInfo && !linkInfo.hasTransformTransition,
    linkInfo ? `transition-property=${linkInfo.transitionProperty} duration=${linkInfo.transitionDuration}` : '')

  // Simulate a REAL user click: dispatch on whatever is topmost at the png's
  // center (elementFromPoint), NOT on the <img> directly. This is the crux of
  // the live bug — a higher layer's wrapper used to be the topmost node and
  // swallowed the click, so it never reached the <a>. With the wrapper now
  // pointer-events:none the topmost node is the png/anchor and the click
  // bubbles to <a> with defaultPrevented===false. A capture listener on <a>
  // prevents real navigation. [Bug 2 navigation half]
  const clickReached = await page.evaluate(() => {
    const img = document.querySelector('[data-parallax-id="flor-surreal"]')
    const a = img.closest('a.parallax-element-link')
    const probe = { reachedAnchor: false, canceledBeforeAnchor: null, hitTag: null }
    const onAnchor = (ev) => {
      probe.reachedAnchor = true
      probe.canceledBeforeAnchor = ev.defaultPrevented
      ev.preventDefault()
    }
    a.addEventListener('click', onAnchor, { capture: true })
    const b = img.getBoundingClientRect()
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2
    const hit = document.elementFromPoint(cx, cy) || img
    probe.hitTag = hit.tagName + (hit.className ? '.' + String(hit.className).split(' ')[0] : '')
    const evt = new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy,
    })
    hit.dispatchEvent(evt)
    a.removeEventListener('click', onAnchor, { capture: true })
    return probe
  })
  check('link(multianim): un click de usuario (sobre el elemento más alto) LLEGA al <a> con 3 anims [Bug 2]',
    clickReached.reachedAnchor, JSON.stringify(clickReached))
  check('link(multianim): NADA hace preventDefault del click antes del <a> [Bug 2]',
    clickReached.canceledBeforeAnchor === false, `canceledBeforeAnchor=${clickReached.canceledBeforeAnchor}`)
  check('real-png-link-multianim: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('REAL (bestiario-botanico) — text hover-rotate fires + png link navigates with 3 concurrent anims')
}

async function suiteSplitText(O) {
  startArea('SPLIT TEXT — words / chars / lines + staggerDelay (no clip)')

  const r = await open(O, 'fixture=split-text')
  check('split-text monta', r.ready && !r.error, r.error || '')
  await page.waitForTimeout(1200) // let enter fire so parts reveal
  await shot('split-text')
  const sp = await page.evaluate(() => {
    function parts(id) {
      const host = document.querySelector(`[data-parallax-id="${id}"]`)
      if (!host) return null
      const spans = [...host.querySelectorAll('.split-part')]
      // parse transition-delay per part (ms)
      const delays = spans.map((s) => {
        const td = getComputedStyle(s).transitionDelay || '0s'
        // transitionDelay may list multiple (opacity, transform) — take max
        return Math.max(...td.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000)))
      })
      const fullText = host.textContent.replace(/\s+/g, ' ').trim()
      return {
        n: spans.length,
        delays,
        increasing: delays.length >= 2 && delays[delays.length - 1] > delays[0],
        fullText,
        clientH: host.clientHeight,
        scrollH: host.scrollHeight,
        boxW: Math.round(host.getBoundingClientRect().width),
        anyVisible: spans.some((s) => parseFloat(getComputedStyle(s).opacity) > 0.5),
      }
    }
    return { words: parts('split-words'), chars: parts('split-chars'), lines: parts('split-lines') }
  })
  // words: "Nos casamos pronto" → split(/(\s+)/) preserves spaces = 5 parts
  check('words: dividido en partes (>=3 palabras)', sp.words && sp.words.n >= 3, sp.words ? `n=${sp.words.n}` : 'missing')
  check('words: texto completo NO clipado ("Nos casamos pronto")',
    sp.words && /Nos casamos pronto/.test(sp.words.fullText), sp.words ? sp.words.fullText : '')
  check('words: stagger creciente (delay[last] > delay[0])',
    sp.words && sp.words.increasing, sp.words ? JSON.stringify(sp.words.delays) : '')
  check('words: host sin overflow vertical (scrollH ≈ clientH)',
    sp.words && sp.words.scrollH <= sp.words.clientH + 2, sp.words ? `sH=${sp.words.scrollH} cH=${sp.words.clientH}` : '')
  // chars: "Sofia y Juan" = 12 chars
  check('chars: dividido por carácter (n ≈ 12)', sp.chars && sp.chars.n >= 10, sp.chars ? `n=${sp.chars.n}` : 'missing')
  check('chars: texto completo presente', sp.chars && /Sofia y Juan/.test(sp.chars.fullText), sp.chars ? sp.chars.fullText : '')
  check('chars: stagger creciente', sp.chars && sp.chars.increasing, sp.chars ? JSON.stringify(sp.chars.delays.slice(0, 6)) : '')
  // lines: 3 lines
  check('lines: 3 líneas', sp.lines && sp.lines.n === 3, sp.lines ? `n=${sp.lines.n}` : 'missing')
  check('lines: las 3 líneas presentes', sp.lines && /Linea uno.*Linea dos.*Linea tres/.test(sp.lines.fullText),
    sp.lines ? sp.lines.fullText : '')
  check('split: partes reveladas (visibles tras enter)',
    sp.words && sp.words.anyVisible && sp.chars && sp.chars.anyVisible, '')
  check('split-text: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('SPLIT TEXT — words / chars / lines + staggerDelay (no clip)')
}

async function suiteTransitions(O) {
  startArea('TRANSITIONS — fade / wipe / crossfade-blur / zoom / page-flip + meta.transition')

  for (const t of ['fade', 'wipe', 'crossfade-blur', 'zoom', 'page-flip']) {
    const r = await open(O, `fixture=world-a&to=world-b&tt=${t}&td=500`)
    check(`transición ${t}: monta sin error`, r.ready && !r.error, r.error || '')
    // Mid-transition: both worlds should be in the DOM (.world-transition wrapper).
    const mid = await page.evaluate(() => ({
      wrap: !!document.querySelector('.world-transition'),
      aTitle: !!document.querySelector('[data-parallax-id="world-a-title"]'),
      bTitle: !!document.querySelector('[data-parallax-id="world-b-title"]'),
    }))
    check(`transición ${t}: <WorldTransition> presente`, mid.wrap, '')
    check(`transición ${t}: el mundo destino (B) monta y queda visible`, mid.bTitle, '')
    // Wait for completion, assert B remains and is visible.
    await page.waitForFunction(() => window.__matrixTransitionDone === true, { timeout: 5000 })
      .catch(() => {})
    const done = await page.evaluate(() => {
      const b = document.querySelector('[data-parallax-id="world-b-title"]')
      const r = b && b.getBoundingClientRect()
      return {
        bVisible: !!(r && r.width > 0 && r.height > 0 && parseFloat(getComputedStyle(b).opacity) > 0.5),
        done: window.__matrixTransitionDone === true,
      }
    })
    check(`transición ${t}: completa y deja B visible`, done.bVisible, `done=${done.done}`)
    await shot(`transition-${t}`)
  }

  // meta.transition present on a single site: must parse + mount visible
  // (ParallaxSite itself does not orchestrate worlds; the field is config the
  // consumer reads — assert it does not break rendering and is preserved).
  const r = await open(O, 'fixture=meta-transition')
  check('meta.transition: site monta sin error', r.ready && !r.error, r.error || '')
  const mt = await page.evaluate(() => {
    const site = document.querySelector('.parallax-site')
    const t = document.querySelector('[data-parallax-id="mt-title"]')
    return {
      siteVisible: site ? parseFloat(getComputedStyle(site).opacity) > 0.5 : false,
      titleVisible: !!(t && t.getBoundingClientRect().width > 0),
    }
  })
  check('meta.transition: contenido visible (no rompe el render)',
    mt.siteVisible && mt.titleVisible, JSON.stringify(mt))
  await shot('meta-transition')
  check('transitions: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('TRANSITIONS — fade / wipe / crossfade-blur / zoom / page-flip + meta.transition')
}

async function suiteResponsive(O) {
  startArea('RESPONSIVE — v1.1 views (desktop vs mobile trees) + legacy v1.0 overrides')

  // v1.1 views: desktop viewport → desktop tree; mobile viewport → mobile tree.
  await newPage({ width: VW, height: VH })
  let r = await open(O, 'fixture=views-v11')
  check('views-v11 (desktop) monta', r.ready && !r.error, r.error || '')
  let ids = await page.evaluate(() =>
    [...document.querySelectorAll('[data-parallax-id]')].map((e) => e.getAttribute('data-parallax-id')))
  check('v1.1 views: viewport desktop renderiza el ÁRBOL desktop',
    ids.includes('view-desktop-only') && !ids.includes('view-mobile-only'), JSON.stringify(ids))
  await shot('views-v11-desktop')

  await newPage({ width: MOBILE_VW, height: MOBILE_VH })
  r = await open(O, 'fixture=views-v11')
  check('views-v11 (mobile) monta', r.ready && !r.error, r.error || '')
  ids = await page.evaluate(() =>
    [...document.querySelectorAll('[data-parallax-id]')].map((e) => e.getAttribute('data-parallax-id')))
  check('v1.1 views: viewport mobile renderiza el ÁRBOL mobile (distinto)',
    ids.includes('view-mobile-only') && !ids.includes('view-desktop-only'), JSON.stringify(ids))
  await shot('views-v11-mobile')

  // legacy v1.0 per-element overrides: same id, different position per device.
  await newPage({ width: VW, height: VH })
  r = await open(O, 'fixture=legacy-v10-overrides')
  check('legacy-v10-overrides (desktop) monta', r.ready && !r.error, r.error || '')
  let g = await geometry()
  // desktop override: pos {25,30}
  near(g['responsive-el'] && g['responsive-el'].cx, 25, 2.5, 'legacy desktop cx')
  near(g['responsive-el'] && g['responsive-el'].cy, 30, 3, 'legacy desktop cy')
  await shot('legacy-v10-desktop')

  await newPage({ width: MOBILE_VW, height: MOBILE_VH })
  r = await open(O, 'fixture=legacy-v10-overrides')
  check('legacy-v10-overrides (mobile) monta', r.ready && !r.error, r.error || '')
  g = await geometry()
  // mobile override: pos {75,80}
  near(g['responsive-el'] && g['responsive-el'].cx, 75, 3, 'legacy mobile cx (override aplicado)')
  near(g['responsive-el'] && g['responsive-el'].cy, 80, 3.5, 'legacy mobile cy (override aplicado)')
  await shot('legacy-v10-mobile')

  await newPage({ width: VW, height: VH }) // restore desktop for the rest
  check('responsive: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('RESPONSIVE — v1.1 views (desktop vs mobile trees) + legacy v1.0 overrides')
}

async function suiteReducedMotion(O) {
  startArea('A11Y — prefers-reduced-motion (visible, no loop motion)')

  const r = await open(O, 'fixture=reduced-motion', { reduced: true })
  check('reduced-motion monta (emulado)', r.ready && !r.error, r.error || '')
  await page.waitForTimeout(600)
  const enterOp = await page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="rm-enter"]')
    return e ? parseFloat(getComputedStyle(e).opacity) : null
  })
  check('reduced: enter fadeIn resuelve directo a visible (opacity ~1, no caja en blanco)',
    enterOp != null && enterOp > 0.9, `opacity=${enterOp}`)
  // loop element: with reduced motion the engine writes NO transform for the
  // loop (it `continue`s before pushing). Sample twice — must NOT change.
  const lt = () => page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="rm-loop"]')
    return e ? getComputedStyle(e).transform : null
  })
  const l0 = await lt()
  await page.waitForTimeout(800)
  const l1 = await lt()
  check('reduced: loop NO se mueve (transform estable, sin animación)',
    l0 === l1, `${l0} -> ${l1}`)
  const loopVisible = await page.evaluate(() => {
    const e = document.querySelector('[data-parallax-id="rm-loop"]')
    const b = e && e.getBoundingClientRect()
    return !!(b && b.width > 0 && b.height > 0)
  })
  check('reduced: el elemento de loop sigue visible (no desaparece)', loopVisible, '')
  await shot('reduced-motion')
  check('reduced-motion: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('A11Y — prefers-reduced-motion (visible, no loop motion)')
}

async function suiteQuality(O) {
  startArea('QUALITY TIER — maxLayers cap exceeded → graceful degrade')

  const r = await open(O, 'fixture=quality-cap')
  check('quality-cap monta sin crash', r.ready && !r.error, r.error || '')
  const q = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-parallax-id]')].map((e) => e.getAttribute('data-parallax-id'))
    const l0 = document.querySelector('[data-parallax-id="qc-el-0"]')
    // find the rendered layer wrappers count
    const layers = document.querySelectorAll('.parallax-layer').length
    let blurOnL0 = null
    if (l0) {
      const lay = l0.closest('.parallax-layer')
      blurOnL0 = lay ? getComputedStyle(lay).filter : null
    }
    return { ids, layers, blurOnL0 }
  })
  // desktop cap maxLayers:3 → only layerIndex 0,1,2 render → qc-el-0..2 present,
  // qc-el-3..5 absent. Engine degrades by not rendering capped layers.
  check('quality cap: layers dentro del cap (0-2) renderizan',
    q.ids.includes('qc-el-0') && q.ids.includes('qc-el-1') && q.ids.includes('qc-el-2'), JSON.stringify(q.ids))
  check('quality cap: layers sobre el cap (3-5) NO renderizan (degrade)',
    !q.ids.includes('qc-el-3') && !q.ids.includes('qc-el-4') && !q.ids.includes('qc-el-5'), JSON.stringify(q.ids))
  check('quality cap: exactamente 3 layers pintados', q.layers === 3, `layers=${q.layers}`)
  check('quality cap: blurEnabled:false → sin filtro blur en L0 (degrade, no crash)',
    q.blurOnL0 === 'none' || q.blurOnL0 == null, `filter=${q.blurOnL0}`)
  await shot('quality-cap')
  check('quality-cap: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('QUALITY TIER — maxLayers cap exceeded → graceful degrade')
}

async function suiteNoBleed(O) {
  startArea('NO-BLEED — each section CLIPS its content to the section box')

  // no-bleed fixture: section nb-1 (0..VH, bg #202040) holds an OVERSIZED png
  // (size 200%×200%, anchor center → layout box extends VH/2 above & below the
  // section) AND an element positioned BELOW the section margin (y:140% →
  // outside the section box). section nb-2 (VH..2VH, bg #104010) is the
  // neighbor. With the section clip, nb-1's content is confined to 0..VH and
  // cannot paint into nb-2. This is the SAME engine the real eventos/site
  // render, so a green check = a hard-refreshed real site no longer bleeds.
  let r = await open(O, 'fixture=no-bleed')
  check('no-bleed monta sin error', r.ready && !r.error, r.error || '')
  await shot('no-bleed')

  const geo = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.parallax-section')]
    const s1 = secs[0]
    const cs = getComputedStyle(s1)
    const sb = s1.getBoundingClientRect()
    function rectOf(id) {
      const e = document.querySelector(`[data-parallax-id="${id}"]`)
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }
    }
    return {
      sec1Overflow: cs.overflow,
      sec1: { top: Math.round(sb.top), bottom: Math.round(sb.bottom), h: Math.round(sb.height) },
      oversize: rectOf('nb-oversize'),
      outside: rectOf('nb-outside'),
      sec2top: secs[1] ? Math.round(secs[1].getBoundingClientRect().top) : null,
    }
  })

  // (1) The computed clip is in place on the section box.
  check('no-bleed: la sección recorta su contenido (overflow:hidden)',
    geo.sec1Overflow === 'hidden', `overflow=${geo.sec1Overflow}`)

  // (2) The oversized child's LAYOUT box genuinely extends BEYOND the section
  // box (otherwise the test would be vacuous — confirm we are actually testing
  // an overflowing element).
  check('no-bleed: el png 200% SÍ se extiende fuera de la caja de la sección (caso real)',
    geo.oversize && (geo.oversize.bottom > geo.sec1.bottom + 5 || geo.oversize.top < geo.sec1.top - 5),
    geo.oversize ? `png[${Math.round(geo.oversize.top)}..${Math.round(geo.oversize.bottom)}] vs sección[${geo.sec1.top}..${geo.sec1.bottom}]` : 'missing')
  check('no-bleed: el elemento en y:140% queda (en layout) fuera de la sección',
    geo.outside && geo.outside.top > geo.sec1.bottom - 5,
    geo.outside ? `outside.top=${Math.round(geo.outside.top)} secBottom=${geo.sec1.bottom}` : 'missing')

  // (3) PAINTED proof: decode a full-page screenshot in-page and sample pixels
  // INSIDE neighbor section nb-2 (doc-y > VH) at points the oversized child's
  // layout box covers. With the clip those pixels are nb-2's bg (#104010 =
  // rgb(16,64,16)), NOT the png and NOT the magenta out-of-bounds text. If the
  // clip regressed, the png/text would paint there and the colors would differ.
  const shotBuf = await page.screenshot({ fullPage: true })
  const b64 = shotBuf.toString('base64')
  const px = await page.evaluate(async (b64) => {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64 })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const cx = c.getContext('2d')
    cx.drawImage(img, 0, 0)
    const dpr = window.devicePixelRatio || 1
    const secs = [...document.querySelectorAll('.parallax-section')]
    const s2top = secs[1].getBoundingClientRect().top // doc-space top of nb-2 (page not scrolled)
    const cxw = Math.round((window.innerWidth / 2) * dpr)
    function sample(docY) {
      const d = cx.getImageData(cxw, Math.round(docY * dpr), 1, 1).data
      return `${d[0]},${d[1]},${d[2]}`
    }
    return {
      s2top: Math.round(s2top),
      justInsideB: sample(s2top + 8),    // 8px into nb-2
      deeperB: sample(s2top + 60),       // 60px into nb-2 (where y:140% text would land if it bled)
      midB: sample(s2top + 300),
      bg2: '16,64,16',
    }
  }, b64)
  const isNeighborBg = (v) => v === '16,64,16'
  check('no-bleed: justo dentro del vecino NO aparece el contenido de la sección previa (bg vecino)',
    isNeighborBg(px.justInsideB), `pixel=${px.justInsideB} (esperado bg vecino ${px.bg2})`)
  check('no-bleed: el png oversize NO pinta dentro del vecino (clip efectivo)',
    isNeighborBg(px.deeperB), `pixel=${px.deeperB} (esperado bg vecino ${px.bg2})`)
  check('no-bleed: el elemento fuera de margen (magenta) NO invade el vecino',
    isNeighborBg(px.midB), `pixel=${px.midB} (esperado bg vecino ${px.bg2})`)
  check('no-bleed: sin pageerror', pageErrors.length === 0, pageErrors.join(' | '))

  // (4) The clip did NOT break the OTHER scroll behaviors. Re-assert that the
  // pinned outer wrapper stays overflow:visible (so the sticky can travel — a
  // clip there would break the pin) while the sticky inner clips to 100vh, and
  // that the horizontal track still overflows for its translateX reveal under
  // the (now explicit) section clip.
  r = await open(O, 'fixture=scroll-pinned')
  check('no-bleed/pinned: monta', r.ready && !r.error, r.error || '')
  const pinClip = await page.evaluate(() => {
    const inner = document.querySelector('#pin-1, .parallax-section')
    const outer = inner ? inner.parentElement : null
    return {
      innerOverflow: inner ? getComputedStyle(inner).overflow : null,
      innerPos: inner ? getComputedStyle(inner).position : null,
      innerH: inner ? Math.round(inner.getBoundingClientRect().height) : null,
      outerOverflow: outer ? getComputedStyle(outer).overflow : null,
      outerH: outer ? Math.round(outer.getBoundingClientRect().height) : null,
    }
  })
  check('no-bleed/pinned: el sticky interior (100vh) recorta (overflow:hidden)',
    pinClip.innerOverflow === 'hidden' && pinClip.innerPos === 'sticky' && Math.abs(pinClip.innerH - VH) < VH * 0.05,
    `overflow=${pinClip.innerOverflow} pos=${pinClip.innerPos} h=${pinClip.innerH}`)
  check('no-bleed/pinned: el wrapper exterior NO recorta (overflow:visible → el sticky viaja)',
    pinClip.outerOverflow !== 'hidden' && pinClip.outerOverflow !== 'clip' && Math.abs(pinClip.outerH - VH * 2.5) < VH * 0.1,
    `outerOverflow=${pinClip.outerOverflow} outerH=${pinClip.outerH}`)

  r = await open(O, 'fixture=scroll-horizontal-dir')
  check('no-bleed/horizontal: monta', r.ready && !r.error, r.error || '')
  const horClip = await page.evaluate(() => {
    const sec = document.querySelector('.parallax-section')
    const track = document.querySelector('.horizontal-track')
    return {
      secOverflow: sec ? getComputedStyle(sec).overflow : null,
      trackDisplay: track ? getComputedStyle(track).display : null,
      // the flex track (2 cells × 100vw) is wider than the section → scrollWidth
      // exceeds clientWidth, which is what the section clip turns into a reveal.
      secClientW: sec ? sec.clientWidth : null,
      secScrollW: sec ? sec.scrollWidth : null,
    }
  })
  check('no-bleed/horizontal: la sección recorta (overflow:hidden) sin romper el track flex',
    horClip.secOverflow === 'hidden' && horClip.trackDisplay === 'flex',
    `secOverflow=${horClip.secOverflow} track=${horClip.trackDisplay}`)
  check('no-bleed/horizontal: el track sigue desbordando horizontalmente (reveal intacto)',
    horClip.secScrollW != null && horClip.secClientW != null && horClip.secScrollW > horClip.secClientW,
    `scrollW=${horClip.secScrollW} clientW=${horClip.secClientW}`)
  check('no-bleed: sin pageerror (2)', pageErrors.length === 0, pageErrors.join(' | '))
  endArea('NO-BLEED — each section CLIPS its content to the section box')
}

async function suiteSanity(O) {
  startArea('SANITY — deliberately invalid fixture is REJECTED by the contract')
  const r = await open(O, 'fixture=_invalid-sanity')
  // mount.mjs runs the engine's validateSite; an invalid doc → __matrixError.
  check('schema-invalid: el contrato lo rechaza (__matrixError presente)',
    !!r.error && /schema invalid/.test(r.error), r.error || '(no error — harness would silently pass!)')
  check('schema-invalid: NO se marca ready', r.ready === false, `ready=${r.ready}`)
  await shot('invalid-sanity')
  endArea('SANITY — deliberately invalid fixture is REJECTED by the contract')
}

// ─── Main ──────────────────────────────────────────────────────────────────
;(async () => {
  if (!CHROME) {
    console.error('No Chrome/Chromium found. Set CHROME_BIN.')
    process.exit(2)
  }
  // The suite consumes the engine's BUILT dist (yarn dev watch produces it).
  for (const f of ['index.js', 'schema.js', 'style.css']) {
    if (!fs.existsSync(path.join(ENGINE_DIST, f))) {
      console.error(
        `Falta ${path.join(ENGINE_DIST, f)}. Compila el engine primero ` +
        `(cd ../../parallax-engine && yarn build, o deja \`yarn dev\` corriendo).`,
      )
      process.exit(2)
    }
  }

  let srv
  try {
    srv = await matrixServer.start()
  } catch (e) {
    console.error(`engine-matrix server: ${(e && e.message) || e}`)
    process.exit(2)
  }
  const O = srv.origin

  log(`Chrome: ${CHROME}`)
  log(`engine-matrix server: ${O}  (offline; engine dist: ${ENGINE_DIST})`)
  log(`headless=${HEADLESS} viewport=${VW}x${VH} mobile=${MOBILE_VW}x${MOBILE_VH}`)

  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: HEADLESS })
    await newPage({ width: VW, height: VH })

    await suiteAnchors(O)
    await suiteScroll(O)
    await suiteParallaxModes(O)
    await suiteElementTypes(O)
    await suiteAnimations(O)
    await suiteInteractive(O)
    await suiteReal(O)
    await suiteSplitText(O)
    await suiteTransitions(O)
    await suiteResponsive(O)
    await suiteReducedMotion(O)
    await suiteQuality(O)
    await suiteNoBleed(O)
    await suiteSanity(O)
  } catch (e) {
    log(`\nHARNESS ERROR: ${e && e.stack || e}`)
    failures++
  } finally {
    if (browser) await browser.close().catch(() => {})
    await srv.stop().catch(() => {})
  }

  // ─── RESUMEN ──────────────────────────────────────────────────────────────
  log(`\n──── RESUMEN POR ÁREA ────`)
  for (const [name, a] of Object.entries(area)) {
    const fl = a.failed == null ? '?' : a.failed
    const rn = a.ran == null ? '?' : a.ran
    log(`  ${fl === 0 ? 'PASS' : 'FAIL'}  ${name}  (${rn - fl}/${rn})`)
  }
  const summary = `\n==== RESUMEN: ${failures === 0 ? 'TODO PASS' : failures + ' FAIL'} / ${checksRun} checks ====`
  log(summary)
  fs.writeFileSync(path.join(SHOTS, 'report.txt'), lines.join('\n'))
  log(`screenshots+reporte: ${SHOTS}`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('ENGINE-MATRIX FAIL:', e && e.stack || e)
  process.exit(2)
})
