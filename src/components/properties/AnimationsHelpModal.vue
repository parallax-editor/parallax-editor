<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue'
import { usePanelScroll } from '../../composables/usePanelScroll'

// Detailed, plain-Spanish guide to ANIMATION TYPES, TRIGGERS and EASING.
// Opened from the "?" before the "+" in the Animaciones header (and from the
// "Ver guía de easing" link, which jumps to the Easing section). A teleported
// modal: nicely formatted (headings + grouped cards), scrollable, dismissible
// with the X button, a click on the backdrop, or Esc.
const props = defineProps<{ focusSection?: string | null }>()
const emit = defineEmits<{ close: [] }>()

// The modal floats over the live engine preview, whose Lenis instance registers
// a non-passive wheel listener on window and preventDefaults it — so the body's
// overflow-y:auto never scrolls with the wheel. Same fix as the side panels:
// capture the wheel on the scroll body and stopPropagation (no preventDefault)
// so it never reaches Lenis but native element scrolling still happens.
const { panelScrollRef } = usePanelScroll()
const easingRef = ref<HTMLElement | null>(null)

interface Entry { name: string; desc: string; when: string }

// Animation TYPES grouped by family so the list is scannable.
const TYPE_GROUPS: { group: string; items: Entry[] }[] = [
  {
    group: 'Aparición',
    items: [
      { name: 'fadeIn', desc: 'El elemento aparece pasando de invisible a visible (sube la opacidad).', when: 'Para que un texto o imagen surja con elegancia al entrar en pantalla.' },
      { name: 'fadeOut', desc: 'El elemento se desvanece de visible a invisible.', when: 'Para que algo desaparezca poco a poco al salir o al hacer scroll.' },
    ],
  },
  {
    group: 'Movimiento',
    items: [
      { name: 'translateX', desc: 'Desliza el elemento de lado, en PÍXELES medidos DESDE su posición actual. 0 = en su sitio; positivo = a la derecha, negativo = a la izquierda.', when: 'Para que algo entre deslizándose: ej. Desde −40 Hasta 0 = entra desde la izquierda hasta quedar en su sitio.' },
      { name: 'translateY', desc: 'Desliza el elemento arriba/abajo, en PÍXELES medidos DESDE su posición actual. 0 = en su sitio; positivo = hacia abajo, negativo = hacia arriba.', when: 'Para que un título suba al aparecer: ej. Desde 30 Hasta 0. (No es relativo al anchor: mueve toda la caja.)' },
    ],
  },
  {
    group: 'Giro',
    items: [
      { name: 'rotate', desc: 'Gira el elemento sobre el plano (en grados).', when: 'Para un sello, una flecha o un detalle que rota al aparecer.' },
      { name: 'rotateX', desc: 'Gira en 3D sobre el eje horizontal (se inclina hacia adelante/atrás).', when: 'Para un efecto de tarjeta que se voltea hacia el lector.' },
      { name: 'rotateY', desc: 'Gira en 3D sobre el eje vertical (se inclina a izquierda/derecha).', when: 'Para que algo "abra" como una puerta o se voltee de lado.' },
    ],
  },
  {
    group: 'Tamaño y deformación',
    items: [
      { name: 'scale', desc: 'Agranda o achica el elemento. Es un MULTIPLICADOR de su tamaño (su caja): 1 = tamaño normal, 0,5 = la mitad, 2 = el doble, 0 = desaparece. Crece/encoge tomando como punto fijo el anchor.', when: 'Para que una imagen crezca suavemente al entrar: ej. Desde 0,8 Hasta 1. Evita Desde 0 o Hasta 2: son saltos enormes (de invisible al doble).' },
      { name: 'skew', desc: 'Inclina/sesga el elemento (en grados), como un paralelogramo.', when: 'Para un toque dinámico o de movimiento en textos y formas.' },
    ],
  },
  {
    group: 'Efectos',
    items: [
      { name: 'blur', desc: 'Pasa de borroso a nítido (o al revés). "Desde/Hasta" en píxeles.', when: 'Para que una imagen entre enfocándose, como una cámara que ajusta el foco.' },
      { name: 'clipPath', desc: 'Revela el elemento descubriéndolo progresivamente (de 0 a 100).', when: 'Para que un texto o imagen se "destape" como una cortina al aparecer.' },
    ],
  },
]

// TRIGGERS — what makes the animation play.
const TRIGGERS: Entry[] = [
  { name: 'enter', desc: 'Va por TIEMPO: cuando el elemento entra en pantalla reproduce la animación completa de "Desde" a "Hasta" UNA vez (durante "Duración"). SIEMPRE arranca en el valor "Desde".', when: 'Lo más común y predecible. Si quieres que algo "nazca" desde un valor (ej. scale 0,8→1, o translateY 30→0), usa enter.' },
  { name: 'scroll', desc: 'Va por POSICIÓN DE SCROLL, no por tiempo: el valor va de "Desde" a "Hasta" según cuánto avanzaste por la sección (0% cuando entra, 100% cuando sale). ⚠️ Si la sección ya está en pantalla al cargar (p. ej. la PRIMERA, muy alta), el scroll arranca a MITAD → puede que NUNCA veas el valor "Desde" (por eso un scale 0→2 se ve grande de entrada y no "nace" desde 0).', when: 'Para efectos atados al scroll (algo que se mueve mientras bajas). Si necesitas que siempre arranque en "Desde", usa enter.' },
  { name: 'loop', desc: 'Se repite en bucle sin parar. Puedes activar "Yoyo" para que vaya y vuelva.', when: 'Para una pulsación, un flotar suave o un brillo que late de forma continua.' },
  { name: 'mouse', desc: 'Reacciona al movimiento del mouse.', when: 'Para un detalle interactivo en pantallas grandes (un elemento que sigue o reacciona al cursor).' },
  { name: 'gyroscope', desc: 'En el celular, reacciona al inclinar el teléfono (sensores de movimiento).', when: 'Para que la experiencia en móvil se sienta viva al mover el dispositivo.' },
  { name: 'hover', desc: 'Se reproduce al pasar el mouse por encima del elemento.', when: 'Para resaltar un botón, una imagen o una tarjeta cuando la persona la apunta.' },
  { name: 'click', desc: 'Se reproduce al hacer click sobre el elemento.', when: 'Para dar respuesta visual a un toque o click (un botón que reacciona).' },
  { name: 'depends', desc: 'Se dispara por una interacción sobre OTRO elemento (eliges cuál y qué evento: hover, click o enter).', when: 'Para encadenar: por ejemplo, una imagen se anima cuando pasas el mouse sobre un título.' },
]

// EASING — la "sensación" del movimiento (cómo arranca y frena), agrupado.
const EASING_GROUPS: { group: string; items: Entry[] }[] = [
  {
    group: 'Básicas',
    items: [
      { name: 'linear', desc: 'Velocidad constante, sin acelerar ni frenar. Se siente mecánico.', when: 'Para bucles continuos (un giro o flotar que no debe "respirar").' },
      { name: 'easeIn', desc: 'Arranca lento y acelera. Como si tomara impulso.', when: 'Para salidas: algo que se va ganando velocidad al desaparecer.' },
      { name: 'easeOut', desc: 'Arranca rápido y frena suave. La más natural.', when: 'Para entradas de elementos (lo que aparece en pantalla).' },
      { name: 'easeInOut', desc: 'Suave al inicio y al final. La más equilibrada.', when: 'Lo más seguro para casi todo, sobre todo movimientos continuos.' },
    ],
  },
  {
    group: 'Más marcadas (frenado fuerte)',
    items: [
      { name: 'easeOutCubic / Quart / Quint', desc: 'Variantes de easeOut cada vez más pronunciadas: frenan más fuerte al final (Quint es la más dramática).', when: 'Para entradas con más carácter; Quart/Quint para efectos llamativos.' },
      { name: 'easeInCubic / Quart / Quint', desc: 'Igual pero acelerando al arrancar, cada vez más marcado.', when: 'Para salidas con énfasis.' },
      { name: 'easeInOutCubic / Quart / Quint', desc: 'Suaves a ambos lados pero más pronunciadas que easeInOut.', when: 'Para movimientos elegantes con un punto extra de dramatismo.' },
    ],
  },
]

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}
onMounted(() => {
  document.addEventListener('keydown', onKey, true)
  // Opened from "Ver guía de easing" → jump straight to the Easing section.
  if (props.focusSection === 'easing') {
    nextTick(() => easingRef.value?.scrollIntoView({ block: 'start' }))
  }
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-help-backdrop"
      data-test="anim-help-modal"
      @click.self="emit('close')"
    >
      <div class="anim-help-modal" role="dialog" aria-label="Guía de animaciones">
        <header class="ahm-head">
          <h2 class="ahm-title">Guía de animaciones</h2>
          <button
            class="ahm-close"
            data-test="anim-help-close"
            aria-label="Cerrar"
            @click="emit('close')"
          >&times;</button>
        </header>

        <div class="ahm-body" data-test="anim-help-body" :ref="panelScrollRef">
          <p class="ahm-intro">
            Una animación tiene dos partes: <strong>el tipo</strong> (qué efecto se
            ve) y <strong>el disparador</strong> (cuándo se reproduce). Elige uno
            de cada uno.
          </p>

          <p class="ahm-note" data-test="ahm-edit-vs-preview">
            <strong>Edición vs. Preview:</strong> en <strong>Edición</strong> la
            mesa muestra cada elemento en su <strong>tamaño y posición reales</strong>
            (sin movimiento) para que puedas ubicarlo bien — solo
            <em>aparecer/opacidad</em> se ve ya resuelto. Los movimientos (escalar,
            deslizar, girar…) <strong>se ven recién en Preview</strong> o publicado.
            Por eso una imagen con <code class="ahm-name">scale</code> «Hasta 2» se
            ve normal en Edición y al <strong>doble</strong> en Preview: no es un error.
          </p>

          <p class="ahm-note" data-test="ahm-anchor">
            <strong>El anchor (punto de anclaje):</strong> es el punto del elemento
            que se coloca en su <strong>posición</strong> y, además, el
            <strong>punto fijo</strong> alrededor del cual <strong>gira y escala</strong>.
            Con anchor <em>centro</em>, al escalar crece desde el centro (hacia todos
            lados); con <em>arriba-izquierda</em>, crece hacia abajo-derecha. El
            <code class="ahm-name">translate</code> NO depende del anchor (mueve toda
            la caja). El anchor se elige en las <strong>propiedades del elemento</strong>,
            no aquí.
          </p>

          <h3 class="ahm-section">Tipos de animación</h3>
          <p class="ahm-section-sub">Qué efecto visual se aplica.</p>
          <div
            v-for="g in TYPE_GROUPS"
            :key="g.group"
            class="ahm-group"
          >
            <div class="ahm-group-name">{{ g.group }}</div>
            <div
              v-for="it in g.items"
              :key="it.name"
              class="ahm-card"
            >
              <code class="ahm-name">{{ it.name }}</code>
              <p class="ahm-desc">{{ it.desc }}</p>
              <p class="ahm-when"><span class="ahm-when-tag">cuándo usarlo</span>{{ it.when }}</p>
            </div>
          </div>

          <h3 class="ahm-section">Disparadores</h3>
          <p class="ahm-section-sub">Qué hace que la animación se reproduzca.</p>
          <div
            v-for="t in TRIGGERS"
            :key="t.name"
            class="ahm-card"
          >
            <code class="ahm-name">{{ t.name }}</code>
            <p class="ahm-desc">{{ t.desc }}</p>
            <p class="ahm-when"><span class="ahm-when-tag">cuándo usarlo</span>{{ t.when }}</p>
          </div>

          <h3 ref="easingRef" class="ahm-section" data-test="ahm-easing">Easing (curva de aceleración)</h3>
          <p class="ahm-section-sub">
            Define la <strong>sensación</strong> del movimiento: si arranca o
            frena de golpe o con suavidad. Cambia mucho cómo se percibe la
            animación aunque dure lo mismo.
          </p>
          <div
            v-for="g in EASING_GROUPS"
            :key="g.group"
            class="ahm-group"
          >
            <div class="ahm-group-name">{{ g.group }}</div>
            <div
              v-for="it in g.items"
              :key="it.name"
              class="ahm-card"
            >
              <code class="ahm-name">{{ it.name }}</code>
              <p class="ahm-desc">{{ it.desc }}</p>
              <p class="ahm-when"><span class="ahm-when-tag">cuándo usarlo</span>{{ it.when }}</p>
            </div>
          </div>
          <p class="ahm-intro" style="margin-top:14px">
            <strong>Si dudas:</strong> usa <code class="ahm-name">easeOut</code>
            para que algo aparezca y <code class="ahm-name">easeInOut</code> para
            movimientos continuos. Reserva Quart/Quint para efectos llamativos.
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.anim-help-backdrop {
  position: fixed; inset: 0; z-index: 100001;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.anim-help-modal {
  width: min(560px, 92vw); max-height: 86vh;
  display: flex; flex-direction: column;
  background: #1b1b1b; border: 1px solid #3a3a3a; border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65);
  color: #e6e6e6; overflow: hidden;
}
.ahm-head {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid #333;
}
.ahm-title { margin: 0; font-size: 16px; font-weight: 700; color: #fff; }
.ahm-close {
  background: none; border: none; color: #999; font-size: 24px; line-height: 1;
  cursor: pointer; padding: 0 4px; border-radius: 4px;
}
.ahm-close:hover { color: #fff; background: #ffffff14; }

.ahm-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  padding: 16px 18px 20px; font-size: 12.5px; line-height: 1.5;
  overscroll-behavior: contain;
}
.ahm-intro { margin: 0 0 14px; color: #cfcfcf; }
.ahm-intro strong { color: #fff; }
/* Callout Edición-vs-Preview: por qué un movimiento no se ve en la mesa. */
.ahm-note {
  margin: 0 0 14px; padding: 9px 11px;
  background: #1b2a3a; border: 1px solid #2d5a8c; border-left: 3px solid #4a90d9;
  border-radius: 6px; color: #cfe0f2; font-size: 12.5px; line-height: 1.5;
}
.ahm-note strong { color: #fff; }
.ahm-note code { color: #ffd9a0; }

.ahm-section {
  margin: 18px 0 2px; font-size: 14px; font-weight: 700; color: var(--accent-strong);
  padding-top: 12px; border-top: 1px solid #2e2e2e;
}
.ahm-section:first-of-type { border-top: none; padding-top: 0; margin-top: 4px; }
.ahm-section-sub { margin: 0 0 10px; font-size: 11px; color: #888; }

.ahm-group { margin-bottom: 12px; }
.ahm-group-name {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  color: #9a9a9a; margin: 8px 0 5px;
}
.ahm-card {
  background: #232323; border: 1px solid #333; border-radius: 7px;
  padding: 8px 10px; margin: 6px 0;
}
.ahm-name {
  display: inline-block; background: #14233a; color: #8fc4ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; font-weight: 600; padding: 2px 7px; border-radius: 4px;
}
.ahm-desc { margin: 6px 0 0; color: #d6d6d6; }
.ahm-when {
  margin: 6px 0 0; color: #cfe2ff; font-size: 11.5px;
}
.ahm-when-tag {
  display: inline-block; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.06em; color: #7fb3ff;
  margin-right: 6px;
}
</style>
