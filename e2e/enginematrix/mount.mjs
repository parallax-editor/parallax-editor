/**
 * enginematrix mount page (ESM, browser).
 *
 * Imports the REAL engine from its BUILT bundle (`/engine/index.js` → the
 * served alias of ../../parallax-engine/dist/index.js) and Vue 3 + lenis from
 * the engine's own node_modules via the import map in index.html (single Vue
 * instance — same dedupe guarantee the real consumers get through `link:`).
 *
 * URL params:
 *   ?fixture=<name>   fixtures/<name>.json — REQUIRED to render anything
 *   ?to=<name>        optional 2nd world: renders <WorldTransition> from the
 *                     first fixture to this one, driven by ?tt=<type>&td=<ms>
 *   ?tt=<type>        transition type (fade|wipe|crossfade-blur|zoom|page-flip)
 *   ?td=<ms>          transition duration (default 600)
 *
 * Diagnostics on window:
 *   window.__matrixReady   true once mounted + first paints settled
 *   window.__matrixError   string if fetch/parse/mount failed
 *   window.__matrixInfo    { fixture, schemaOk, sectionCount, viewportWidth, ... }
 *   window.__matrixTransitionDone  true once a ?to= WorldTransition completes
 *   window.__matrixPatchAnimations(elementId, animations)
 *       Single-world only. Replaces the `animations` array of the element with
 *       the given id ON THE LIVE, REACTIVE site (the engine is NOT remounted) —
 *       exactly what the editor does when the user edits an animation: it patches
 *       a new array onto the element of the deep-cloned site it re-renders, with
 *       a STABLE engineKey (no remount, to preserve scroll/selection). Used by
 *       the matrix to prove `useElementAnimations` reacts to the new array (the
 *       reactive-getter fix). Returns true if the element was found & patched.
 *
 * `mode="prod"` is forced so the error policy matches production (silent
 * console.error, no dev red overlay) — exactly what the matrix asserts.
 *
 * FormBlock is registered in the component registry so `component` element
 * fixtures referencing the built-in `FormBlock` render (the engine does NOT
 * auto-register it; consumers pass it via the `components` prop / config).
 */
import { createApp, h, ref, reactive, onMounted } from 'vue'
import { ParallaxSite, FormBlock, validateSite } from '/engine/index.js'

const params = new URLSearchParams(location.search)
const fixture = params.get('fixture') || 'anchors-all'
const toName = params.get('to') || null
const ttype = params.get('tt') || 'fade'
const tdur = Number(params.get('td') || 600)

const COMPONENTS = { FormBlock }

function fail(msg) {
  window.__matrixError = String(msg)
  window.__matrixReady = false
  const app = document.getElementById('app')
  if (app) {
    app.innerHTML =
      '<pre style="color:#f55;padding:20px;font:14px monospace;white-space:pre-wrap;">' +
      'MATRIX MOUNT ERROR\n' + String(msg) + '</pre>'
  }
  // eslint-disable-next-line no-console
  console.error('[enginematrix]', msg)
}

async function loadFixture(name) {
  const res = await fetch(`/fixtures/${name}.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetch /fixtures/${name}.json -> HTTP ${res.status}`)
  return res.json()
}

/**
 * Validate against the engine's own schema (the sacred contract). ANY fixture
 * that fails validateSite is rejected here and NEVER mounted — that is the
 * whole point of the `_invalid-sanity` fixture: prove the harness genuinely
 * catches a broken contract instead of silently passing. Valid fixtures return
 * the parsed+DEFAULTED Site so we exercise the real engine defaulting path.
 *
 * `__expectInvalid: true` / leading-underscore comment keys are stripped before
 * validation so a fixture can self-document without tripping the schema.
 */
function resolveSite(raw, name) {
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      if (k === '__expectInvalid' || k.startsWith('_')) delete raw[k]
    }
  }
  const v = validateSite(raw)
  if (!v.ok) {
    throw new Error(`schema invalid for "${name}": ${JSON.stringify(v.errors)}`)
  }
  return { site: v.data, schemaOk: true, expectInvalid: false }
}

;(async () => {
  let first
  try {
    first = resolveSite(await loadFixture(fixture), fixture)
  } catch (e) {
    return fail(`fixture "${fixture}": ${(e && e.message) || e}`)
  }

  let second = null
  if (toName) {
    try {
      second = resolveSite(await loadFixture(toName), toName)
    } catch (e) {
      return fail(`fixture (to) "${toName}": ${(e && e.message) || e}`)
    }
  }

  try {
    let RootComp
    if (second) {
      // Two-world transition: <WorldTransition from to> wrapping two
      // <ParallaxSite> instances. We import WorldTransition lazily off the
      // same bundle so the single-world path stays minimal.
      const { WorldTransition } = await import('/engine/index.js')
      RootComp = {
        setup() {
          const done = ref(false)
          onMounted(() => { window.__matrixTransitionDone = false })
          return () =>
            h(
              WorldTransition,
              {
                from: first.site,
                to: second.site,
                transition: { type: ttype, duration: tdur },
                onComplete: () => {
                  done.value = true
                  window.__matrixTransitionDone = true
                },
              },
              {
                from: () => h(ParallaxSite, { site: first.site, mode: 'prod', components: COMPONENTS }),
                to: () => h(ParallaxSite, { site: second.site, mode: 'prod', components: COMPONENTS }),
              },
            )
        },
      }
    } else {
      // Single world: make the site DEEPLY reactive so the matrix can patch an
      // element's `animations` array in place (via __matrixPatchAnimations) and
      // have the change flow through props to the element components WITHOUT a
      // remount — mirroring the editor's stable-engineKey live edit. `reactive`
      // does not alter the rendered output for the (vast majority of) fixtures
      // that are never patched; ParallaxSite already treats `site` as reactive.
      const liveSite = reactive(first.site)
      first.site = liveSite
      window.__matrixPatchAnimations = (elementId, animations) => {
        const visit = (els) => {
          for (const el of els || []) {
            if (el && el.id === elementId) {
              el.animations = animations
              return true
            }
          }
          return false
        }
        const eachSection = (sections) => {
          for (const sec of sections || []) {
            for (const layer of sec.layers || []) {
              if (visit(layer.elements)) return true
            }
          }
          return false
        }
        if (liveSite.views) {
          for (const vp of Object.values(liveSite.views)) {
            if (eachSection(vp && vp.sections)) return true
          }
          return false
        }
        return eachSection(liveSite.sections)
      }
      RootComp = {
        render: () => h(ParallaxSite, { site: liveSite, mode: 'prod', components: COMPONENTS }),
      }
    }
    const app = createApp(RootComp)
    app.config.errorHandler = (err) => fail(`vue error: ${(err && err.stack) || err}`)
    app.mount('#app')
  } catch (e) {
    return fail(`mount "${fixture}": ${(e && e.stack) || e}`)
  }

  const siteData = first.site
  window.__matrixInfo = {
    fixture,
    to: toName,
    schemaOk: first.schemaOk,
    expectInvalid: first.expectInvalid,
    sectionCount: siteData.views
      ? (siteData.views.desktop?.sections?.length ?? 0)
      : (siteData.sections?.length ?? 0),
    hasViews: !!siteData.views,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }

  // Settle: wait for the engine's onMounted, IntersectionObserver enter flips
  // (which the engine defers two rAFs), Lenis init, and a final timeout.
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setTimeout(() => { window.__matrixReady = true }, 120)
      }),
    ),
  )
})()
