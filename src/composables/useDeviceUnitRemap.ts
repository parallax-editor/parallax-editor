// ── Utility: remapea unidades viewport (`vw`, `vh`, `vmin`, `vmax`) del
//    schema a `px` relativos a un artboard/simulador de dispositivo dado.
//
// El engine parallax pinta `vw`/`vh` contra `window.innerWidth`/`Height`. En:
//   • el canvas del editor (EditorCanvas.vue) → el "viewport" real es el
//     ARTBOARD escalado, no la ventana → un `9vw` debía medirse contra 390 (móvil)
//     o 1440 (desktop), no contra el tamaño real del navegador. Sin esto, un
//     título con `clamp(2.6rem, 9vw, 6.5rem)` explotaba a 130px cuando en el
//     móvil real serían 35px.
//   • la Vista en vivo (LivePreview.vue) → cuando el usuario elige simular
//     "Móvil", envolvemos el engine en un frame 390×844 dentro de la ventana
//     real (1440×900). Sin remap, `9vw` sigue midiendo contra 1440 y el título
//     desborda el frame — visible como "ebración De" cortado por los lados.
//
// Este archivo consolida la lógica que ya vivía inline en EditorCanvas.vue,
// pero PARAMETRIZADA por viewport (no depende del store). El editor sigue
// llamándola con `VIEWPORTS[state.deviceMode]`; LivePreview la llama con un
// literal cuando simula.

const VP_UNIT_TOKEN_RE = /([\d.]+)\s*(vw|vh|vmin|vmax)\b/gi

export interface DeviceViewport {
  width: number
  height: number
}

/**
 * Reemplaza CADA ocurrencia de `<n>vw` / `<n>vh` / `vmin` / `vmax` en el string
 * por su equivalente en `px` respecto al viewport dado. Deja el string intacto
 * si no contiene ninguna unidad viewport (fast-path barato) o si el token no es
 * un número finito.
 *
 * Diseñado para atrapar unidades DENTRO de `clamp()` / `calc()` / `min()` /
 * `max()`, no solo strings aislados: `"clamp(2.6rem, 9vw, 6.5rem)"` se
 * convierte en `"clamp(2.6rem, 35.1px, 6.5rem)"` cuando `vp.width=390`.
 */
export function remapViewportUnitsFor<T>(value: T, vp: DeviceViewport): T {
  if (typeof value !== 'string' || !/(vw|vh|vmin|vmax)/i.test(value)) return value
  return (value as string).replace(VP_UNIT_TOKEN_RE, (_m, num: string, unit: string) => {
    const n = parseFloat(num)
    if (!Number.isFinite(n)) return _m
    const u = unit.toLowerCase()
    const basis =
      u === 'vw' ? vp.width :
      u === 'vh' ? vp.height :
      u === 'vmin' ? Math.min(vp.width, vp.height) :
      Math.max(vp.width, vp.height)
    return `${(n / 100) * basis}px`
  }) as unknown as T
}

/**
 * Reescribe fontSize + size.width/height (y los overrides `mobile`/`desktop`)
 * de un elemento en su copia. Mismo alcance que la versión inline del editor;
 * las secciones se reescriben aparte (su `height` es string-viewport-unit).
 */
export function remapElementUnitsFor(el: any, vp: DeviceViewport): void {
  const fix = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    if (typeof obj.fontSize === 'string') obj.fontSize = remapViewportUnitsFor(obj.fontSize, vp)
    if (obj.size && typeof obj.size === 'object') {
      if (typeof obj.size.width === 'string') obj.size.width = remapViewportUnitsFor(obj.size.width, vp)
      if (typeof obj.size.height === 'string') obj.size.height = remapViewportUnitsFor(obj.size.height, vp)
    }
  }
  if (!el || typeof el !== 'object') return
  fix(el)
  fix(el.mobile)
  fix(el.desktop)
}

/**
 * Reescribe TODA la caja del sitio (heights de secciones + tokens de todos los
 * elementos) contra el viewport dado. Retorna un NUEVO objeto — no muta el
 * original. Idempotente: si el site ya tiene todo en px, es un no-op.
 *
 * Usado por LivePreview cuando simula "móvil": pasa el ancho lógico del frame
 * (390) para que el engine renderice como si estuviera en un teléfono real
 * dentro de nuestra ventana grande.
 */
export function remapSiteViewportUnits(site: any, vp: DeviceViewport): any {
  if (!site) return site
  const copy = JSON.parse(JSON.stringify(site))
  for (const section of copy.sections || []) {
    if (typeof section.height === 'string') section.height = remapViewportUnitsFor(section.height, vp)
    for (const layer of section.layers || []) {
      for (const el of layer.elements || []) {
        remapElementUnitsFor(el, vp)
      }
    }
  }
  return copy
}
