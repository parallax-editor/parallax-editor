<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import {
  state,
  getSelected,
  setAtPath,
  getAtPath,
  addAnimation,
  removeAnimation,
  selectedGlobal,
  ensureTheme,
  setCursorEnabled,
  updateCursor,
  getComponentRegistration,
} from '../../stores/editor'
import { ANCHOR_TYPES, SCROLL_BEHAVIORS, SCROLL_DIRECTIONS, PARALLAX_MODES, SEMANTIC_TAGS, SPLIT_MODES, TEXT_ALIGN, WHITE_SPACE, TRIGGER_TYPES, ANIMATION_TYPES, EASING_PRESETS, TRANSITION_TYPES } from '@parallax-editor/parallax-engine/schema'
import { projectsApi, workspaceApi } from '../../composables/useApi'
import type { UploadKind, ProjectAsset, ProjectListItem } from '../../composables/useApi'
import { usePanelScroll } from '../../composables/usePanelScroll'
import { useI18n } from 'vue-i18n'
import PropField from './PropField.vue'
import FontSizeField from './FontSizeField.vue'
import HelpHint from './HelpHint.vue'
import FormColorField from './FormColorField.vue'
import ComponentPropsEditor from './ComponentPropsEditor.vue'
import ResourcesPanel from './ResourcesPanel.vue'
import ResourceCombobox from './ResourceCombobox.vue'
import type { ComboOption } from './ResourceCombobox.vue'
import { fileToFontFamily } from '../../composables/fontName'
import NumberSlider from './NumberSlider.vue'
import RangeSlider from './RangeSlider.vue'
import BlendSelect from './BlendSelect.vue'
import GradientBuilder from './GradientBuilder.vue'
import AnimationsHelpModal from './AnimationsHelpModal.vue'
import SizeField from './SizeField.vue'

const { t } = useI18n()

// Plain-Spanish, non-technical help copy shown by the per-control "?" button.
// Routed through i18n so tooltips reflect the active locale.
// HELP_KEYS lists every help-tooltip key in a stable order. The actual
// Spanish/English text lives in `src/locales/{es,en}.ts` under the `help`
// namespace; the computed below resolves each key through `t()`, so flipping
// the locale at runtime re-renders every tooltip without remounting the panel.
const HELP_KEYS = [
  'sectionId', 'sectionHeight', 'sectionScroll', 'sectionScrollDir',
  'sectionBgType', 'sectionBgColor', 'sectionBgGradient', 'sectionBgImage',
  'sectionTransIn', 'sectionTransOut', 'sectionTransDur',
  'layerId', 'depth', 'blur', 'layerOpacity', 'perspective3d', 'blend',
  'parallaxScrollVertical', 'parallaxScrollHorizontal', 'parallaxMouse', 'parallaxGyroscope', 'parallaxTilt',
  'elementId', 'posX', 'posY', 'width', 'height', 'anchor', 'opacity', 'rotation',
  'flipX', 'flipY', 'objectFit',
  'visible', 'sectionVisible', 'layerVisible',
  'gifAutoplay', 'gifLoop', 'gifPauseOnHover', 'gifPlayDurationMs',
  'interactive', 'src', 'alt',
  'videoSrc', 'audioSrc', 'mediaAutoplay', 'mediaMuted', 'mediaLoop', 'mediaControls', 'mediaVolume',
  'videoPoster', 'videoPlaysinline',
  'content', 'font', 'fontSize', 'fontWeight', 'color',
  'textAlign', 'whiteSpace', 'letterSpacing', 'lineHeight', 'semanticTag', 'splitMode', 'stagger',
  'linkUrl', 'linkTarget', 'linkMode', 'linkSite',
  'animType', 'animTrigger', 'animFrom', 'animTo', 'animRange', 'animDuration', 'animDelay',
  'animEasing', 'animEasingShort', 'animLoop', 'animYoyo', 'animDependsOn', 'animDependsEvent',
  'formWebhook', 'formSubmit', 'formSuccess', 'formError', 'formHoneypot',
  'formInputBg', 'formInputText', 'formInputBorder', 'formButtonBg', 'formButtonText',
  'formFont', 'formFieldName', 'formFieldLabel', 'formFieldType', 'formFieldRequired',
  'formFieldOptions', 'formFieldMin', 'formFieldMax',
  'metaTitle', 'metaDescription', 'metaLang', 'metaOgImage', 'metaFavicon',
  'metaTransIn', 'metaTransOut', 'metaTransDur',
  'cursorEnabled', 'cursorColor', 'cursorSize', 'cursorBlend',
  'fontFamily', 'fontSource', 'fontUrl',
  'themeInk', 'themePaper', 'themeAccent', 'themeDisplay', 'themeBody',
] as const
const HELP = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const k of HELP_KEYS) map[k] = t(`help.${k}`)
  return map
})

// Below was the legacy static HELP map (Spanish literals); kept inert as a
// no-op object so the rest of the file's line numbers / git history stay
// readable, but routed through HELP above (which goes via `t('help.*')`).
const _LEGACY_HELP_TEXTS = {
  __unused__: '',
  sectionTransIn: 'Efecto con el que ENTRA esta sección al aparecer. Déjalo en "(ninguna)" para sin transición.',
  sectionTransOut: 'Efecto con el que SALE esta sección al pasar a la siguiente. Déjalo en "(ninguna)" para sin transición.',
  sectionTransDur: 'Cuánto dura la transición de entrada/salida de la sección, en milisegundos. 800 = 0,8 segundos.',
  layerId: 'Nombre interno de esta capa.',
  depth: 'La **profundidad** decide qué tan rápido se mueve esta capa frente a las demás, dándole sensación de cercanía o lejanía.\n\n- **0** = la capa queda quieta (pegada al contenido normal).\n- **Positivo** (hasta 1) = se mueve más despacio, como si estuviera al **fondo**.\n- **Negativo** (hasta -1) = se mueve más rápido, como si estuviera al **frente**.\n\nSolo tiene efecto si activaste algún modo de parallax abajo (scroll, mouse, etc.). A más diferencia de profundidad entre capas, más sensación de 3D.\n\n» Pon el fondo en un valor positivo (ej. 0,3) y el frente en negativo (ej. -0,3) para un efecto de profundidad marcado.',
  blur: 'Desenfoque de toda la capa. 0 = nítido; más alto = más borroso (útil para fondos).',
  layerOpacity: 'Transparencia de toda la capa. 1 = visible; 0 = invisible.',
  perspective3d: 'Activa un efecto de **profundidad 3D real**: las capas con distinta profundidad se inclinan en perspectiva, no solo se desplazan.\n\n» Úsalo en escenas con varias capas (fondo, medio, frente) cuando quieras una sensación de volumen tipo maqueta. Suele combinarse con el modo **Tilt 3D**.',
  blend: 'El **modo de fusión** decide cómo se mezclan los colores de esta capa con lo que tiene debajo. Por defecto la capa simplemente tapa lo de atrás; otros modos la combinan para crear luces, sombras o contraste.\n\nAgrupados por efecto:\n\n- **Oscurecer** — *Multiplicar* y *Oscurecer*: dejan pasar lo oscuro y quitan lo claro. Buenos para **sombras** o integrar una textura sobre un fondo claro.\n- **Aclarar** — *Pantalla* y *Aclarar*: dejan pasar lo claro y quitan lo oscuro. Buenos para **luces, brillos, humo o destellos** sobre fondos oscuros.\n- **Contraste** — *Superposición*: combina los dos anteriores; oscurece lo oscuro y aclara lo claro, subiendo el **contraste y la saturación**.\n- **Color** — *Tono, Saturación, Color, Luminosidad*: mezclan solo una parte del color (útil para teñir o virar tonos).\n- **Especiales** — *Diferencia, Exclusión, Sobre/Subexponer*: efectos fuertes y creativos.\n\n» Si no sabes cuál usar, deja **Normal**. Para una textura o foto que se funda con el fondo, prueba **Multiplicar** (fondo claro) o **Pantalla** (fondo oscuro).',
  // Per-mode parallax help (item #2). Each checkbox gets its own "?" so the user
  // knows what it does AND when to use it.
  parallaxScrollVertical: '**Scroll vertical**: la capa se desplaza a distinta velocidad cuando se hace scroll hacia abajo (según su **profundidad**).\n\n» Úsalo para dar profundidad entre fondo y frente: el fondo se mueve lento y el primer plano rápido, como mirar por la ventanilla de un auto.',
  parallaxScrollHorizontal: '**Scroll horizontal**: igual que el vertical, pero el desplazamiento es de lado.\n\n» Úsalo en secciones que avanzan horizontalmente (galerías o tiras de imágenes que se recorren hacia los lados).',
  parallaxMouse: '**Mouse**: la capa se mueve suavemente siguiendo el movimiento del puntero.\n\n» Úsalo para un detalle interactivo y elegante en pantallas grandes: el fondo o un elemento reacciona cuando la persona mueve el mouse. (En celular no hay mouse, así que no se nota).',
  parallaxGyroscope: '**Giroscopio**: en el celular, la capa se mueve al inclinar el teléfono (usa los sensores del dispositivo).\n\n» Úsalo para que la experiencia en móvil se sienta viva: el fondo se desplaza al mover el teléfono. Pídele permiso de movimiento al navegador.',
  parallaxTilt: '**Tilt 3D**: la capa se inclina en perspectiva al mover el mouse o el teléfono, no solo se desplaza.\n\n» Úsalo junto con la opción **3D** de abajo para escenas con volumen, como una tarjeta o maqueta que se inclina hacia donde apunta el cursor.',
  elementId: 'Nombre interno de este elemento.',
  posX: 'Posición horizontal, en porcentaje del ancho. 0 = pegado a la izquierda, 50 = centro, 100 = derecha.',
  posY: 'Posición vertical, en porcentaje del alto. 0 = arriba, 50 = centro, 100 = abajo.',
  width: 'Elige cómo se mide el **ancho** del elemento:\n\n- **Fijo (px)**: un tamaño exacto en píxeles; no cambia con la pantalla.\n- **Porcentual (%)**: relativo al ancho disponible; crece y encoge con la pantalla.\n- **Adaptable**: crece con la pantalla pero **nunca pasa de** un máximo en px (el menor entre el % y ese tope).\n- **Auto**: usa el tamaño natural del elemento.\n\n» Para fotos que deben verse bien en móvil y escritorio, usa **Adaptable** (ej. 46% pero máximo 520 px).',
  height: 'Elige cómo se mide el **alto** del elemento:\n\n- **Fijo (px)**: un alto exacto en píxeles.\n- **Porcentual (%)**: relativo al alto disponible; se adapta a la pantalla.\n- **Adaptable**: crece con la pantalla pero **nunca pasa de** un máximo en px.\n- **Auto**: usa el alto natural del elemento.\n\n» En la mayoría de imágenes conviene dejar el alto en **Auto** y controlar solo el ancho, para que no se deformen.',
  anchor: 'Punto de anclaje del elemento: el punto que se coloca en la **posición** elegida (centro, esquina, etc.) — p. ej. con *centro*, la posición marca el centro del elemento; con *arriba-izquierda*, marca su esquina superior izquierda.\n\n» También es el **punto fijo** alrededor del cual el elemento **gira y escala**: con anchor *centro* una imagen crece desde el centro (hacia todos lados); con *arriba-izquierda* crece hacia abajo-derecha.',
  opacity: 'Transparencia del elemento. 1 = totalmente visible; 0 = invisible.',
  rotation: 'Giro del elemento en grados. 0 = derecho; 90 = de costado.',
  flipX: 'Voltea la imagen en espejo horizontal (izquierda↔derecha).',
  flipY: 'Voltea la imagen en espejo vertical (arriba↔abajo).',
  objectFit: 'Cómo rellena la imagen su caja (cuando le pones un tamaño). "Llenar" la encaja recortando lo que sobra (sin deformar). "Encajar completa" la muestra entera (puede dejar espacio). "Estirar" la deforma para llenar exacto. "Natural" usa su tamaño real. Si no estás seguro, deja "Llenar".',
  visible: 'Si está desactivado, el elemento no se muestra en el sitio publicado. Lo sigues viendo aquí en el editor para activarlo de nuevo cuando quieras.',
  sectionVisible: 'Si está desactivado, esta sección entera se oculta en el sitio publicado (no aparece en el flujo de scroll). Sigue editable aquí.',
  layerVisible: 'Si está desactivado, esta capa (con todos sus elementos) se oculta en el sitio publicado. Sigue editable aquí.',
  gifAutoplay: 'Si está activo, el GIF empieza a animarse al cargar. Si está desactivado, se queda en el primer cuadro (foto estática).',
  gifLoop: 'Si está activo, el GIF se repite indefinidamente (depende del archivo). Si está desactivado, el motor lo congela tras la duración indicada.',
  gifPauseOnHover: 'Cuando el cursor entra al GIF, se congela en el cuadro actual; al salir, vuelve a animarse desde el comienzo.',
  gifPlayDurationMs: 'Duración aproximada de UNA reproducción en milisegundos. Solo se usa cuando "Loop" está desactivado: el motor congela el GIF tras este tiempo. Déjalo en 0 para el valor por defecto (2500 ms).',
  interactive: 'Permite que el elemento responda al mouse (clicks, hover).',
  src: 'Ruta del archivo de imagen. Normalmente se llena solo al cargar una imagen.',
  alt: 'Texto descriptivo de la imagen para accesibilidad y buscadores.',
  videoSrc: 'Ruta del archivo de video. Normalmente se llena solo al cargar un video.',
  audioSrc: 'Ruta del archivo de audio. Normalmente se llena solo al cargar un audio.',
  mediaAutoplay: 'Reproduce automáticamente al cargar. (El navegador suele exigir que esté en silencio).',
  mediaMuted: 'Inicia sin sonido.',
  mediaLoop: 'Vuelve a empezar automáticamente al terminar.',
  mediaControls: 'Muestra los controles de reproducción (play, volumen, etc.).',
  mediaVolume: 'Volumen inicial del audio/video, de 0% (sin sonido) a 100% (máximo).',
  videoPoster: 'Imagen de portada que se ve antes de que empiece a reproducirse el video.',
  videoPlaysinline: 'Permite que el video se reproduzca embebido (sin pantalla completa) en celulares.',
  content: 'El texto que se muestra. Puedes escribir varias líneas.',
  font: 'Tipografía del texto. Déjalo vacío para usar la del sitio.',
  fontSize: 'Tamaño del texto. Usa los botones (Pequeño/Mediano/Grande/Título) o ajusta el número. El texto se adapta solo en móvil.',
  fontWeight: 'Grosor del texto. 400 = normal, 700 = negrita.',
  color: 'Color del texto.',
  textAlign: 'Alineación del texto: a la izquierda, centrado, a la derecha o justificado. Déjalo en "(heredado)" para usar la alineación que ya trae el texto.',
  whiteSpace: 'Cómo se manejan los espacios y saltos de línea. Por defecto "pre-wrap" preserva múltiples espacios y saltos tal como los escribes. Cámbialo si necesitas comportamiento clásico HTML (normal) o un único renglón (nowrap).',
  letterSpacing: 'Espacio entre letras. Escríbelo con su unidad, por ejemplo "0.05em" o "1px". Déjalo vacío para el espaciado normal.',
  lineHeight: 'Altura de línea: separación vertical entre renglones. Un número como "1.4" funciona bien; también puedes usar una medida como "24px". Déjalo vacío para la separación normal.',
  semanticTag: 'Rol del texto en la página (título, párrafo…). Afecta accesibilidad y SEO, no el tamaño.',
  splitMode: 'Cómo se anima el texto al aparecer: por letras, por palabras o completo.',
  stagger: 'Retraso entre cada letra/palabra al animar (en segundos). 0 = todas a la vez.',
  linkUrl: 'Si pones una dirección, el elemento se vuelve un enlace al hacer click.',
  linkTarget: 'Dónde se abre el enlace: en una pestaña nueva o en la misma.',
  linkMode: 'Qué hace el elemento al hacer click: "Ninguno" no es un enlace, "URL" abre una dirección externa, y "Sitio" navega a otro proyecto del mismo espacio de trabajo sin recargar la página.',
  linkSite: 'Otro proyecto de este espacio de trabajo al que se navega al hacer click. La transición ocurre dentro de la misma página.',
  animType: 'Qué efecto se aplica: **aparecer** (fadeIn/opacity), **deslizar** (translateX/Y), **escalar** (scale), **girar** (rotate), **desenfocar** (blur), inclinar (skew), revelar (clipPath).\n\n» **Importante — por qué se ve distinto en Edición y en Preview:** en **Edición** la mesa muestra cada elemento en su **estado base** (tamaño y posición reales, sin movimiento) para que puedas ubicarlo bien; solo *aparecer/opacidad* se muestra ya resuelto. Los movimientos (escalar, deslizar, girar…) **se ven recién en Preview** o publicado. Por eso una imagen con `scale Hasta 2` se ve normal en Edición y al **doble** en Preview — no es un error.',
  animTrigger: 'Cuándo se dispara la animación (al entrar en pantalla, al hacer scroll, al pasar el mouse…).',
  animFrom: 'Valor **inicial** del efecto. Qué significa depende del **Tipo**:\n\n- **fadeIn/fadeOut, opacity** → 0 (invisible) a 1 (visible).\n- **scale** → multiplica el tamaño del elemento (su caja). **1 = tamaño normal**, 0.5 = mitad, **2 = el doble**, **0 = desaparece**. Escala tomando como punto fijo el **anchor**.\n- **translateX/translateY** → desplazamiento en **píxeles** desde su posición actual. **0 = en su sitio**; X positivo = derecha, Y positivo = abajo; negativos = izquierda/arriba.\n- **rotate/rotateX/rotateY, skew** → grados (gira/inclina alrededor del **anchor**).\n- **blur** → píxeles de desenfoque. **clipPath** → 0 a 100 (% revelado).\n\n» Ej.: para que una imagen *aparezca creciendo* usa **scale** Desde **0.8** Hasta **1**. Un `scale` Desde 0 ó Hasta 2 son cambios MUY grandes (desaparece / doble).',
  animTo: 'Valor **final** del efecto — al terminar la animación (o al final del tramo de scroll). Mismo significado que **Desde** según el Tipo (mira la ayuda de *Desde*).\n\n» Ej.: **scale** Desde 1 Hasta 1.2 = crece 20%; **translateY** Desde 0 Hasta −40 = sube 40 px; **rotate** Desde −5 Hasta 0 = endereza desde −5°.',
  animRange: '0% = inicio de la sección, 100% = fin. La animación interpola entre los valores Desde y Hasta del tipo durante ese tramo del scroll.',
  animDuration: 'Cuánto dura la animación, en milisegundos. 1000 = 1 segundo.',
  animDelay: 'Cuánto espera antes de empezar, en milisegundos.',
  animEasing: 'El **easing** define la *sensación* del movimiento: si arranca o frena de golpe o con suavidad. Cambia mucho cómo se percibe la animación aunque dure lo mismo.\n\n- **linear**: velocidad constante, sin acelerar ni frenar. Mecánico; bueno para bucles continuos.\n- **easeIn**: arranca lento y acelera. Se siente como si tomara impulso; útil para salidas.\n- **easeOut**: arranca rápido y frena suave. Natural para **entradas** de elementos.\n- **easeInOut**: suave al inicio y al final. El más equilibrado y seguro para casi todo.\n- **easeOutCubic / Quart / Quint**: variantes de easeOut cada vez más marcadas (frenan más fuerte al final). Cuanto más alto, más dramático el frenado.\n- **easeInCubic / Quart / Quint**: igual pero acelerando al arrancar.\n- **easeInOutCubic / Quart / Quint**: suaves a ambos lados, más pronunciadas que easeInOut.\n\n» Si dudas, usa **easeOut** para que algo aparezca y **easeInOut** para movimientos continuos. Reserva las versiones Quart/Quint para efectos llamativos.',
  animEasingShort: 'La **curva de aceleración**: cómo arranca y frena el movimiento (de golpe o suave). Toca **«Ver guía»** para ver cada opción en detalle.',
  animLoop: 'Repite la animación en bucle.',
  animYoyo: 'Hace que la animación vaya y vuelva (ida y vuelta) en cada repetición.',
  animDependsOn: 'ID del OTRO elemento que dispara esta animación al recibir el evento elegido. Por ejemplo, una imagen puede animarse cuando se pasa el mouse sobre un título.',
  animDependsEvent: 'Qué interacción sobre el OTRO elemento dispara esta animación: pasar el mouse (hover), hacer click (click) o entrar en pantalla (enter).',
  // FormBlock
  formWebhook: 'Dirección a donde se envían las respuestas del formulario (por ejemplo un webhook de Make o Zapier). Déjalo vacío mientras no lo tengas.',
  formSubmit: 'Texto del botón para enviar el formulario (ej. "Confirmar").',
  formSuccess: 'Mensaje que se muestra cuando alguien envía el formulario correctamente.',
  formError: 'Mensaje que se muestra si el envío falla.',
  formHoneypot: 'Campo trampa anti-spam, invisible para las personas. Déjalo así salvo que sepas lo que haces.',
  formInputBg: 'Color de fondo de las casillas donde se escribe.',
  formInputText: 'Color del texto que la persona escribe dentro de las casillas.',
  formInputBorder: 'Color del borde de las casillas.',
  formButtonBg: 'Color de fondo del botón de enviar.',
  formButtonText: 'Color del texto del botón de enviar.',
  formFont: 'Tipografía del formulario. Déjalo vacío para usar la del sitio.',
  formFieldName: 'Nombre interno del campo (sin acentos ni espacios). Es el que llega en la respuesta.',
  formFieldLabel: 'Texto visible que se le muestra a la persona sobre este campo.',
  formFieldType: 'Qué tipo de dato pide este campo (texto, email, teléfono, lista de opciones, etc.).',
  formFieldRequired: 'Si está activado, la persona está obligada a llenar este campo.',
  formFieldOptions: 'Opciones disponibles cuando el campo es lista, opción única o casillas. Una por línea.',
  formFieldMin: 'Valor mínimo permitido (solo para campos numéricos).',
  formFieldMax: 'Valor máximo permitido (solo para campos numéricos).',
  // ── Sitio (meta) ──
  metaTitle: 'Título del sitio. Aparece en la pestaña del navegador y al compartir el enlace.',
  metaDescription: 'Descripción breve del sitio. Se usa al compartir el enlace y para buscadores.',
  metaLang: 'Idioma principal del sitio (código corto): "es" español, "en" inglés. Afecta accesibilidad y SEO.',
  metaOgImage: 'Imagen que se ve al compartir el enlace en redes (1200×630). Ruta dentro de la carpeta del proyecto, ej. "images/og-image.png".',
  metaFavicon: 'Ícono pequeño que se ve en la pestaña del navegador. Ruta dentro de la carpeta del proyecto.',
  metaTransIn: 'Efecto con el que ENTRA el sitio/mundo al cargar. Déjalo en "(ninguno)" para sin transición.',
  metaTransOut: 'Efecto con el que SALE el sitio/mundo al navegar fuera. Déjalo en "(ninguno)" para sin transición.',
  metaTransDur: 'Cuánto dura la transición de entrada/salida, en milisegundos. 800 = 0,8 segundos.',
  cursorEnabled: 'Reemplaza el puntero del mouse por un círculo que lo sigue suavemente por todo el sitio. Da un toque elegante e interactivo.',
  cursorColor: 'Color del círculo que sigue al puntero.',
  cursorSize: 'Tamaño (diámetro) del círculo en píxeles. 20 es un buen punto de partida.',
  cursorBlend: 'Cómo se mezcla el círculo con lo que hay debajo. "difference" invierte los colores (se ve bien sobre fondos variados); "normal" lo deja tal cual.',
  fontFamily: 'Nombre de la tipografía tal como se llama (ej. "Playfair Display", "Lato").',
  fontSource: '"Google" la descarga de Google Fonts automáticamente. "Personalizada" usa un archivo propio (indica la URL).',
  fontUrl: 'Dirección del archivo de la fuente (solo para fuentes personalizadas). Déjalo vacío para Google Fonts.',
  // ── Tema (theme) ──
  themeInk: 'Color principal de texto (la "tinta"). Suele ser un tono oscuro.',
  themePaper: 'Color de fondo del sitio (el "papel"). Suele ser un tono claro.',
  themeAccent: 'Color de acento: botones, detalles y enlaces destacados.',
  themeDisplay: 'Tipografía de los títulos. Escribe el nombre de la fuente (ej. "Playfair Display, serif").',
  themeBody: 'Tipografía del texto general. Escribe el nombre de la fuente (ej. "Lato, sans-serif").',
}
void _LEGACY_HELP_TEXTS

// ── Sitio (meta) + Tema (theme): top-level, view-agnostic config ─────────────
//
// These edit `site.meta.*` / `site.theme.*` through the SAME store get/set
// path (undo + dirty). getAtPath/setAtPath pass non-"sections" paths through
// verbatim and never rebase to a desktop/mobile view → meta/theme are shared
// regardless of independent-views mode (exactly the engine contract).

const TRANSITION_OPTS = computed(() => [
  { value: '', label: t('selects.transition.none') },
  ...TRANSITION_TYPES.map((v) => ({ value: v, label: v })),
])
// Same option set for section.transition, but the "(ninguna)" label reads
// naturally for "transición" (feminine) per the spec copy.
const SECTION_TRANSITION_OPTS = computed(() => [
  { value: '', label: t('selects.sectionTransition.none') },
  ...TRANSITION_TYPES.map((v) => ({ value: v, label: v })),
])
const FONT_SOURCE_OPTS = ['google', 'custom']
// Modo de relleno de la imagen (CSS object-fit) con etiquetas amigables.
const OBJECT_FIT_OPTS = computed(() => [
  { value: 'cover', label: t('selects.objectFit.cover') },
  { value: 'contain', label: t('selects.objectFit.contain') },
  { value: 'fill', label: t('selects.objectFit.fill') },
  { value: 'none', label: t('selects.objectFit.none') },
  { value: 'scale-down', label: t('selects.objectFit.scale-down') },
])

const meta = computed<any>(() => (state.site as any)?.meta || {})
const theme = computed<any>(() => (state.site as any)?.theme || null)

// ── Cursor (top-level, view-agnostic) ───────────────────────────────────────
// `cursor` is absent on legacy sites until the user enables it (additive).
// `cursor` reads the live object (null when absent); `cursorOn` is the toggle
// model; the color/size/blend controls only render when it's enabled.
const cursor = computed<any>(() => (state.site as any)?.cursor || null)
const cursorOn = computed<boolean>(() => !!cursor.value?.enabled)
const CURSOR_BLEND_OPTS = computed(() => [
  { value: 'normal', label: t('selects.cursorBlend.normal') },
  { value: 'difference', label: t('selects.cursorBlend.difference') },
  { value: 'multiply', label: t('selects.cursorBlend.multiply') },
  { value: 'screen', label: t('selects.cursorBlend.screen') },
  { value: 'overlay', label: t('selects.cursorBlend.overlay') },
  { value: 'exclusion', label: t('selects.cursorBlend.exclusion') },
])
function onCursorEnabledChange(e: Event) {
  setCursorEnabled((e.target as HTMLInputElement).checked)
}

// Write a meta field. setAtPath records undo + marks dirty; `meta` always
// exists in a valid site (schema requires it).
function updateMeta(key: string, value: any) {
  setAtPath(`meta.${key}`, value)
}

// meta.transition is optional ({in?, out?, duration?}). Write only when at
// least one sub-value is set; clear the whole object back to undefined when
// everything is emptied so an untouched legacy file stays byte-identical.
function updateTransition(key: 'in' | 'out' | 'duration', value: any) {
  const cur = { ...(getAtPath('meta.transition') || {}) }
  if (value === '' || value == null || (key === 'duration' && Number.isNaN(value))) {
    delete cur[key]
  } else {
    cur[key] = value
  }
  setAtPath('meta.transition', Object.keys(cur).length ? cur : undefined)
}

// meta.fonts: array of { family, source, url? } — CRUD.
function metaFonts(): any[] {
  const f = getAtPath('meta.fonts')
  return Array.isArray(f) ? f : []
}
function writeFonts(fonts: any[]) {
  setAtPath('meta.fonts', fonts)
}
function addFont() {
  const fonts = metaFonts().map((f) => ({ ...f }))
  fonts.push({ family: '', source: 'google' })
  writeFonts(fonts)
}
function removeFont(index: number) {
  const fonts = metaFonts().map((f) => ({ ...f }))
  fonts.splice(index, 1)
  writeFonts(fonts)
}
function updateFont(index: number, key: string, value: any) {
  const fonts = metaFonts().map((f) => ({ ...f }))
  if (!fonts[index]) return
  const next = { ...fonts[index], [key]: value }
  // Switching back to Google drops the now-irrelevant custom url so the
  // saved JSON stays clean.
  if (key === 'source' && value === 'google') delete next.url
  fonts[index] = next
  writeFonts(fonts)
}

// Asegura que la fuente elegida quede REGISTRADA en meta.fonts para que el engine
// la CARGUE de verdad (Google → inyecta <link>; personalizada → @font-face). Sin
// esto, poner el nombre en un elemento/tema NO cambia el texto: cae al fallback
// porque la fuente nunca se cargó. Si el nombre coincide con un archivo subido a
// Recursos → la registra como `custom` con ese archivo; si no → como `google`.
// Idempotente: si ya está registrada (por familia), no hace nada.
function ensureFontRegistered(value: string) {
  const raw = (value || '').trim()
  if (!raw) return
  // Quita el fallback ("X, serif" → "X") + comillas; ignora variables CSS del tema.
  const primary = raw.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
  if (!primary || primary.startsWith('var(')) return
  const fonts = metaFonts().map((f) => ({ ...f }))
  if (fonts.some((f) => (f.family || '').toLowerCase() === primary.toLowerCase())) return
  const slug = primary.toLowerCase().replace(/\s+/g, '-')
  const file = projectAssets.value.font.find((a) => {
    const noExt = a.name.replace(/\.(ttf|otf|woff2?|woff)$/i, '')
    return fileToFontFamily(a.name).toLowerCase() === primary.toLowerCase() || noExt.toLowerCase() === slug
  })
  fonts.push(file ? { family: primary, source: 'custom', url: file.src } : { family: primary, source: 'google' })
  writeFonts(fonts)
}

// Theme writes scaffold `site.theme` (cloned neutral defaults) on a legacy
// file with none, then set the nested value — additive, only on real edits.
function updateThemeColor(key: 'ink' | 'paper' | 'accent', value: any) {
  ensureTheme()
  const colors = { ...(getAtPath('theme.colors') || {}), [key]: value }
  setAtPath('theme.colors', colors)
}
function updateThemeType(key: 'display' | 'body', value: any) {
  ensureTheme()
  const typography = { ...(getAtPath('theme.typography') || {}), [key]: value }
  setAtPath('theme.typography', typography)
  // Auto-register the chosen family in meta.fonts so the engine actually
  // loads it (Google → <link>; custom → @font-face). Without this the
  // theme name applied to the body / display text would silently fall back
  // to the browser default — the bug the user has been hitting in Vista en
  // vivo despite the SSR helper landing.
  ensureFontRegistered(value)
}

// Wrapper used by text-element font field. Persist the value first (so
// updateProp / setAtPath's pushUndo + dirty fires), then ensure the picked
// family is registered in `meta.fonts` so the engine inyectFonts has
// something to insert. Without this, picking "Inter" on a text would store
// the name but leave meta.fonts empty → the engine renders the text with
// no link/@font-face injected → font falls back.
function onTextFontChange(value: string) {
  updateProp('font', value)
  ensureFontRegistered(value)
}
// The native <input type="color"> needs a hex; theme colors may be hex or any
// CSS string. Show the hex when it is one, else a neutral placeholder (we
// never overwrite a non-hex value until the user actually moves the picker).
function hexOf(v: any): string {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '').trim()) ? String(v).trim() : '#000000'
}

// Field types supported by the engine FormBlock.
const FORM_FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'radio', 'checkbox', 'date']

// Wheel scrolling fix: keep wheel events over this panel away from the
// engine's window-level Lenis listener (see usePanelScroll).
const { panelScrollRef } = usePanelScroll()

const selected = computed(() => getSelected())

const TYPE_LABELS: Record<string, string> = {
  text: 'Texto',
  png: 'Imagen',
  video: 'Video',
  audio: 'Audio',
  component: 'Componente',
}

function updateProp(propName: string, value: any) {
  if (!state.selectedPath) return
  setAtPath(`${state.selectedPath}.${propName}`, value)
}

function updateNestedProp(baseProp: string, key: string, value: any) {
  if (!state.selectedPath) return
  const current = getAtPath(`${state.selectedPath}.${baseProp}`) || {}
  setAtPath(`${state.selectedPath}.${baseProp}`, { ...current, [key]: value })
}

// ─── Element link mode: Ninguno | URL | Sitio (schema v1.1 additive) ──────────
//
// `element.link` is OPTIONAL { href?, target, rel?, ariaLabel?, site? }. A link
// is EITHER an external URL (`href`) or an in-engine navigation to another site
// of the same workspace (`site` = target slug). The mode selector exposes the
// three states; every write goes through setAtPath('<selectedPath>.link', …) so
// undo + dirty work (never mutate state.site directly).
const LINK_MODE_OPTS = computed(() => [
  { value: 'none', label: t('selects.linkMode.none') },
  { value: 'url', label: t('selects.linkMode.url') },
  { value: 'site', label: t('selects.linkMode.site') },
])

function selectedLink(): any {
  if (!state.selectedPath) return null
  const l = getAtPath(`${state.selectedPath}.link`)
  return l && typeof l === 'object' ? l : null
}

// Current mode is derived from the stored link: a `site` target wins (it's an
// in-engine navigation), then any `href` (URL), else no link at all.
const linkMode = computed<'none' | 'url' | 'site'>(() => {
  const l = selectedLink()
  if (!l) return 'none'
  if (l.site) return 'site'
  return 'url'
})

// Switching mode rewrites the WHOLE link object so the two link kinds never
// leak into each other (URL drops `site`; Sitio drops `href`; Ninguno removes
// the link). target defaults to '_blank' to mirror the schema default.
function onLinkModeChange(next: string) {
  if (!state.selectedPath) return
  if (next === 'none') {
    setAtPath(`${state.selectedPath}.link`, undefined)
    return
  }
  const cur = selectedLink() || {}
  if (next === 'url') {
    const { site: _drop, ...rest } = cur
    setAtPath(`${state.selectedPath}.link`, {
      ...rest,
      href: rest.href || '',
      target: rest.target || '_blank',
    })
  } else if (next === 'site') {
    // Drop href/target — in-engine navigation doesn't use them. Keep the first
    // available workspace slug pre-selected so the field is never blank.
    const { href: _h, target: _t, ...rest } = cur
    setAtPath(`${state.selectedPath}.link`, {
      ...rest,
      site: cur.site || otherProjectSlugs.value[0] || '',
    })
  }
}

// Set the target slug for a "Sitio" link. Always rewrites a `site`-only link
// (no href/target) through the store.
function onLinkSiteChange(slug: string) {
  if (!state.selectedPath) return
  const cur = selectedLink() || {}
  const { href: _h, target: _t, ...rest } = cur
  setAtPath(`${state.selectedPath}.link`, { ...rest, site: slug })
}

// Workspace projects (slugs) for the "Sitio" dropdown — fetched via the SAME
// endpoint the workspace switcher uses. Cached in a ref, refreshed on mount and
// whenever the active workspace/project changes.
const workspaceProjects = ref<ProjectListItem[]>([])

async function refreshWorkspaceProjects() {
  if (!state.projectType) {
    workspaceProjects.value = []
    return
  }
  try {
    const r = await workspaceApi.projects(state.projectType)
    workspaceProjects.value = Array.isArray(r.projects) ? r.projects : []
  } catch {
    /* keep last list — the dropdown just won't update until next refresh */
  }
}
onMounted(refreshWorkspaceProjects)
watch(() => state.projectType, refreshWorkspaceProjects)

// The OTHER projects of this workspace (exclude the current slug) — the only
// valid targets for an in-engine navigation.
const otherProjectSlugs = computed<string[]>(() =>
  workspaceProjects.value.map((p) => p.slug).filter((s) => s && s !== state.slug),
)

// ─── Section: scrollDirection (vertical | horizontal) ─────────────────────────
// Optional enum with a schema default of 'vertical'. The select always shows a
// concrete value (the engine default when absent) so it never looks blank, and
// we write the chosen enum verbatim through the store (undo + dirty).
const SCROLL_DIR_LABELS: Record<string, string> = {
  vertical: 'Vertical',
  horizontal: 'Horizontal',
}
const SCROLL_DIR_OPTS = SCROLL_DIRECTIONS.map((v) => ({
  value: v,
  label: SCROLL_DIR_LABELS[v] || v,
}))

// ─── Section: background sub-editor ───────────────────────────────────────────
// `section.background` is OPTIONAL `{ type:'color'|'gradient'|'image', value }`.
// Additive contract: nothing is written until the user picks a type, and
// "Ninguno" DELETES the whole `background` key (undefined → JSON.stringify drops
// it, exactly like meta.transition). The controls REFLECT an existing value
// (type + value shown, not blank) so a section seeded by Claude is editable.
const BG_TYPE_OPTS = computed(() => [
  { value: '', label: t('selects.bgType.none') },
  { value: 'color', label: t('selects.bgType.color') },
  { value: 'gradient', label: t('selects.bgType.gradient') },
  { value: 'image', label: t('selects.bgType.image') },
])

function sectionBg(): any {
  if (!state.selectedPath) return null
  const b = getAtPath(`${state.selectedPath}.background`)
  return b && typeof b === 'object' ? b : null
}

// "Ninguno" → remove `background` entirely. Switching to a real type writes a
// complete {type,value} object, KEEPING the existing value when it makes sense
// (color↔gradient share CSS-ish strings) so the user doesn't lose what they
// typed; image starts blank (a color string is not an image path).
function onBgTypeChange(next: string) {
  if (!state.selectedPath) return
  if (next === '') {
    setAtPath(`${state.selectedPath}.background`, undefined)
    return
  }
  const cur = sectionBg()
  const keepValue = cur && next !== 'image' && cur.type !== 'image' ? String(cur.value ?? '') : ''
  setAtPath(`${state.selectedPath}.background`, { type: next, value: keepValue })
}

function onBgValueChange(value: any) {
  if (!state.selectedPath) return
  const cur = sectionBg()
  if (!cur) return
  setAtPath(`${state.selectedPath}.background`, { ...cur, value: String(value ?? '') })
}

// ─── Section: transition (per-section {in?, out?, duration?}) ─────────────────
// SAME write-only-when-set pattern as meta.transition (updateTransition above),
// but targets `<selectedPath>.transition` — NOT meta.transition. Empty/NaN
// clears that sub-key; emptying every sub-key removes the whole object so an
// untouched section stays byte-identical.
function sectionTransition(): any {
  if (!state.selectedPath) return {}
  return getAtPath(`${state.selectedPath}.transition`) || {}
}

function updateSectionTransition(key: 'in' | 'out' | 'duration', value: any) {
  if (!state.selectedPath) return
  const cur = { ...sectionTransition() }
  if (value === '' || value == null || (key === 'duration' && Number.isNaN(value))) {
    delete cur[key]
  } else {
    cur[key] = value
  }
  setAtPath(`${state.selectedPath}.transition`, Object.keys(cur).length ? cur : undefined)
}

// ─── Layer: parallaxMode (string[] of PARALLAX_MODES) ─────────────────────────
// A set of labelled checkboxes writing the array. Empty array is valid (layer
// is static). We always write a fresh array (toggle add/remove) preserving the
// schema enum order so the saved JSON is stable regardless of click order.
const PARALLAX_MODE_LABELS: Record<string, string> = {
  'scroll-vertical': 'Scroll vertical',
  'scroll-horizontal': 'Scroll horizontal',
  mouse: 'Mouse',
  gyroscope: 'Giroscopio',
  tilt: 'Tilt 3D',
}
// Per-mode help copy (item #2): each checkbox gets its OWN "?" explaining what
// it does and when to use it, in plain Spanish.
const PARALLAX_MODE_HELP: Record<string, string> = {
  'scroll-vertical': HELP.parallaxScrollVertical,
  'scroll-horizontal': HELP.parallaxScrollHorizontal,
  mouse: HELP.parallaxMouse,
  gyroscope: HELP.parallaxGyroscope,
  tilt: HELP.parallaxTilt,
}
const PARALLAX_MODE_OPTS = PARALLAX_MODES.map((v) => ({
  value: v,
  label: PARALLAX_MODE_LABELS[v] || v,
  help: PARALLAX_MODE_HELP[v] || '',
}))

function layerParallaxModes(): string[] {
  if (!state.selectedPath) return []
  const m = getAtPath(`${state.selectedPath}.parallaxMode`)
  return Array.isArray(m) ? m : []
}

function isParallaxMode(mode: string): boolean {
  return layerParallaxModes().includes(mode)
}

function toggleParallaxMode(mode: string, on: boolean) {
  if (!state.selectedPath) return
  const set = new Set(layerParallaxModes())
  if (on) set.add(mode)
  else set.delete(mode)
  // Re-emit in the schema's canonical PARALLAX_MODES order for stable JSON.
  const next = PARALLAX_MODES.filter((m) => set.has(m))
  setAtPath(`${state.selectedPath}.parallaxMode`, next)
}

// ─── Text typography: textAlign (additive, optional) ──────────────────────────
// Illustrator-style alignment. The schema field is OPTIONAL with NO default
// (parallax-engine/schema TEXT_ALIGN = left|center|right|justify). To stay
// additive/backward-compatible we show "(heredado)" when unset and only WRITE
// the field once the user actually picks an alignment — picking the blank
// option clears it back to undefined (field removed, JSON byte-identical).
const TEXT_ALIGN_OPTS = computed(() => [
  { value: '', label: t('selects.textAlign.inherited') },
  ...TEXT_ALIGN.map((v) => ({ value: v, label: t(`selects.textAlign.${v}`) })),
])

function onTextAlignSelect(value: string) {
  // Empty → remove the field (undefined) so absent stays absent; otherwise
  // write the enum value through the normal store path (undo + dirty).
  updateProp('textAlign', value === '' ? undefined : value)
}

// ─── Text typography: whiteSpace (additive, optional) ─────────────────────────
// Schema field is optional with no default; engine fallback is 'pre-wrap'
// (preserves consecutive spaces + newlines as the author typed). Editor
// surfaces "(default: pre-wrap)" when unset and only writes the field once
// the author opts in.
const WHITE_SPACE_OPTS = computed(() => [
  { value: '', label: t('selects.whiteSpace.default') },
  ...WHITE_SPACE.map((v) => ({ value: v, label: t(`selects.whiteSpace.${v}`) })),
])

function onWhiteSpaceSelect(value: string) {
  updateProp('whiteSpace', value === '' ? undefined : value)
}

// ─── FormBlock (component/FormBlock) editor ────────────────────────────────────

const isFormBlock = computed(
  () => selected.value?.data?.type === 'component' && selected.value?.data?.name === 'FormBlock',
)

// A `type:'component'` element whose `name` is a discovered custom component
// (i.e. registered via the neighbor's parallax.config.ts) — NOT FormBlock,
// which keeps its dedicated accordion editor. When set, the generic
// editableProps renderer drives the props (PLAN §13).
const componentRegistration = computed(() => {
  const d = selected.value?.data
  if (!d || d.type !== 'component' || d.name === 'FormBlock') return null
  return getComponentRegistration(d.name)
})

// True for a component element whose `name` is NOT a built-in (FormBlock) and
// NOT in the registry (unknown / config failed). We still show the read-only
// Tipo + a small note so the element is identifiable and not silently blank.
const isUnknownComponent = computed(() => {
  const d = selected.value?.data
  return (
    !!d &&
    d.type === 'component' &&
    d.name !== 'FormBlock' &&
    !componentRegistration.value
  )
})

// Ensure props object exists and update a single top-level prop on it.
function updateFormProp(key: string, value: any) {
  if (!state.selectedPath) return
  const current = getAtPath(`${state.selectedPath}.props`) || {}
  setAtPath(`${state.selectedPath}.props`, { ...current, [key]: value })
}

// Update a key inside props.styling.
function updateFormStyling(key: string, value: any) {
  if (!state.selectedPath) return
  const props = getAtPath(`${state.selectedPath}.props`) || {}
  const styling = { ...(props.styling || {}), [key]: value }
  setAtPath(`${state.selectedPath}.props`, { ...props, styling })
}

function formFields(): any[] {
  const f = getAtPath(`${state.selectedPath}.props.fields`)
  return Array.isArray(f) ? f : []
}

function writeFormFields(fields: any[]) {
  if (!state.selectedPath) return
  const props = getAtPath(`${state.selectedPath}.props`) || {}
  setAtPath(`${state.selectedPath}.props`, { ...props, fields })
}

function addFormField() {
  const fields = formFields().map((f) => ({ ...f }))
  const n = fields.length + 1
  fields.push({ name: `campo${n}`, label: `Campo ${n}`, type: 'text', required: false })
  writeFormFields(fields)
}

function removeFormField(index: number) {
  const fields = formFields().map((f) => ({ ...f }))
  fields.splice(index, 1)
  writeFormFields(fields)
}

function moveFormField(index: number, dir: -1 | 1) {
  const fields = formFields().map((f) => ({ ...f }))
  const to = index + dir
  if (to < 0 || to >= fields.length) return
  const [item] = fields.splice(index, 1)
  fields.splice(to, 0, item)
  writeFormFields(fields)
}

function updateFormField(index: number, key: string, value: any) {
  const fields = formFields().map((f) => ({ ...f }))
  if (!fields[index]) return
  fields[index] = { ...fields[index], [key]: value }
  writeFormFields(fields)
}

// options[] <-> one-per-line textarea string
function fieldOptionsText(field: any): string {
  return Array.isArray(field?.options) ? field.options.join('\n') : ''
}

function updateFormFieldOptions(index: number, text: string) {
  const opts = text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  updateFormField(index, 'options', opts)
}

const FORM_FIELD_TYPE_OPTS = [...FORM_FIELD_TYPES]

// Friendly font choices. The site theme exposes --font-display / --font-body
// (see ParallaxSite.vue). We store the CSS string verbatim so the form
// inherits the site theme. "custom" lets her type her own family.
const FORM_FONT_OPTS = computed(() => [
  { value: '', label: t('selects.formFont.siteDefault') },
  { value: 'var(--font-body)', label: t('selects.formFont.siteBody') },
  { value: 'var(--font-display)', label: t('selects.formFont.siteDisplay') },
  { value: '__custom__', label: t('selects.formFont.custom') },
])

// Is the current fontFamily one of our presets, or a custom string?
function isCustomFont(v: string): boolean {
  if (!v) return false
  return !FORM_FONT_OPTS.value.some((o) => o.value === v && o.value !== '__custom__')
}

// The <select> shows "__custom__" whenever the stored value isn't a preset.
function fontSelectValue(v: string): string {
  return isCustomFont(v) ? '__custom__' : v || ''
}

function onFontSelect(sel: string) {
  // Picking "Personalizada…" keeps whatever custom value exists (or seeds
  // an empty one so the text box appears); presets store the CSS verbatim.
  if (sel === '__custom__') {
    const cur = (getAtPath(`${state.selectedPath}.props.styling.fontFamily`) as string) || ''
    updateFormStyling('fontFamily', isCustomFont(cur) ? cur : ' ')
    return
  }
  updateFormStyling('fontFamily', sel)
}

// ─── FormBlock editor: collapsible sections (accordion) ────────────────────────
// Lightweight disclosure, no deps. CAMPOS open by default (the essence of a
// form); Avanzado collapsed (webhook/honeypot are rarely touched). This kills
// the endless-scroll wall — only one or two groups are open at a time.
const formGroups = ref<Record<string, boolean>>({
  campos: true,
  textos: false,
  estilo: false,
  avanzado: false,
})

function toggleFormGroup(key: string) {
  formGroups.value[key] = !formGroups.value[key]
}

// ─── Asset upload: image / video / audio (pick from anywhere / drag&drop) ──────

// Per-kind upload state so the png, video and audio dropzones are independent.
// UploadKind is the SHARED type from useApi (includes 'font' — TASK #73).

const fileInput = ref<HTMLInputElement | null>(null)
const videoFileInput = ref<HTMLInputElement | null>(null)
const audioFileInput = ref<HTMLInputElement | null>(null)
// Sitio/meta image-field pickers (OG image, Favicon) — independent from the
// element png/video/audio inputs above (TASK #73).
const ogImageInput = ref<HTMLInputElement | null>(null)
const faviconInput = ref<HTMLInputElement | null>(null)
// Per-row custom-font file pickers, keyed by font index.
const fontFileInputs = ref<Record<number, HTMLInputElement | null>>({})
function setFontFileInput(index: number, el: any) {
  fontFileInputs.value[index] = (el as HTMLInputElement) || null
}

const uploading = ref(false)
const uploadError = ref<string | null>(null)
const uploadWarning = ref<string | null>(null)
const dragOver = ref(false)

const KIND_MIME_PREFIX: Record<UploadKind, string> = { image: 'image/', video: 'video/', audio: 'audio/', font: 'font/' }
const KIND_NOUN: Record<UploadKind, string> = { image: 'imágenes', video: 'video', audio: 'audio', font: 'fuentes' }

// Client-side accept check for fonts. Font mimes are unreliable (often
// application/octet-stream from the OS picker), so for the font kind we
// validate by extension/mime substring instead of a strict mime prefix; the
// server applies the same extension fallback (assetKindFromMime).
function isFontFile(file: File): boolean {
  if (file.type.startsWith('font/')) return true
  if (file.type.startsWith('application/') && file.type.includes('font')) return true
  return /\.(ttf|otf|woff|woff2)$/i.test(file.name)
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error('No se pudo leer el archivo'))
    fr.readAsDataURL(file)
  })
}

async function uploadAssetFile(file: File, kind: UploadKind) {
  uploadError.value = null
  uploadWarning.value = null
  if (!state.projectType || !state.slug || !state.selectedPath) return
  if (!file.type.startsWith(KIND_MIME_PREFIX[kind])) {
    uploadError.value = `Solo se permiten ${KIND_NOUN[kind]}`
    return
  }
  uploading.value = true
  try {
    const dataUrl = await readAsDataUrl(file)
    const r = await projectsApi.uploadAsset(state.projectType, state.slug, file.name, dataUrl)
    if (r.error || !r.src) {
      uploadError.value = r.error || 'No se pudo subir el archivo'
      return
    }
    // Store the CANONICAL relative src ("images/<f>" | "video/<f>" |
    // "audio/<f>") through the store (records undo + marks dirty). The
    // canvas/preview prefixes it with /content/<type>/<slug>/.
    setAtPath(`${state.selectedPath}.src`, r.src)
    if (r.warning) uploadWarning.value = r.warning
    // Refresca la lista de recursos de ESTE y los demás paneles (vía el watch).
    state.assetsNonce++
  } catch (e: any) {
    uploadError.value = e?.message || 'Error al subir el archivo'
  } finally {
    uploading.value = false
  }
}

// Back-compat alias for the (unchanged) PNG flow.
function uploadImageFile(file: File) {
  return uploadAssetFile(file, 'image')
}

function onFilePick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) uploadImageFile(file)
  input.value = '' // allow re-picking the same file
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) uploadImageFile(file)
}

// Generic pick/drop handlers for video & audio.
function onMediaPick(e: Event, kind: UploadKind) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) uploadAssetFile(file, kind)
  input.value = ''
}

function onMediaDrop(e: DragEvent, kind: UploadKind) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) uploadAssetFile(file, kind)
}

// Resolve a relative asset src to a preview URL (mirrors the png thumb logic).
function previewSrc(src: string): string {
  if (!src) return ''
  return src.startsWith('http') || src.startsWith('/')
    ? src
    : `/content/${state.projectType}/${state.slug}/${src}`
}

// ─── Project resources → autocomplete suggestions (TASK #85) ───────────────────
//
// The image/font fields become type-to-filter comboboxes sourced from the
// SAME endpoint the "Recursos" panel uses (single source of truth). We cache
// the list and refresh it: on mount, when the active project changes, and
// after any upload (so a just-uploaded file is immediately suggestable).
// Combobox still emits the raw relative string — the consumer-prefixing model
// and saved data shape are unchanged; only the INPUT UX changes.
const projectAssets = ref<{ image: ProjectAsset[]; font: ProjectAsset[]; audio: ProjectAsset[]; video: ProjectAsset[] }>({
  image: [],
  font: [],
  audio: [],
  video: [],
})

async function refreshProjectAssets() {
  if (!state.projectType || !state.slug) {
    projectAssets.value = { image: [], font: [], audio: [], video: [] }
    return
  }
  try {
    const r = await projectsApi.listAssets(state.projectType, state.slug)
    if (r.assets) {
      projectAssets.value = {
        image: r.assets.image || [],
        font: r.assets.font || [],
        audio: r.assets.audio || [],
        video: r.assets.video || [],
      }
    }
  } catch {
    /* keep last list — autocomplete just won't suggest until next refresh */
  }
  loadPreviewFonts()
}

// Carga en el documento del EDITOR las fuentes SUGERIDAS (Google comunes + los
// archivos subidos) SOLO para previsualizarlas en el dropdown del autocomplete
// (que el nombre se vea en su propia tipografía). Las fuentes ya registradas las
// inyecta el engine en el mismo documento. Idempotente (no duplica por id).
function loadPreviewFonts() {
  if (typeof document === 'undefined') return
  // Google comunes → un solo <link> con todas las familias.
  const gid = 'pe-font-preview-google'
  if (!document.getElementById(gid)) {
    const fams = COMMON_FONTS.map((f) => `family=${encodeURIComponent(f)}:wght@400;600`).join('&')
    const link = document.createElement('link')
    link.id = gid
    link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?${fams}&display=swap`
    document.head.appendChild(link)
  }
  // Archivos subidos → @font-face por cada uno (familia = basename, igual que en
  // fontFamilyOptions/ensureFontRegistered), src = url servida por el editor.
  for (const a of projectAssets.value.font) {
    const base = fileToFontFamily(a.name)
    if (!base) continue
    const fid = 'pe-font-preview-file-' + base.replace(/\s+/g, '-').toLowerCase()
    if (document.getElementById(fid)) continue
    const style = document.createElement('style')
    style.id = fid
    style.textContent = `@font-face{font-family:'${base.replace(/'/g, '')}';src:url('${previewSrc(a.src)}');font-display:swap;}`
    document.head.appendChild(style)
  }
}
onMounted(refreshProjectAssets)
// assetsNonce: refresca también cuando otro panel sube/borra un asset o el
// file-watcher ve un cambio externo (p.ej. Claude agregó una imagen) — sin
// tener que salir y reentrar al proyecto.
watch(() => [state.projectType, state.slug, state.assetsNonce], refreshProjectAssets)

// Image suggestions: each carries a thumbnail (served URL) so the dropdown
// previews the picture, plus the file size as a hint.
const imageOptions = computed<ComboOption[]>(() =>
  projectAssets.value.image.map((a) => ({
    value: a.src,
    label: a.src,
    thumb: previewSrc(a.src),
    hint: a.bytes ? `${(a.bytes / 1024).toFixed(0)} KB` : undefined,
  })),
)

// Audio suggestions: dropdown of every audio/* asset under the project. No
// thumbnail (audio files have no preview); file size in the hint.
const audioOptions = computed<ComboOption[]>(() =>
  projectAssets.value.audio.map((a) => ({
    value: a.src,
    label: a.src,
    hint: a.bytes ? `${(a.bytes / 1024).toFixed(0)} KB` : undefined,
  })),
)

// Video suggestions: dropdown of every video/* asset under the project.
const videoOptions = computed<ComboOption[]>(() =>
  projectAssets.value.video.map((a) => ({
    value: a.src,
    label: a.src,
    hint: a.bytes ? `${(a.bytes / 1024).toFixed(0)} KB` : undefined,
  })),
)

// Local custom-font files (fonts/*) — suggested for a custom-source font URL.
const fontFileOptions = computed<ComboOption[]>(() =>
  projectAssets.value.font.map((a) => ({
    value: a.src,
    label: a.src,
    hint: 'fuente local',
  })),
)

// A short list of common Google Font families so the `family` combobox can
// suggest popular names while STILL accepting any free text the user types.
const COMMON_FONTS = [
  'Playfair Display',
  'Montserrat',
  'Lato',
  'Poppins',
  'Roboto',
  'Open Sans',
  'Cormorant Garamond',
  'Great Vibes',
  'Dancing Script',
  'Cinzel',
  'EB Garamond',
  'Raleway',
  'Inter',
  'Merriweather',
  'Libre Baskerville',
]
// Family suggestions = local font basenames (handy when she uploaded a TTF)
// + common Google families. Free text is always allowed (the combobox never
// constrains the value), so a Google name like "Playfair Display" works
// whether or not it's in this list.
const fontFamilyOptions = computed<ComboOption[]>(() => {
  const seen = new Set<string>()
  const out: ComboOption[] = []
  const add = (value: string, hint: string) => {
    const v = (value || '').trim()
    if (!v || seen.has(v.toLowerCase())) return
    seen.add(v.toLowerCase())
    // previewFont = la familia → el dropdown pinta el nombre EN esa tipografía.
    out.push({ value: v, label: v, hint, previewFont: v })
  }
  // 1) Fuentes YA REGISTRADAS en el sitio (meta.fonts) — las que de verdad están
  //    disponibles. Van primero, con su origen (Google / personalizada) en el hint.
  for (const f of metaFonts()) {
    if (f?.family) add(f.family, f.source === 'custom' ? 'registrada · personalizada' : 'registrada · Google')
  }
  // 2) Archivos de fuente subidos a Recursos (por si aún no se registró en "Fuentes").
  for (const a of projectAssets.value.font) {
    add(fileToFontFamily(a.name), `archivo: ${a.name}`)
  }
  // 3) Google Fonts comunes (texto libre igual se acepta para cualquier otra).
  for (const f of COMMON_FONTS) add(f, 'Google Fonts')
  return out
})

// All element IDs in the active site view (sections > layers > elements),
// minus the currently-selected element. Powers the "Depende de" combobox for
// trigger==='depends' animations — the user picks which OTHER element drives
// this one. Each option is rendered as `<id> · <kind>` (e.g.
// "titulo-nombres · texto") so non-technical users recognise it.
const KIND_LABELS_ES: Record<string, string> = {
  text: 'texto',
  png: 'imagen',
  video: 'video',
  audio: 'audio',
  component: 'componente',
}
const allElementOptions = computed<ComboOption[]>(() => {
  const site = state.site as any
  if (!site) return []
  // Pick the active view's sections (independent or legacy). Mirrors
  // activeSections() in the store but inline here so we don't have to widen
  // the store's surface area.
  let sections: any[] = []
  if (site.views) {
    sections = (state.deviceMode === 'mobile'
      ? site.views.mobile?.sections ?? site.views.desktop?.sections
      : site.views.desktop?.sections) ?? []
  } else {
    sections = site.sections ?? []
  }
  // The currently-selected element's id (if any) — exclude from the list so
  // the user can't accidentally point an animation at itself.
  const selfId = (selected.value as any)?.data?.id
  const opts: ComboOption[] = []
  for (const sec of sections) {
    for (const layer of (sec?.layers ?? [])) {
      for (const el of (layer?.elements ?? [])) {
        if (!el?.id || el.id === selfId) continue
        const kind = KIND_LABELS_ES[el.type] || el.type || 'elemento'
        opts.push({ value: el.id, label: `${el.id} · ${kind}`, hint: undefined })
      }
    }
  }
  return opts
})

// Spanish labels for the depends event keyword (writes the keyword verbatim).
const DEPENDS_EVENT_OPTS = computed(() => [
  { value: 'hover', label: t('selects.dependsEvent.hover') },
  { value: 'click', label: t('selects.dependsEvent.click') },
  { value: 'enter', label: t('selects.dependsEvent.enter') },
])

// ─── Sitio (meta) image-field uploads + custom-font uploads (TASK #73) ─────────
//
// The element png/video/audio dropzones above are gated on state.selectedPath
// and write `<selectedPath>.src`. The Sitio/meta form has no selected element,
// so these get their OWN per-control state (keyed by a string id so the OG
// image, Favicon and each custom-font row are independent) and write through
// an arbitrary setter. They reuse the SAME endpoint (projectsApi.uploadAsset)
// and store the CANONICAL relative path the engine/consumers expect
// ("images/<f>" | "fonts/<f>"); only the editor preview prefixes it.
const metaUploading = ref<Record<string, boolean>>({})
const metaUploadError = ref<Record<string, string | null>>({})
const metaUploadWarning = ref<Record<string, string | null>>({})

async function uploadMetaAsset(
  id: string,
  file: File,
  kind: UploadKind,
  apply: (relSrc: string) => void,
) {
  metaUploadError.value = { ...metaUploadError.value, [id]: null }
  metaUploadWarning.value = { ...metaUploadWarning.value, [id]: null }
  if (!state.projectType || !state.slug) return
  const ok = kind === 'font' ? isFontFile(file) : file.type.startsWith(KIND_MIME_PREFIX[kind])
  if (!ok) {
    metaUploadError.value = {
      ...metaUploadError.value,
      [id]: `Solo se permiten ${KIND_NOUN[kind]}`,
    }
    return
  }
  metaUploading.value = { ...metaUploading.value, [id]: true }
  try {
    const dataUrl = await readAsDataUrl(file)
    const r = await projectsApi.uploadAsset(state.projectType, state.slug, file.name, dataUrl)
    if (r.error || !r.src) {
      metaUploadError.value = {
        ...metaUploadError.value,
        [id]: r.error || 'No se pudo subir el archivo',
      }
      return
    }
    // CANONICAL relative path — "images/<f>" for og/favicon, "fonts/<f>" for a
    // custom font. setAtPath (via the apply callback) records undo + dirty;
    // saved JSON stays relative (consumers prefix it for the real sites).
    apply(r.src)
    state.assetsNonce++
    if (r.warning) {
      metaUploadWarning.value = { ...metaUploadWarning.value, [id]: r.warning }
    }
  } catch (e: any) {
    metaUploadError.value = {
      ...metaUploadError.value,
      [id]: e?.message || 'Error al subir el archivo',
    }
  } finally {
    metaUploading.value = { ...metaUploading.value, [id]: false }
  }
}

// Pick/drop adapters for a meta image field (OG image / Favicon). `key` is the
// meta.* field; updateMeta records undo + dirty. The text input stays as the
// advanced/typed path.
function onMetaImagePick(e: Event, metaKey: string, id: string) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) uploadMetaAsset(id, file, 'image', (src) => updateMeta(metaKey, src))
  input.value = ''
}
function onMetaImageDrop(e: DragEvent, metaKey: string, id: string) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) uploadMetaAsset(id, file, 'image', (src) => updateMeta(metaKey, src))
}

// Section background image upload. Reuses the SAME uploadMetaAsset helper /
// endpoint as OG image (it writes the canonical relative "images/<f>" via the
// apply callback). The apply callback writes through onBgValueChange so the
// background object stays {type:'image', value:'images/<f>'} (undo + dirty).
// Independent per-control state, keyed 'section-bg'.
const sectionBgInput = ref<HTMLInputElement | null>(null)
function onSectionBgImagePick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) uploadMetaAsset('section-bg', file, 'image', (src) => onBgValueChange(src))
  input.value = ''
}
function onSectionBgImageDrop(e: DragEvent) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) uploadMetaAsset('section-bg', file, 'image', (src) => onBgValueChange(src))
}

// Pick/drop adapters for a custom-font row. Sets that font's `url` to the
// returned "fonts/<file>"; `family` is left exactly as the user typed it. The
// manual URL <PropField> remains as the advanced fallback.
function onFontFilePick(e: Event, index: number) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) uploadMetaAsset(`font-${index}`, file, 'font', (src) => updateFont(index, 'url', src))
  input.value = ''
}
function onFontFileDrop(e: DragEvent, index: number) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) uploadMetaAsset(`font-${index}`, file, 'font', (src) => updateFont(index, 'url', src))
}

// ─── Animations sub-panel ──────────────────────────────────────────────────────

function updateAnim(index: number, key: string, value: any) {
  if (!state.selectedPath) return
  const anims = getAtPath(`${state.selectedPath}.animations`)
  if (!Array.isArray(anims) || !anims[index]) return
  setAtPath(`${state.selectedPath}.animations.${index}.${key}`, value)
}

function updateAnimRange(index: number, which: 0 | 1, value: any) {
  if (!state.selectedPath) return
  const anims = getAtPath(`${state.selectedPath}.animations`)
  if (!Array.isArray(anims) || !anims[index]) return
  const cur = Array.isArray(anims[index].range) ? [...anims[index].range] : [0, 1]
  cur[which] = Number(value)
  setAtPath(`${state.selectedPath}.animations.${index}.range`, cur)
}

const ANIM_TYPE_OPTS = [...ANIMATION_TYPES]
const TRIGGER_OPTS = [...TRIGGER_TYPES]
const EASING_OPTS = [...EASING_PRESETS]

// Detailed animations guide modal (item #4), opened from the "?" before the "+".
// `animHelpSection` lets the "Ver guía de easing" link jump to the Easing
// section instead of opening at the top.
const animHelpOpen = ref(false)
const animHelpSection = ref<string | null>(null)
function openAnimHelp(section: string | null = null) {
  animHelpSection.value = section
  animHelpOpen.value = true
}
</script>

<template>
  <div class="properties-panel">
    <div class="panel-header">{{ t('properties.title') }}</div>

    <div class="panel-body" :ref="panelScrollRef">
      <div v-if="!selected && !selectedGlobal" class="empty-state">
        Selecciona un elemento para editar sus propiedades
      </div>

      <!-- ── Sitio (meta): top-level, shared across desktop/mobile ── -->
      <div v-else-if="selectedGlobal === 'site'" class="props-content" data-test="props-site">
        <div class="prop-section-title">{{ t('properties.groupSite') }}</div>
        <p class="global-note">
          Propiedades generales del sitio. Se comparten en escritorio y móvil.
        </p>

        <div class="prop-group-title">{{ t('properties.groupGeneral') }}</div>
        <PropField :label="t('properties.f.title')" :help="HELP.metaTitle" data-test="meta-title-field" :modelValue="meta.title || ''" @update:modelValue="updateMeta('title', $event)" />
        <PropField :label="t('properties.f.description')" :help="HELP.metaDescription" type="textarea" :modelValue="meta.description || ''" @update:modelValue="updateMeta('description', $event || undefined)" />
        <PropField :label="t('properties.f.language')" :help="HELP.metaLang" placeholder="es" :modelValue="meta.lang || ''" @update:modelValue="updateMeta('lang', $event || undefined)" />
        <ResourceCombobox
          :label="t('properties.f.ogImage')"
          :help="HELP.metaOgImage"
          placeholder="og-image.png"
          test-id="meta-ogimage"
          kind="images"
          :suggestions="imageOptions"
          :modelValue="meta.ogImage || ''"
          @update:modelValue="updateMeta('ogImage', $event || undefined)"
        />
        <div
          class="img-dropzone"
          :class="{ 'drag-over': dragOver, 'is-uploading': metaUploading['ogImage'] }"
          data-test="meta-ogimage-upload"
          @dragover.prevent="dragOver = true"
          @dragenter.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onMetaImageDrop($event, 'ogImage', 'ogImage')"
        >
          <img
            v-if="meta.ogImage"
            class="img-preview-thumb"
            :src="previewSrc(meta.ogImage)"
            alt=""
          />
          <div class="img-dz-text">
            <span v-if="metaUploading['ogImage']">{{ t('properties.uploading') }}</span>
            <span v-else>{{ t('properties.dropImage') }}</span>
          </div>
          <button
            class="img-pick-btn"
            type="button"
            data-test="meta-ogimage-upload-btn"
            :disabled="metaUploading['ogImage']"
            @click="ogImageInput?.click()"
          >{{ t('properties.loadFromPC') }}</button>
          <input
            ref="ogImageInput"
            class="img-file-input"
            type="file"
            accept="image/*"
            data-test="meta-ogimage-file-input"
            @change="onMetaImagePick($event, 'ogImage', 'ogImage')"
          />
        </div>
        <div v-if="metaUploadError['ogImage']" class="img-msg img-err" data-test="meta-ogimage-upload-error">{{ metaUploadError['ogImage'] }}</div>
        <div v-if="metaUploadWarning['ogImage']" class="img-msg img-warn" data-test="meta-ogimage-upload-warning">{{ metaUploadWarning['ogImage'] }}</div>

        <ResourceCombobox
          :label="t('properties.f.favicon')"
          :help="HELP.metaFavicon"
          placeholder="favicon.png"
          test-id="meta-favicon"
          kind="images"
          :suggestions="imageOptions"
          :modelValue="meta.favicon || ''"
          @update:modelValue="updateMeta('favicon', $event || undefined)"
        />
        <div
          class="img-dropzone"
          :class="{ 'drag-over': dragOver, 'is-uploading': metaUploading['favicon'] }"
          data-test="meta-favicon-upload"
          @dragover.prevent="dragOver = true"
          @dragenter.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onMetaImageDrop($event, 'favicon', 'favicon')"
        >
          <img
            v-if="meta.favicon"
            class="img-preview-thumb"
            :src="previewSrc(meta.favicon)"
            alt=""
          />
          <div class="img-dz-text">
            <span v-if="metaUploading['favicon']">{{ t('properties.uploading') }}</span>
            <span v-else>{{ t('properties.dropImage') }}</span>
          </div>
          <button
            class="img-pick-btn"
            type="button"
            data-test="meta-favicon-upload-btn"
            :disabled="metaUploading['favicon']"
            @click="faviconInput?.click()"
          >{{ t('properties.loadFromPC') }}</button>
          <input
            ref="faviconInput"
            class="img-file-input"
            type="file"
            accept="image/*"
            data-test="meta-favicon-file-input"
            @change="onMetaImagePick($event, 'favicon', 'favicon')"
          />
        </div>
        <div v-if="metaUploadError['favicon']" class="img-msg img-err" data-test="meta-favicon-upload-error">{{ metaUploadError['favicon'] }}</div>
        <div v-if="metaUploadWarning['favicon']" class="img-msg img-warn" data-test="meta-favicon-upload-warning">{{ metaUploadWarning['favicon'] }}</div>

        <!-- ── Cursor que sigue el puntero (top-level site.cursor) ──
             Additive: `cursor` is NOT written until she ticks the box. The
             color/size/blend controls only appear once enabled. Shared across
             escritorio/móvil (cursor is a top-level field, not per-view). -->
        <div class="prop-group-title">{{ t('properties.groupCursor') }}</div>
        <div class="prop-field" data-test="site-cursor-enabled-field">
          <label class="field-label">Sigue el puntero</label>
          <label class="checkbox-wrap field-control">
            <input
              type="checkbox"
              data-test="site-cursor-enabled"
              :checked="cursorOn"
              @change="onCursorEnabledChange"
            />
          </label>
          <HelpHint :text="HELP.cursorEnabled" :label="t('properties.f.cursorFollows')" />
        </div>
        <template v-if="cursorOn">
          <div class="prop-field" data-test="site-cursor-color-field">
            <label class="field-label">{{ t('properties.f.color') }}</label>
            <span class="field-control color-row">
              <input
                type="color"
                class="field-color"
                data-test="site-cursor-color-picker"
                :value="cursor?.color || '#000000'"
                @input="updateCursor('color', ($event.target as any).value)"
              />
              <input
                type="text"
                class="field-input ci-text"
                data-test="site-cursor-color"
                placeholder="#000000"
                :value="cursor?.color || ''"
                @input="updateCursor('color', ($event.target as any).value)"
              />
            </span>
            <HelpHint :text="HELP.cursorColor" :label="t('properties.f.cursorColorLabel')" />
          </div>
          <NumberSlider
            id="site-cursor-size"
            :label="t('properties.f.size')"
            :help="HELP.cursorSize"
            unit="px"
            :min="1"
            :max="120"
            :step="1"
            :modelValue="cursor?.size ?? 20"
            @update:modelValue="updateCursor('size', Number($event) || 0)"
          />
          <NumberSlider
            id="site-cursor-hover-scale"
            :label="t('properties.f.hoverScale')"
            :min="1"
            :max="4"
            :step="0.1"
            :decimals="2"
            :modelValue="cursor?.hoverScale ?? 2"
            @update:modelValue="updateCursor('hoverScale', Number($event) || 0)"
          />
          <BlendSelect
            id="site-cursor-blend"
            :label="t('properties.f.blendMode')"
            :help="HELP.cursorBlend"
            :allowEmpty="false"
            :modelValue="cursor?.blendMode || 'difference'"
            @update:modelValue="updateCursor('blendMode', $event || 'normal')"
          />
        </template>

        <div class="prop-group-title">{{ t('properties.groupWorldTransition') }}</div>
        <div class="prop-field" data-test="meta-transition-in-field">
          <label class="field-label">{{ t('properties.f.transitionIn') }}</label>
          <select
            class="field-input field-control"
            data-test="meta-transition-in"
            :value="meta.transition?.in || ''"
            @change="updateTransition('in', ($event.target as any).value)"
          >
            <option v-for="o in TRANSITION_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <HelpHint :text="HELP.metaTransIn" :label="t('properties.f.transitionIn')" />
        </div>
        <div class="prop-field" data-test="meta-transition-out-field">
          <label class="field-label">{{ t('properties.f.transitionOut') }}</label>
          <select
            class="field-input field-control"
            data-test="meta-transition-out"
            :value="meta.transition?.out || ''"
            @change="updateTransition('out', ($event.target as any).value)"
          >
            <option v-for="o in TRANSITION_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <HelpHint :text="HELP.metaTransOut" :label="t('properties.f.transitionOut')" />
        </div>
        <NumberSlider
          id="meta-transition-duration"
          :label="t('properties.f.duration')"
          :help="HELP.metaTransDur"
          unit="ms"
          :min="0"
          :max="4000"
          :step="50"
          :placeholder="800"
          :modelValue="meta.transition?.duration ?? null"
          @update:modelValue="updateTransition('duration', Number($event))"
        />

        <div class="prop-group-title anim-header">
          <span>Fuentes ({{ metaFonts().length }})</span>
          <button class="anim-add" data-test="meta-add-font" @click="addFont()" :title="t('properties.f.addFont')" :aria-label="t('properties.f.addFont')">+</button>
        </div>
        <p v-if="!metaFonts().length" class="fb-empty">
          Sin fuentes declaradas. Usa “+” para agregar una (Google Fonts o personalizada).
        </p>
        <div
          v-for="(font, fi) in metaFonts()"
          :key="fi"
          class="anim-card"
          data-test="meta-font"
        >
          <div class="anim-card-head">
            <span class="anim-card-title">{{ font.family || 'Fuente' }}</span>
            <button class="anim-remove" data-test="meta-font-remove" @click="removeFont(fi)" :title="t('common.delete')" :aria-label="t('properties.f.removeFont')">&times;</button>
          </div>
          <ResourceCombobox
            :label="t('properties.f.family')"
            :help="HELP.fontFamily"
            placeholder="Playfair Display"
            :test-id="`meta-font-family-${fi}`"
            :suggestions="fontFamilyOptions"
            :modelValue="font.family || ''"
            @update:modelValue="updateFont(fi, 'family', $event)"
          />
          <PropField :label="t('properties.f.source')" :help="HELP.fontSource" type="select" :options="FONT_SOURCE_OPTS" :modelValue="font.source || 'google'" @update:modelValue="updateFont(fi, 'source', $event)" />
          <template v-if="font.source === 'custom'">
            <ResourceCombobox
              :label="t('properties.f.url')"
              :help="HELP.fontUrl"
              placeholder="mi-fuente.woff2"
              :test-id="`meta-font-url-${fi}`"
              kind="fonts"
              :suggestions="fontFileOptions"
              :modelValue="font.url || ''"
              @update:modelValue="updateFont(fi, 'url', $event || undefined)"
            />
            <div
              class="img-dropzone"
              :class="{ 'drag-over': dragOver, 'is-uploading': metaUploading['font-' + fi] }"
              data-test="meta-font-upload"
              @dragover.prevent="dragOver = true"
              @dragenter.prevent="dragOver = true"
              @dragleave.prevent="dragOver = false"
              @drop.prevent="onFontFileDrop($event, fi)"
            >
              <div class="img-dz-text">
                <span v-if="metaUploading['font-' + fi]">{{ t('properties.uploading') }}</span>
                <span v-else>{{ t('properties.dropFont') }}</span>
              </div>
              <button
                class="img-pick-btn"
                type="button"
                data-test="meta-font-upload-btn"
                :disabled="metaUploading['font-' + fi]"
                @click="fontFileInputs[fi]?.click()"
              >{{ t('properties.loadFromPC') }}</button>
              <input
                :ref="(el) => setFontFileInput(fi, el)"
                class="img-file-input"
                type="file"
                accept=".ttf,.otf,.woff,.woff2,font/*"
                data-test="meta-font-file-input"
                @change="onFontFilePick($event, fi)"
              />
            </div>
            <div v-if="metaUploadError['font-' + fi]" class="img-msg img-err" data-test="meta-font-upload-error">{{ metaUploadError['font-' + fi] }}</div>
            <div v-if="metaUploadWarning['font-' + fi]" class="img-msg img-warn" data-test="meta-font-upload-warning">{{ metaUploadWarning['font-' + fi] }}</div>
          </template>
        </div>
      </div>

      <!-- ── Tema (theme): colors + typography, shared across views ── -->
      <div v-else-if="selectedGlobal === 'theme'" class="props-content" data-test="props-theme">
        <div class="prop-section-title">{{ t('properties.groupTheme') }}</div>
        <p class="global-note">
          Colores y tipografía del sitio. Se comparten en escritorio y móvil.
          <template v-if="!theme"><br />Aún sin tema: al cambiar un valor se creará uno con valores neutros.</template>
        </p>

        <div class="prop-group-title">{{ t('properties.groupColors') }}</div>
        <div class="prop-field" data-test="theme-ink-field">
          <label class="field-label">Tinta (texto)</label>
          <span class="field-control color-row">
            <input type="color" class="field-color" data-test="theme-ink-picker" :value="hexOf(theme?.colors?.ink)" @input="updateThemeColor('ink', ($event.target as any).value)" />
            <input type="text" class="field-input ci-text" data-test="theme-ink" placeholder="#1a1a1a" :value="theme?.colors?.ink || ''" @input="updateThemeColor('ink', ($event.target as any).value)" />
          </span>
          <HelpHint :text="HELP.themeInk" :label="t('properties.f.ink')" />
        </div>
        <div class="prop-field" data-test="theme-paper-field">
          <label class="field-label">Papel (fondo)</label>
          <span class="field-control color-row">
            <input type="color" class="field-color" data-test="theme-paper-picker" :value="hexOf(theme?.colors?.paper)" @input="updateThemeColor('paper', ($event.target as any).value)" />
            <input type="text" class="field-input ci-text" data-test="theme-paper" placeholder="#ffffff" :value="theme?.colors?.paper || ''" @input="updateThemeColor('paper', ($event.target as any).value)" />
          </span>
          <HelpHint :text="HELP.themePaper" :label="t('properties.f.paper')" />
        </div>
        <div class="prop-field" data-test="theme-accent-field">
          <label class="field-label">{{ t('properties.f.accent') }}</label>
          <span class="field-control color-row">
            <input type="color" class="field-color" data-test="theme-accent-picker" :value="hexOf(theme?.colors?.accent)" @input="updateThemeColor('accent', ($event.target as any).value)" />
            <input type="text" class="field-input ci-text" data-test="theme-accent" placeholder="#c8a04b" :value="theme?.colors?.accent || ''" @input="updateThemeColor('accent', ($event.target as any).value)" />
          </span>
          <HelpHint :text="HELP.themeAccent" :label="t('properties.f.accent')" />
        </div>

        <div class="prop-group-title">{{ t('properties.groupTypography') }}</div>
        <ResourceCombobox
          :label="t('properties.f.display')"
          :help="HELP.themeDisplay"
          placeholder="Playfair Display, serif"
          test-id="theme-display-field"
          :suggestions="fontFamilyOptions"
          :modelValue="theme?.typography?.display || ''"
          @update:modelValue="updateThemeType('display', $event)"
        />
        <ResourceCombobox
          :label="t('properties.f.text')"
          :help="HELP.themeBody"
          placeholder="Lato, sans-serif"
          test-id="theme-body-field"
          :suggestions="fontFamilyOptions"
          :modelValue="theme?.typography?.body || ''"
          @update:modelValue="updateThemeType('body', $event)"
        />
      </div>

      <!-- ── Recursos: per-project asset browser, shared across views ── -->
      <ResourcesPanel v-else-if="selectedGlobal === 'resources'" />

      <div v-else class="props-content" data-test="props-element">
      <div class="prop-section-title">{{ selected.type }}</div>

      <!-- Section props -->
      <template v-if="selected.type === 'section'">
        <PropField :label="t('properties.f.id')" :help="HELP.sectionId" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <PropField :label="t('properties.f.visible')" :help="HELP.sectionVisible" :modelValue="selected.data.visible !== false" type="checkbox" @update:modelValue="updateProp('visible', $event)" />
        <PropField :label="t('properties.f.height')" :help="HELP.sectionHeight" :modelValue="selected.data.height" @update:modelValue="updateProp('height', $event)" />
        <PropField :label="t('properties.f.scroll')" :help="HELP.sectionScroll" :modelValue="selected.data.scrollBehavior" type="select" :options="[...SCROLL_BEHAVIORS]" @update:modelValue="updateProp('scrollBehavior', $event)" />

        <!-- scrollDirection: labelled <select> (PropField select uses the value
             as the label, so a labelled set needs the hand-rolled row — same
             contract/HelpHint as the rest of the panel). Defaults to the
             engine's 'vertical' when absent so it never looks blank. -->
        <div class="prop-field" data-test="section-scroll-direction-field">
          <label class="field-label">{{ t('properties.f.direction') }}</label>
          <select
            class="field-input field-control"
            data-test="section-scroll-direction"
            :value="selected.data.scrollDirection || 'vertical'"
            @change="updateProp('scrollDirection', ($event.target as any).value)"
          >
            <option v-for="o in SCROLL_DIR_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <HelpHint :text="HELP.sectionScrollDir" :label="t('properties.f.scrollDirection')" />
        </div>

        <!-- Background sub-editor: optional {type,value}. "Ninguno" deletes the
             whole key; color → standard color row (picker + hex text, same
             chrome as Tema/Texto); gradient → CSS text input; image → the SAME
             ResourceCombobox + dropzone used by png src / OG image. -->
        <div class="prop-group-title">{{ t('properties.groupBackground') }}</div>
        <div class="prop-field" data-test="section-bg-type-field">
          <label class="field-label">Tipo de fondo</label>
          <select
            class="field-input field-control"
            data-test="section-bg-type"
            :value="sectionBg()?.type || ''"
            @change="onBgTypeChange(($event.target as any).value)"
          >
            <option v-for="o in BG_TYPE_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <HelpHint :text="HELP.sectionBgType" :label="t('properties.f.bgType')" />
        </div>

        <template v-if="sectionBg()?.type === 'color'">
          <div class="prop-field" data-test="section-bg-color-field">
            <label class="field-label">{{ t('properties.f.color') }}</label>
            <span class="field-control color-row">
              <input
                type="color"
                class="field-color"
                data-test="section-bg-color-picker"
                :value="hexOf(sectionBg()?.value || '#000000')"
                @input="onBgValueChange(($event.target as any).value)"
              />
              <input
                type="text"
                class="field-input ci-text"
                data-test="section-bg-value"
                placeholder="#000000"
                :value="sectionBg()?.value || ''"
                @input="onBgValueChange(($event.target as any).value)"
              />
            </span>
            <HelpHint :text="HELP.sectionBgColor" :label="t('properties.f.bgColor')" />
          </div>
        </template>

        <template v-else-if="sectionBg()?.type === 'gradient'">
          <GradientBuilder
            :help="HELP.sectionBgGradient"
            :modelValue="sectionBg()?.value || ''"
            @update:modelValue="onBgValueChange($event)"
          />
        </template>

        <template v-else-if="sectionBg()?.type === 'image'">
          <div
            class="img-dropzone"
            :class="{ 'drag-over': dragOver, 'is-uploading': metaUploading['section-bg'] }"
            data-test="section-bg-upload"
            @dragover.prevent="dragOver = true"
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onSectionBgImageDrop($event)"
          >
            <img
              v-if="sectionBg()?.value"
              class="img-preview-thumb"
              :src="previewSrc(sectionBg()?.value)"
              alt=""
            />
            <div class="img-dz-text">
              <span v-if="metaUploading['section-bg']">{{ t('properties.uploading') }}</span>
              <span v-else>{{ t('properties.dropImage') }}</span>
            </div>
            <button
              class="img-pick-btn"
              type="button"
              data-test="section-bg-upload-btn"
              :disabled="metaUploading['section-bg']"
              @click="sectionBgInput?.click()"
            >{{ t('properties.loadFromPC') }}</button>
            <input
              ref="sectionBgInput"
              class="img-file-input"
              type="file"
              accept="image/*"
              data-test="section-bg-file-input"
              @change="onSectionBgImagePick($event)"
            />
          </div>
          <div v-if="metaUploadError['section-bg']" class="img-msg img-err" data-test="section-bg-upload-error">{{ metaUploadError['section-bg'] }}</div>
          <div v-if="metaUploadWarning['section-bg']" class="img-msg img-warn" data-test="section-bg-upload-warning">{{ metaUploadWarning['section-bg'] }}</div>
          <ResourceCombobox
            :label="t('properties.f.image')"
            :help="HELP.sectionBgImage"
            placeholder="fondo.jpg"
            test-id="section-bg-value"
            kind="images"
            :suggestions="imageOptions"
            :modelValue="sectionBg()?.value || ''"
            @update:modelValue="onBgValueChange($event)"
          />
        </template>

        <!-- Per-section transition ({in?,out?,duration?}) — NOT meta.transition.
             Mirrors the Sitio transition editor (same TRANSITION_OPTS / write-
             only-when-set) but writes <section>.transition. -->
        <div class="prop-group-title">{{ t('properties.groupSectionTransition') }}</div>
        <div class="prop-field" data-test="section-transition-in-field">
          <label class="field-label">{{ t('properties.f.transitionIn') }}</label>
          <select
            class="field-input field-control"
            data-test="section-transition-in"
            :value="sectionTransition().in || ''"
            @change="updateSectionTransition('in', ($event.target as any).value)"
          >
            <option v-for="o in SECTION_TRANSITION_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <HelpHint :text="HELP.sectionTransIn" :label="t('properties.f.transitionInLabel')" />
        </div>
        <div class="prop-field" data-test="section-transition-out-field">
          <label class="field-label">{{ t('properties.f.transitionOut') }}</label>
          <select
            class="field-input field-control"
            data-test="section-transition-out"
            :value="sectionTransition().out || ''"
            @change="updateSectionTransition('out', ($event.target as any).value)"
          >
            <option v-for="o in TRANSITION_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <HelpHint :text="HELP.sectionTransOut" :label="t('properties.f.transitionOutLabel')" />
        </div>
        <NumberSlider
          id="section-transition-duration"
          :label="t('properties.f.duration')"
          :help="HELP.sectionTransDur"
          unit="ms"
          :min="0"
          :max="4000"
          :step="50"
          :placeholder="800"
          :modelValue="sectionTransition().duration ?? null"
          @update:modelValue="updateSectionTransition('duration', Number($event))"
        />
      </template>

      <!-- Layer props -->
      <template v-if="selected.type === 'layer'">
        <PropField :label="t('properties.f.id')" :help="HELP.layerId" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <PropField :label="t('properties.f.visible')" :help="HELP.layerVisible" :modelValue="selected.data.visible !== false" type="checkbox" @update:modelValue="updateProp('visible', $event)" />
        <NumberSlider
          id="layer-depth"
          :label="t('properties.f.depth')"
          :help="HELP.depth"
          :min="-1"
          :max="1"
          :step="0.05"
          :decimals="2"
          :modelValue="selected.data.depth"
          @update:modelValue="updateProp('depth', $event)"
        />

        <!-- parallaxMode: string[] of PARALLAX_MODES. A set of labelled
             checkboxes. Rows are a tidy 3-column grid (checkbox | label | ?)
             so the checkbox + label sit LEFT-aligned together and the "?" is
             flush right — fixes the misaligned far-right checkbox (item #2).
             An empty array = static layer (valid); only writes when toggled.
             Each mode gets its OWN per-item help. -->
        <div class="prop-group-title">{{ t('properties.groupParallax') }}</div>
        <label
          v-for="o in PARALLAX_MODE_OPTS"
          :key="o.value"
          class="parallax-row"
          :data-test="`layer-parallax-${o.value}-field`"
        >
          <input
            type="checkbox"
            class="parallax-check"
            :data-test="`layer-parallax-${o.value}`"
            :checked="isParallaxMode(o.value)"
            @change="toggleParallaxMode(o.value, ($event.target as any).checked)"
          />
          <span class="parallax-label">{{ o.label }}</span>
          <HelpHint :text="o.help" :label="o.label" />
        </label>

        <div class="prop-group-title">{{ t('properties.groupLayer') }}</div>
        <NumberSlider
          id="layer-blur"
          :label="t('properties.f.blur')"
          :help="HELP.blur"
          unit="px"
          :min="0"
          :max="60"
          :step="1"
          :modelValue="selected.data.blur"
          @update:modelValue="updateProp('blur', $event)"
        />
        <NumberSlider
          id="layer-opacity"
          :label="t('properties.f.opacity')"
          :help="HELP.layerOpacity"
          unit="%"
          display="percent"
          :min="0"
          :max="1"
          :step="0.01"
          :placeholder="1"
          :modelValue="selected.data.opacity"
          @update:modelValue="updateProp('opacity', $event)"
        />
        <PropField :label="t('properties.f.threeD')" :help="HELP.perspective3d" :modelValue="selected.data.perspective3d" type="checkbox" @update:modelValue="updateProp('perspective3d', $event)" />
        <BlendSelect
          id="layer-blend"
          :label="t('properties.f.blend')"
          :help="HELP.blend"
          :modelValue="selected.data.blendMode || ''"
          @update:modelValue="updateProp('blendMode', $event)"
        />
      </template>

      <!-- Element common props -->
      <template v-if="selected.type === 'element'">
        <PropField :label="t('properties.f.id')" :help="HELP.elementId" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <div class="prop-readonly">
          <span class="ro-label">{{ t('properties.f.type') }}</span>
          <span class="ro-value">{{ TYPE_LABELS[selected.data.type] || selected.data.type }}</span>
        </div>

        <div class="prop-group-title">{{ t('properties.groupPosition') }}</div>
        <NumberSlider
          id="element-pos-x"
          :label="t('properties.f.x')"
          :help="HELP.posX"
          unit="%"
          :min="0"
          :max="100"
          :step="1"
          :modelValue="typeof selected.data.position?.x === 'number' ? selected.data.position.x : null"
          @update:modelValue="updateNestedProp('position', 'x', $event)"
        />
        <NumberSlider
          id="element-pos-y"
          :label="t('properties.f.y')"
          :help="HELP.posY"
          unit="%"
          :min="0"
          :max="100"
          :step="1"
          :modelValue="typeof selected.data.position?.y === 'number' ? selected.data.position.y : null"
          @update:modelValue="updateNestedProp('position', 'y', $event)"
        />

        <div class="prop-group-title">{{ t('properties.groupSize') }}</div>
        <SizeField :label="t('properties.f.width')" test-id="width" :help="HELP.width" :modelValue="selected.data.size?.width" @update:modelValue="updateNestedProp('size', 'width', $event)" />
        <SizeField :label="t('properties.f.heightProp')" test-id="height" :help="HELP.height" :modelValue="selected.data.size?.height" @update:modelValue="updateNestedProp('size', 'height', $event)" />

        <div class="prop-group-title">{{ t('properties.groupStyle') }}</div>
        <PropField :label="t('properties.f.anchor')" :help="HELP.anchor" :modelValue="selected.data.anchor || 'center'" type="select" :options="[...ANCHOR_TYPES]" @update:modelValue="updateProp('anchor', $event)" />
        <NumberSlider
          id="element-opacity"
          :label="t('properties.f.opacity')"
          :help="HELP.opacity"
          unit="%"
          display="percent"
          :min="0"
          :max="1"
          :step="0.01"
          :placeholder="1"
          :modelValue="selected.data.opacity"
          @update:modelValue="updateProp('opacity', $event)"
        />
        <NumberSlider
          id="element-rotation"
          :label="t('properties.f.rotation')"
          :help="HELP.rotation"
          unit="°"
          :min="-360"
          :max="360"
          :step="1"
          :placeholder="0"
          :modelValue="selected.data.rotation"
          @update:modelValue="updateProp('rotation', $event)"
        />
        <PropField :label="t('properties.f.visible')" :help="HELP.visible" :modelValue="selected.data.visible !== false" type="checkbox" @update:modelValue="updateProp('visible', $event)" />
        <PropField :label="t('properties.f.interactive')" :help="HELP.interactive" :modelValue="selected.data.interactive" type="checkbox" @update:modelValue="updateProp('interactive', $event)" />

        <!-- Type-specific -->
        <template v-if="selected.data.type === 'png'">
          <div class="prop-group-title">{{ t('properties.groupPng') }}</div>

          <PropField :label="t('properties.f.flipX')" :help="HELP.flipX" type="checkbox" :modelValue="selected.data.flipX || false" @update:modelValue="updateProp('flipX', $event || undefined)" />
          <PropField :label="t('properties.f.flipY')" :help="HELP.flipY" type="checkbox" :modelValue="selected.data.flipY || false" @update:modelValue="updateProp('flipY', $event || undefined)" />
          <PropField :label="t('properties.f.objectFit')" :help="HELP.objectFit" type="select" :options="OBJECT_FIT_OPTS" :modelValue="selected.data.objectFit || 'cover'" @update:modelValue="updateProp('objectFit', $event === 'cover' ? undefined : $event)" />

          <div
            class="img-dropzone"
            :class="{ 'drag-over': dragOver, 'is-uploading': uploading }"
            data-test="png-dropzone"
            @dragover.prevent="dragOver = true"
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop"
          >
            <img
              v-if="selected.data.src"
              class="img-preview-thumb"
              :src="selected.data.src.startsWith('http') || selected.data.src.startsWith('/')
                ? selected.data.src
                : `/content/${state.projectType}/${state.slug}/${selected.data.src}`"
              alt=""
            />
            <div class="img-dz-text">
              <span v-if="uploading">{{ t('properties.uploading') }}</span>
              <span v-else>{{ t('properties.dropImageShort') }}</span>
            </div>
            <button
              class="img-pick-btn"
              type="button"
              data-test="png-upload-btn"
              :disabled="uploading"
              @click="fileInput?.click()"
            >Cargar imagen</button>
            <input
              ref="fileInput"
              class="img-file-input"
              type="file"
              accept="image/*"
              data-test="png-file-input"
              @change="onFilePick"
            />
          </div>
          <div v-if="uploadError" class="img-msg img-err" data-test="png-upload-error">{{ uploadError }}</div>
          <div v-if="uploadWarning" class="img-msg img-warn" data-test="png-upload-warning">{{ uploadWarning }}</div>

          <ResourceCombobox
            :label="t('properties.f.src')"
            :help="HELP.src"
            placeholder="foto.png"
            test-id="png-src"
            kind="images"
            :suggestions="imageOptions"
            :modelValue="selected.data.src || ''"
            @update:modelValue="updateProp('src', $event)"
          />
          <PropField :label="t('properties.f.alt')" :help="HELP.alt" :modelValue="selected.data.alt || ''" @update:modelValue="updateProp('alt', $event)" />
        </template>

        <template v-if="selected.data.type === 'gif'">
          <div class="prop-group-title">{{ t('properties.groupGif') }}</div>

          <PropField :label="t('properties.f.flipX')" :help="HELP.flipX" type="checkbox" :modelValue="selected.data.flipX || false" @update:modelValue="updateProp('flipX', $event || undefined)" />
          <PropField :label="t('properties.f.flipY')" :help="HELP.flipY" type="checkbox" :modelValue="selected.data.flipY || false" @update:modelValue="updateProp('flipY', $event || undefined)" />
          <PropField :label="t('properties.f.objectFit')" :help="HELP.objectFit" type="select" :options="OBJECT_FIT_OPTS" :modelValue="selected.data.objectFit || 'cover'" @update:modelValue="updateProp('objectFit', $event === 'cover' ? undefined : $event)" />

          <div
            class="img-dropzone"
            :class="{ 'drag-over': dragOver, 'is-uploading': uploading }"
            data-test="gif-dropzone"
            @dragover.prevent="dragOver = true"
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop"
          >
            <img
              v-if="selected.data.src"
              class="img-preview-thumb"
              :src="selected.data.src.startsWith('http') || selected.data.src.startsWith('/')
                ? selected.data.src
                : `/content/${state.projectType}/${state.slug}/${selected.data.src}`"
              alt=""
            />
            <div class="img-dz-text">
              <span v-if="uploading">{{ t('properties.uploading') }}</span>
              <span v-else>{{ t('properties.dropGif') }}</span>
            </div>
            <button
              class="img-pick-btn"
              type="button"
              data-test="gif-upload-btn"
              :disabled="uploading"
              @click="fileInput?.click()"
            >Cargar GIF</button>
            <input
              ref="fileInput"
              class="img-file-input"
              type="file"
              accept="image/gif"
              data-test="gif-file-input"
              @change="onFilePick"
            />
          </div>
          <div v-if="uploadError" class="img-msg img-err" data-test="gif-upload-error">{{ uploadError }}</div>
          <div v-if="uploadWarning" class="img-msg img-warn" data-test="gif-upload-warning">{{ uploadWarning }}</div>

          <ResourceCombobox
            :label="t('properties.f.src')"
            :help="HELP.src"
            placeholder="animacion.gif"
            test-id="gif-src"
            kind="images"
            :suggestions="imageOptions"
            :modelValue="selected.data.src || ''"
            @update:modelValue="updateProp('src', $event)"
          />
          <PropField :label="t('properties.f.alt')" :help="HELP.alt" :modelValue="selected.data.alt || ''" @update:modelValue="updateProp('alt', $event)" />

          <div class="prop-group-title">{{ t('properties.gifPlayback') }}</div>
          <PropField :label="t('properties.gifAutoplay')" :help="HELP.gifAutoplay" type="checkbox" :modelValue="selected.data.autoplay !== false" @update:modelValue="updateProp('autoplay', $event)" />
          <PropField :label="t('properties.gifLoop')" :help="HELP.gifLoop" type="checkbox" :modelValue="selected.data.loop !== false" @update:modelValue="updateProp('loop', $event)" />
          <PropField :label="t('properties.gifPauseOnHover')" :help="HELP.gifPauseOnHover" type="checkbox" :modelValue="selected.data.pauseOnHover === true" @update:modelValue="updateProp('pauseOnHover', $event)" />
          <PropField :label="t('properties.gifPlayDurationMs')" :help="HELP.gifPlayDurationMs" type="number" :min="0" :modelValue="selected.data.playDurationMs ?? 0" @update:modelValue="updateProp('playDurationMs', $event ? Number($event) : undefined)" />
        </template>

        <template v-if="selected.data.type === 'text'">
          <div class="prop-group-title">{{ t('properties.groupText') }}</div>
          <PropField :label="t('properties.f.content')" :help="HELP.content" :modelValue="selected.data.content" type="textarea" @update:modelValue="updateProp('content', $event)" />
          <ResourceCombobox
            :label="t('properties.f.font')"
            :help="HELP.font"
            placeholder="Tipografía (registrada o Google)"
            test-id="text-font-field"
            :suggestions="fontFamilyOptions"
            :modelValue="selected.data.font || ''"
            @update:modelValue="onTextFontChange"
          />
          <FontSizeField :help="HELP.fontSize" :modelValue="selected.data.fontSize" @update:modelValue="updateProp('fontSize', $event)" />
          <PropField :label="t('properties.f.weight')" :help="HELP.fontWeight" :modelValue="selected.data.fontWeight || 400" type="number" @update:modelValue="updateProp('fontWeight', $event)" />

          <!-- Color: native picker + hex text input — the editor's STANDARD
               color control (identical chrome/markup to the Tema color rows:
               .color-row / .field-color / .ci-text). Replaces the old tiny
               <PropField type="color"> swatch so it's visually consistent with
               the rest of the panel. The text box accepts any CSS string;
               picker mirrors the hex (hexOf falls back without overwriting a
               non-hex value until the picker actually moves). Behaviour/data
               unchanged — still writes `color` via updateProp. -->
          <div class="prop-field" data-test="text-color-field">
            <label class="field-label">{{ t('properties.f.color') }}</label>
            <span class="field-control color-row">
              <input
                type="color"
                class="field-color"
                data-test="text-color-picker"
                :value="hexOf(selected.data.color || '#000000')"
                @input="updateProp('color', ($event.target as any).value)"
              />
              <input
                type="text"
                class="field-input ci-text"
                data-test="text-color"
                placeholder="#000000"
                :value="selected.data.color || ''"
                @input="updateProp('color', ($event.target as any).value)"
              />
            </span>
            <HelpHint :text="HELP.color" :label="t('properties.f.color')" />
          </div>

          <!-- Alineación (textAlign): additive, "(heredado)" when unset.
               Labeled options need a custom <select> (PropField's select uses
               the value as the label); same row contract + HelpHint as the
               rest of the panel so it stays visually consistent. The scoped
               .element-props .field-* rules (style block) give this select the
               exact same chrome as every PropField input/select. -->
          <div class="prop-field" data-test="text-align-field">
            <label class="field-label">{{ t('properties.f.alignment') }}</label>
            <select
              class="field-input field-control"
              data-test="text-align-select"
              :value="selected.data.textAlign || ''"
              @change="onTextAlignSelect(($event.target as any).value)"
            >
              <option v-for="o in TEXT_ALIGN_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <HelpHint :text="HELP.textAlign" :label="t('properties.f.alignment')" />
          </div>

          <!-- Espacios y saltos (whiteSpace): additive, default 'pre-wrap'
               applied by the engine. Same chrome contract as textAlign. -->
          <div class="prop-field" data-test="white-space-field">
            <label class="field-label">{{ t('properties.f.whiteSpace') }}</label>
            <select
              class="field-input field-control"
              data-test="white-space-select"
              :value="selected.data.whiteSpace || ''"
              @change="onWhiteSpaceSelect(($event.target as any).value)"
            >
              <option v-for="o in WHITE_SPACE_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <HelpHint :text="HELP.whiteSpace" :label="t('properties.f.whiteSpace')" />
          </div>

          <!-- Interletra (letterSpacing): CSS length string e.g. "0.05em" /
               "1px". Stored verbatim — PropField text type never coerces. -->
          <PropField
            :label="t('properties.f.letterSpacing')"
            :help="HELP.letterSpacing"
            unit="em/px"
            placeholder="normal"
            data-test="letter-spacing-field"
            :modelValue="selected.data.letterSpacing || ''"
            @update:modelValue="updateProp('letterSpacing', $event || undefined)"
          />

          <!-- Interlínea (lineHeight): unitless number ("1.4") or a length;
               kept as-is, no coercion. -->
          <PropField
            :label="t('properties.f.lineHeight')"
            :help="HELP.lineHeight"
            unit="× / px"
            placeholder="normal"
            data-test="line-height-field"
            :modelValue="selected.data.lineHeight || ''"
            @update:modelValue="updateProp('lineHeight', $event || undefined)"
          />

          <PropField :label="t('properties.f.tag')" :help="HELP.semanticTag" :modelValue="selected.data.semanticTag" type="select" :options="[...SEMANTIC_TAGS]" @update:modelValue="updateProp('semanticTag', $event)" />
          <PropField :label="t('properties.f.split')" :help="HELP.splitMode" :modelValue="selected.data.splitMode || 'none'" type="select" :options="[...SPLIT_MODES]" @update:modelValue="updateProp('splitMode', $event)" />
          <PropField :label="t('properties.f.stagger')" :help="HELP.stagger" :modelValue="selected.data.staggerDelay || 0" type="number" :min="0" @update:modelValue="updateProp('staggerDelay', $event)" />
        </template>

        <template v-if="selected.data.type === 'video'">
          <div class="prop-group-title">{{ t('properties.groupVideo') }}</div>

          <div
            class="img-dropzone"
            :class="{ 'drag-over': dragOver, 'is-uploading': uploading }"
            data-test="video-dropzone"
            @dragover.prevent="dragOver = true"
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onMediaDrop($event, 'video')"
          >
            <video
              v-if="selected.data.src"
              class="img-preview-thumb"
              :src="previewSrc(selected.data.src)"
              muted
              playsinline
            />
            <div class="img-dz-text">
              <span v-if="uploading">{{ t('properties.uploading') }}</span>
              <span v-else>{{ t('properties.dropVideo') }}</span>
            </div>
            <button
              class="img-pick-btn"
              type="button"
              data-test="video-upload-btn"
              :disabled="uploading"
              @click="videoFileInput?.click()"
            >Cargar video</button>
            <input
              ref="videoFileInput"
              class="img-file-input"
              type="file"
              accept="video/*"
              data-test="video-file-input"
              @change="onMediaPick($event, 'video')"
            />
          </div>
          <div v-if="uploadError" class="img-msg img-err" data-test="video-upload-error">{{ uploadError }}</div>
          <div v-if="uploadWarning" class="img-msg img-warn" data-test="video-upload-warning">{{ uploadWarning }}</div>

          <ResourceCombobox
            :label="t('properties.f.font')"
            :help="HELP.videoSrc"
            test-id="video-src"
            placeholder="clip.mp4"
            kind="video"
            :suggestions="videoOptions"
            :modelValue="selected.data.src || ''"
            @update:modelValue="updateProp('src', $event)"
          />
          <ResourceCombobox
            :label="t('properties.f.poster')"
            :help="HELP.videoPoster"
            test-id="video-poster"
            placeholder="portada.jpg"
            kind="images"
            :suggestions="imageOptions"
            :modelValue="selected.data.poster || ''"
            @update:modelValue="updateProp('poster', $event || undefined)"
          />
          <PropField
            :label="t('properties.f.autoplay')"
            :help="HELP.mediaAutoplay"
            :modelValue="selected.data.autoplay ?? false"
            type="checkbox"
            data-test="video-autoplay"
            @update:modelValue="updateProp('autoplay', $event)"
          />
          <PropField
            :label="t('properties.f.muted')"
            :help="HELP.mediaMuted"
            :modelValue="selected.data.muted ?? true"
            type="checkbox"
            data-test="video-muted"
            @update:modelValue="updateProp('muted', $event)"
          />
          <PropField
            :label="t('properties.f.repeat')"
            :help="HELP.mediaLoop"
            :modelValue="selected.data.loopMedia ?? false"
            type="checkbox"
            data-test="video-loop"
            @update:modelValue="updateProp('loopMedia', $event)"
          />
          <PropField
            :label="t('properties.f.showControls')"
            :help="HELP.mediaControls"
            :modelValue="selected.data.controls ?? true"
            type="checkbox"
            data-test="video-controls"
            @update:modelValue="updateProp('controls', $event)"
          />
          <PropField
            :label="t('properties.f.playsinline')"
            :help="HELP.videoPlaysinline"
            :modelValue="selected.data.playsinline ?? true"
            type="checkbox"
            data-test="video-playsinline"
            @update:modelValue="updateProp('playsinline', $event)"
          />
          <NumberSlider
            id="video-volume"
            :label="t('properties.f.volume')"
            :help="HELP.mediaVolume"
            unit="%"
            display="percent"
            :min="0"
            :max="1"
            :step="0.01"
            :placeholder="1"
            :modelValue="selected.data.volume ?? 1"
            @update:modelValue="updateProp('volume', $event)"
          />
        </template>

        <template v-if="selected.data.type === 'audio'">
          <div class="prop-group-title">{{ t('properties.groupAudio') }}</div>

          <div
            class="img-dropzone"
            :class="{ 'drag-over': dragOver, 'is-uploading': uploading }"
            data-test="audio-dropzone"
            @dragover.prevent="dragOver = true"
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onMediaDrop($event, 'audio')"
          >
            <audio
              v-if="selected.data.src"
              class="audio-preview"
              :src="previewSrc(selected.data.src)"
              controls
            />
            <div class="img-dz-text">
              <span v-if="uploading">{{ t('properties.uploading') }}</span>
              <span v-else>{{ t('properties.dropAudio') }}</span>
            </div>
            <button
              class="img-pick-btn"
              type="button"
              data-test="audio-upload-btn"
              :disabled="uploading"
              @click="audioFileInput?.click()"
            >Cargar audio</button>
            <input
              ref="audioFileInput"
              class="img-file-input"
              type="file"
              accept="audio/*"
              data-test="audio-file-input"
              @change="onMediaPick($event, 'audio')"
            />
          </div>
          <div v-if="uploadError" class="img-msg img-err" data-test="audio-upload-error">{{ uploadError }}</div>
          <div v-if="uploadWarning" class="img-msg img-warn" data-test="audio-upload-warning">{{ uploadWarning }}</div>

          <ResourceCombobox
            :label="t('properties.f.font')"
            :help="HELP.audioSrc"
            test-id="audio-src"
            placeholder="musica.mp3"
            kind="audio"
            :suggestions="audioOptions"
            :modelValue="selected.data.src || ''"
            @update:modelValue="updateProp('src', $event)"
          />
          <PropField
            :label="t('properties.f.autoplay')"
            :help="HELP.mediaAutoplay"
            :modelValue="selected.data.autoplay ?? false"
            type="checkbox"
            data-test="audio-autoplay"
            @update:modelValue="updateProp('autoplay', $event)"
          />
          <PropField
            :label="t('properties.f.muted')"
            :help="HELP.mediaMuted"
            :modelValue="selected.data.muted ?? true"
            type="checkbox"
            data-test="audio-muted"
            @update:modelValue="updateProp('muted', $event)"
          />
          <PropField
            :label="t('properties.f.repeat')"
            :help="HELP.mediaLoop"
            :modelValue="selected.data.loopMedia ?? false"
            type="checkbox"
            data-test="audio-loop"
            @update:modelValue="updateProp('loopMedia', $event)"
          />
          <PropField
            :label="t('properties.f.showControls')"
            :help="HELP.mediaControls"
            :modelValue="selected.data.controls ?? true"
            type="checkbox"
            data-test="audio-controls"
            @update:modelValue="updateProp('controls', $event)"
          />
          <NumberSlider
            id="audio-volume"
            :label="t('properties.f.volume')"
            :help="HELP.mediaVolume"
            unit="%"
            display="percent"
            :min="0"
            :max="1"
            :step="0.01"
            :placeholder="1"
            :modelValue="selected.data.volume ?? 1"
            @update:modelValue="updateProp('volume', $event)"
          />
        </template>

        <!-- FormBlock (component/FormBlock) -->
        <template v-if="isFormBlock">
          <div class="prop-group-title">{{ t('properties.groupForm') }}</div>
          <div class="form-editor" data-test="formblock-editor">

            <!-- ── CAMPOS (the essence of a form) — FIRST, open by default ── -->
            <section class="fb-group">
              <div
                class="fb-group-head"
                data-test="formblock-group-campos"
                role="button"
                tabindex="0"
                :aria-expanded="formGroups.campos"
                @click="toggleFormGroup('campos')"
                @keydown.enter.prevent="toggleFormGroup('campos')"
                @keydown.space.prevent="toggleFormGroup('campos')"
              >
                <span class="fb-group-toggle" data-test="formblock-group-campos-toggle">{{ formGroups.campos ? '▾' : '▸' }}</span>
                <span class="fb-group-name">Campos ({{ (selected.data.props?.fields || []).length }})</span>
                <button
                  class="anim-add"
                  data-test="formblock-add-field"
                  @click.stop="addFormField()"
                  :title="t('properties.f.addField')"
                  :aria-label="t('properties.f.addField')"
                >+</button>
              </div>

              <div v-show="formGroups.campos" class="fb-group-body" data-test="formblock-group-campos-body">
                <p v-if="!(selected.data.props?.fields || []).length" class="fb-empty">
                  Aún no hay campos. Usa el botón “+” para agregar el primero.
                </p>

                <div
                  v-for="(field, fi) in (selected.data.props?.fields || [])"
                  :key="fi"
                  class="anim-card form-field-card"
                  data-test="formblock-field"
                >
                  <div class="anim-card-head">
                    <span class="anim-card-title">{{ field.label || field.name || 'Campo' }}</span>
                    <span class="form-field-actions">
                      <button class="form-field-move" data-test="formblock-field-up" :disabled="fi === 0" @click="moveFormField(fi, -1)" :title="t('properties.f.moveFieldUp')" :aria-label="t('properties.f.moveFieldUp')">&uarr;</button>
                      <button class="form-field-move" data-test="formblock-field-down" :disabled="fi === (selected.data.props?.fields || []).length - 1" @click="moveFormField(fi, 1)" :title="t('properties.f.moveFieldDown')" :aria-label="t('properties.f.moveFieldDown')">&darr;</button>
                      <button class="anim-remove" data-test="formblock-field-remove" @click="removeFormField(fi)" :title="t('common.delete')" :aria-label="t('properties.f.removeField')">&times;</button>
                    </span>
                  </div>

                  <PropField :label="t('properties.f.name')" :help="HELP.formFieldName" :modelValue="field.name || ''" @update:modelValue="updateFormField(fi, 'name', $event)" />
                  <PropField :label="t('properties.f.fieldLabel')" :help="HELP.formFieldLabel" :modelValue="field.label || ''" @update:modelValue="updateFormField(fi, 'label', $event)" />
                  <PropField :label="t('properties.f.type')" :help="HELP.formFieldType" :modelValue="field.type || 'text'" type="select" :options="FORM_FIELD_TYPE_OPTS" @update:modelValue="updateFormField(fi, 'type', $event)" />
                  <PropField :label="t('properties.f.required')" :help="HELP.formFieldRequired" :modelValue="!!field.required" type="checkbox" @update:modelValue="updateFormField(fi, 'required', $event)" />

                  <template v-if="field.type === 'select' || field.type === 'radio' || field.type === 'checkbox'">
                    <div class="prop-field form-options-field">
                      <label class="field-label">{{ t('properties.f.options') }}</label>
                      <textarea
                        class="field-input"
                        rows="3"
                        data-test="formblock-field-options"
                        :value="fieldOptionsText(field)"
                        @input="updateFormFieldOptions(fi, ($event.target as any).value)"
                      />
                      <HelpHint :text="HELP.formFieldOptions" :label="t('properties.f.options')" />
                    </div>
                  </template>

                  <template v-if="field.type === 'number'">
                    <PropField :label="t('properties.f.minValue')" :help="HELP.formFieldMin" :modelValue="field.min ?? 0" type="number" @update:modelValue="updateFormField(fi, 'min', $event)" />
                    <PropField :label="t('properties.f.maxValue')" :help="HELP.formFieldMax" :modelValue="field.max ?? 0" type="number" @update:modelValue="updateFormField(fi, 'max', $event)" />
                  </template>
                </div>
              </div>
            </section>

            <!-- ── TEXTOS (botón / éxito / error) ── -->
            <section class="fb-group">
              <div
                class="fb-group-head"
                data-test="formblock-group-textos"
                role="button"
                tabindex="0"
                :aria-expanded="formGroups.textos"
                @click="toggleFormGroup('textos')"
                @keydown.enter.prevent="toggleFormGroup('textos')"
                @keydown.space.prevent="toggleFormGroup('textos')"
              >
                <span class="fb-group-toggle" data-test="formblock-group-textos-toggle">{{ formGroups.textos ? '▾' : '▸' }}</span>
                <span class="fb-group-name">{{ t('properties.f.texts') }}</span>
              </div>

              <div v-show="formGroups.textos" class="fb-group-body" data-test="formblock-group-textos-body">
                <PropField :label="t('properties.f.button')" :help="HELP.formSubmit" :modelValue="selected.data.props?.submitLabel || ''" @update:modelValue="updateFormProp('submitLabel', $event)" />
                <PropField :label="t('properties.f.success')" :help="HELP.formSuccess" :modelValue="selected.data.props?.successMessage || ''" type="textarea" @update:modelValue="updateFormProp('successMessage', $event)" />
                <PropField :label="t('properties.f.error')" :help="HELP.formError" :modelValue="selected.data.props?.errorMessage || ''" type="textarea" @update:modelValue="updateFormProp('errorMessage', $event)" />
              </div>
            </section>

            <!-- ── ESTILO (friendly color/font controls, no raw CSS) ── -->
            <section class="fb-group">
              <div
                class="fb-group-head"
                data-test="formblock-group-estilo"
                role="button"
                tabindex="0"
                :aria-expanded="formGroups.estilo"
                @click="toggleFormGroup('estilo')"
                @keydown.enter.prevent="toggleFormGroup('estilo')"
                @keydown.space.prevent="toggleFormGroup('estilo')"
              >
                <span class="fb-group-toggle" data-test="formblock-group-estilo-toggle">{{ formGroups.estilo ? '▾' : '▸' }}</span>
                <span class="fb-group-name">{{ t('properties.groupStyle') }}</span>
              </div>

              <div v-show="formGroups.estilo" class="fb-group-body" data-test="formblock-group-estilo-body">
                <FormColorField
                  :label="t('properties.f.inputBg')"
                  testKey="inputBg"
                  :help="HELP.formInputBg"
                  :modelValue="selected.data.props?.styling?.inputBg || ''"
                  @update:modelValue="updateFormStyling('inputBg', $event)"
                />
                <FormColorField
                  :label="t('properties.f.textColor')"
                  testKey="inputText"
                  :help="HELP.formInputText"
                  :modelValue="selected.data.props?.styling?.inputText || ''"
                  @update:modelValue="updateFormStyling('inputText', $event)"
                />
                <FormColorField
                  :label="t('properties.f.inputBorder')"
                  testKey="inputBorder"
                  :help="HELP.formInputBorder"
                  :modelValue="selected.data.props?.styling?.inputBorder || ''"
                  @update:modelValue="updateFormStyling('inputBorder', $event)"
                />
                <FormColorField
                  :label="t('properties.f.buttonBg')"
                  testKey="buttonBg"
                  :help="HELP.formButtonBg"
                  :modelValue="selected.data.props?.styling?.buttonBg || ''"
                  @update:modelValue="updateFormStyling('buttonBg', $event)"
                />
                <FormColorField
                  :label="t('properties.f.buttonText')"
                  testKey="buttonText"
                  :help="HELP.formButtonText"
                  :modelValue="selected.data.props?.styling?.buttonText || ''"
                  @update:modelValue="updateFormStyling('buttonText', $event)"
                />

                <div class="prop-field" data-test="formblock-style-fontFamily">
                  <label class="field-label">{{ t('properties.f.typography') }}</label>
                  <select
                    class="field-input field-control"
                    data-test="formblock-style-fontFamily-select"
                    :value="fontSelectValue(selected.data.props?.styling?.fontFamily || '')"
                    @change="onFontSelect(($event.target as any).value)"
                  >
                    <option v-for="o in FORM_FONT_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                  <HelpHint :text="HELP.formFont" :label="t('properties.f.typography')" />
                </div>
                <div
                  v-if="isCustomFont(selected.data.props?.styling?.fontFamily || '')"
                  class="prop-field"
                >
                  <label class="field-label">{{ t('properties.f.custom') }}</label>
                  <input
                    type="text"
                    class="field-input field-control"
                    data-test="formblock-style-fontFamily-custom"
                    placeholder="ej. Georgia, serif"
                    :value="(selected.data.props?.styling?.fontFamily || '').trim()"
                    @input="updateFormStyling('fontFamily', ($event.target as any).value)"
                  />
                </div>
              </div>
            </section>

            <!-- ── AVANZADO (webhook / honeypot) — collapsed by default ── -->
            <section class="fb-group">
              <div
                class="fb-group-head"
                data-test="formblock-group-avanzado"
                role="button"
                tabindex="0"
                :aria-expanded="formGroups.avanzado"
                @click="toggleFormGroup('avanzado')"
                @keydown.enter.prevent="toggleFormGroup('avanzado')"
                @keydown.space.prevent="toggleFormGroup('avanzado')"
              >
                <span class="fb-group-toggle" data-test="formblock-group-avanzado-toggle">{{ formGroups.avanzado ? '▾' : '▸' }}</span>
                <span class="fb-group-name">{{ t('properties.f.advanced') }}</span>
              </div>

              <div v-show="formGroups.avanzado" class="fb-group-body" data-test="formblock-group-avanzado-body">
                <PropField :label="t('properties.f.webhook')" :help="HELP.formWebhook" :modelValue="selected.data.props?.webhookUrl || ''" @update:modelValue="updateFormProp('webhookUrl', $event)" />
                <PropField :label="t('properties.f.honeypot')" :help="HELP.formHoneypot" :modelValue="selected.data.props?.honeypotField || ''" @update:modelValue="updateFormProp('honeypotField', $event)" />
              </div>
            </section>

          </div>
        </template>

        <!-- Custom component (registered via parallax.config.ts).
             GENERIC editableProps → controls renderer (PLAN §13). FormBlock
             is excluded (its dedicated accordion above stays). Props NOT in
             editableProps are never shown. -->
        <template v-if="componentRegistration">
          <div class="prop-group-title">{{ componentRegistration.label }}</div>
          <ComponentPropsEditor :registration="componentRegistration" />
        </template>

        <!-- Component element whose name isn't a built-in and isn't in the
             registry (config absent/failed, or component removed). The
             read-only Tipo stays above; this just makes the situation legible
             instead of an empty panel. -->
        <template v-if="isUnknownComponent">
          <div class="prop-group-title">{{ t('properties.groupComponent') }}</div>
          <p class="prop-unknown-note" data-test="component-unknown-note">
            Componente “{{ selected.data.name }}” no está registrado en este
            proyecto. Verifica parallax.config.ts del sitio.
          </p>
        </template>

        <!-- Link: Ninguno | URL | Sitio. "Ninguno" removes the link entirely;
             "URL" keeps the existing href/target fields; "Sitio" navigates
             in-engine to another workspace project (link = { site: '<slug>' }).
             Every write goes through setAtPath('<selectedPath>.link', …). -->
        <div class="prop-group-title">{{ t('properties.groupLink') }}</div>
        <div class="prop-field" data-test="link-mode-field">
          <label class="field-label">{{ t('properties.f.type') }}</label>
          <select
            class="field-input field-control"
            data-test="link-mode"
            :value="linkMode"
            @change="onLinkModeChange(($event.target as any).value)"
          >
            <option v-for="o in LINK_MODE_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <HelpHint :text="HELP.linkMode" :label="t('properties.f.linkType')" />
        </div>

        <template v-if="linkMode === 'url'">
          <PropField :label="t('properties.f.url')" :help="HELP.linkUrl" :modelValue="selected.data.link?.href || ''" @update:modelValue="updateNestedProp('link', 'href', $event)" />
          <PropField :label="t('properties.f.target')" :help="HELP.linkTarget" :modelValue="selected.data.link?.target || '_blank'" type="select" :options="['_blank', '_self']" @update:modelValue="updateNestedProp('link', 'target', $event)" />
        </template>

        <template v-else-if="linkMode === 'site'">
          <div class="prop-field" data-test="link-site-field">
            <label class="field-label">{{ t('properties.f.site') }}</label>
            <select
              v-if="otherProjectSlugs.length"
              class="field-input field-control"
              data-test="link-site"
              :value="selected.data.link?.site || ''"
              @change="onLinkSiteChange(($event.target as any).value)"
            >
              <option v-for="slug in otherProjectSlugs" :key="slug" :value="slug">{{ slug }}</option>
            </select>
            <span v-else class="field-control link-site-empty" data-test="link-site-empty">
              {{ t('properties.noOtherSites') }}
            </span>
            <HelpHint :text="HELP.linkSite" :label="t('properties.f.targetSite')" />
          </div>
        </template>

        <!-- Animations sub-panel -->
        <div class="prop-group-title anim-header">
          <span>{{ t('properties.animHeader', { count: selected.data.animations?.length || 0 }) }}</span>
          <span class="anim-header-actions">
            <button
              class="anim-help-btn"
              data-test="anim-help-open"
              @click="openAnimHelp()"
              :title="t('properties.animGuideTitle')"
              :aria-label="t('properties.f.openAnimGuide')"
            >?</button>
            <button class="anim-add" @click="addAnimation()" :title="t('properties.f.addAnim')" :aria-label="t('properties.f.addAnim')">+</button>
          </span>
        </div>

        <div
          v-for="(anim, i) in (selected.data.animations || [])"
          :key="i"
          class="anim-card"
        >
          <div class="anim-card-head">
            <span class="anim-card-title">{{ anim.type }} · {{ anim.trigger }}</span>
            <button class="anim-remove" @click="removeAnimation(i)" :title="t('common.delete')" :aria-label="t('properties.f.removeAnim')">&times;</button>
          </div>

          <PropField
            :label="t('properties.f.type')"
            :help="HELP.animType"
            :modelValue="anim.type"
            type="select"
            :options="ANIM_TYPE_OPTS"
            @update:modelValue="updateAnim(i, 'type', $event)"
          />
          <PropField
            :label="t('properties.f.trigger')"
            :help="HELP.animTrigger"
            :modelValue="anim.trigger"
            type="select"
            :options="TRIGGER_OPTS"
            @update:modelValue="updateAnim(i, 'trigger', $event)"
          />
          <PropField
            :label="t('properties.f.fromVal')"
            :help="HELP.animFrom"
            :modelValue="anim.from"
            type="number"
            @update:modelValue="updateAnim(i, 'from', $event)"
          />
          <PropField
            :label="t('properties.f.toVal')"
            :help="HELP.animTo"
            :modelValue="anim.to"
            type="number"
            @update:modelValue="updateAnim(i, 'to', $event)"
          />

          <template v-if="anim.trigger === 'depends'">
            <ResourceCombobox
              :label="t('properties.f.dependsOn')"
              :help="HELP.animDependsOn"
              :placeholder="t('properties.dependsPlaceholder')"
              :test-id="`anim-depends-on-${i}`"
              :suggestions="allElementOptions"
              :modelValue="anim.dependsOn || ''"
              @update:modelValue="updateAnim(i, 'dependsOn', $event || undefined)"
            />
            <div class="prop-field" :data-test="`anim-depends-event-row-${i}`">
              <label class="field-label">{{ t('properties.f.when') }}</label>
              <select
                class="field-input field-control"
                :value="anim.dependsEvent || ''"
                :data-test="`anim-depends-event-${i}`"
                @change="updateAnim(i, 'dependsEvent', ($event.target as HTMLSelectElement).value || undefined)"
              >
                <option value="">{{ t('properties.dependsEventChoose') }}</option>
                <option v-for="opt in DEPENDS_EVENT_OPTS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
              <HelpHint :text="HELP.animDependsEvent" :label="t('properties.f.when')" />
            </div>
          </template>

          <template v-if="anim.trigger === 'scroll'">
            <div class="anim-range-row" :data-test="`anim-range-row-${i}`">
              <RangeSlider
                :id="`anim-range-${i}`"
                :label="t('properties.f.scrollRange')"
                :help="HELP.animRange"
                :min="0"
                :max="100"
                :step="1"
                :decimals="0"
                unit="%"
                display="percent"
                fromLabel="Inicio %"
                toLabel="Fin %"
                :modelValue="(Array.isArray(anim.range) ? anim.range : [0, 1]) as [number, number]"
                @update:modelValue="updateAnim(i, 'range', $event)"
              />
            </div>
          </template>

          <NumberSlider
            :id="`anim-${i}-duration`"
            :label="t('properties.f.duration')"
            :help="HELP.animDuration"
            unit="ms"
            :min="0"
            :max="4000"
            :step="50"
            :placeholder="800"
            :modelValue="anim.duration ?? 800"
            @update:modelValue="updateAnim(i, 'duration', $event)"
          />
          <NumberSlider
            :id="`anim-${i}-delay`"
            :label="t('properties.f.delay')"
            :help="HELP.animDelay"
            unit="ms"
            :min="0"
            :max="4000"
            :step="50"
            :placeholder="0"
            :modelValue="anim.delay ?? 0"
            @update:modelValue="updateAnim(i, 'delay', $event)"
          />
          <PropField
            :label="t('properties.f.easing')"
            :help="HELP.animEasingShort"
            :modelValue="anim.easing || 'easeInOut'"
            type="select"
            :options="EASING_OPTS"
            @update:modelValue="updateAnim(i, 'easing', $event)"
          />
          <button
            class="easing-guide-link"
            data-test="easing-help-open"
            @click="openAnimHelp('easing')"
          >{{ t('properties.easingGuideLink') }}</button>

          <template v-if="anim.trigger === 'loop'">
            <PropField
              :label="t('properties.f.loop')"
              :help="HELP.animLoop"
              :modelValue="anim.loop ?? true"
              type="checkbox"
              @update:modelValue="updateAnim(i, 'loop', $event)"
            />
            <PropField
              :label="t('properties.f.yoyo')"
              :help="HELP.animYoyo"
              :modelValue="anim.yoyo ?? false"
              type="checkbox"
              @update:modelValue="updateAnim(i, 'yoyo', $event)"
            />
          </template>
        </div>
      </template>
      </div>
    </div>

    <AnimationsHelpModal v-if="animHelpOpen" :focus-section="animHelpSection" @close="animHelpOpen = false" />
  </div>
</template>

<style scoped>
.properties-panel { background: #1e1e1e; font-size: 13px; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.panel-header { padding: 10px 12px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 1px solid #333; flex-shrink: 0; }
.panel-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.prop-unknown-note { font-size: 11px; color: #c98a3a; line-height: 1.4; padding: 4px 0 8px; }
.link-site-empty { font-size: 11px; color: #8a8a8a; line-height: 1.4; }
.empty-state { padding: 24px 12px; color: #666; text-align: center; font-size: 12px; }
.props-content { padding: 8px 12px; }
.prop-section-title { font-weight: 600; font-size: 14px; margin-bottom: 8px; text-transform: capitalize; }
.prop-group-title { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 12px; margin-bottom: 4px; padding-top: 8px; border-top: 1px solid #333; }
.prop-readonly { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.ro-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.ro-value { flex: 1; font-size: 12px; color: #aaa; background: #242424; border: 1px solid #333; border-radius: 4px; padding: 4px 8px; }
/* Parallax mode checkboxes (item #2): a tidy left-aligned row — checkbox,
   label, then the "?" pushed flush-right. The whole row is a <label> so
   clicking the text also toggles the box. Consistent 18px checkbox column so
   every row's checkbox + label line up vertically. */
.parallax-row {
  display: flex; align-items: center; gap: 8px;
  padding: 3px 0; max-width: 100%; cursor: pointer;
}
.parallax-check {
  flex: 0 0 16px; width: 16px; height: 16px; margin: 0;
  accent-color: var(--accent-strong); cursor: pointer;
}
.parallax-label { flex: 1 1 auto; min-width: 0; font-size: 12px; color: #ccc; }

.anim-header { display: flex; align-items: center; justify-content: space-between; }
.anim-header-actions { display: flex; align-items: center; gap: 6px; }
.anim-add { background: #2a7d2a; border: none; color: #fff; width: 20px; height: 20px; border-radius: 4px; cursor: pointer; font-size: 13px; line-height: 1; }
.anim-add:hover { background: #339933; }
/* Animations guide "?" — sits BEFORE the "+" (item #4). Round, matches the
   per-control HelpHint "?" chrome but a touch larger for the section header. */
.anim-help-btn {
  width: 18px; height: 18px; border-radius: 50%;
  background: #2f2f2f; border: 1px solid #4a4a4a; color: #9a9a9a;
  font-size: 11px; line-height: 1; font-weight: 700; cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.anim-help-btn:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.easing-guide-link {
  background: none; border: none; color: var(--accent-strong); cursor: pointer;
  font-size: 11px; padding: 2px 0 6px; text-align: left; display: block;
}
.easing-guide-link:hover { color: var(--accent-hover); text-decoration: underline; }
.anim-card { background: #242424; border: 1px solid #333; border-radius: 6px; padding: 8px; margin: 6px 0; }
.anim-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.anim-card-title { font-size: 11px; color: var(--accent-strong); text-transform: capitalize; }
.anim-remove { background: none; border: none; color: #888; font-size: 15px; cursor: pointer; line-height: 1; }
.anim-remove:hover { color: #ff6b6b; }
/* Wraps the stacked RangeSlider (#109): a plain block that lets the slider use
   the full panel content width across its two rows. Never overflows. */
.anim-range-row { max-width: 100%; box-sizing: border-box; min-width: 0; }
.field-label-inline { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.anim-range-inputs { flex: 1 1 auto; min-width: 0; display: flex; gap: 6px; }
.anim-range-input { flex: 1 1 0; min-width: 0; width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; }

.img-dropzone { display: flex; flex-direction: column; align-items: center; gap: 8px; border: 1.5px dashed #444; border-radius: 6px; padding: 12px; background: #242424; margin: 4px 0 8px; text-align: center; transition: border-color 0.15s, background 0.15s; }
.img-dropzone.drag-over { border-color: var(--accent-strong); background: #242c38; }
.img-dropzone.is-uploading { opacity: 0.7; }
.img-preview-thumb { max-width: 100%; max-height: 90px; border-radius: 4px; object-fit: contain; background: repeating-conic-gradient(#2a2a2a 0% 25%, #1e1e1e 0% 50%) 50% / 16px 16px; }
.audio-preview { width: 100%; height: 32px; }
.img-dz-text { font-size: 11px; color: #888; }
.img-pick-btn { background: var(--accent); border: none; color: var(--accent-fg); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: background .12s ease; }
.img-pick-btn:hover:not(:disabled) { background: var(--accent-hover); }
.img-pick-btn:disabled { opacity: 0.6; cursor: default; }
.img-file-input { display: none; }
.form-field-card { border-color: #3a3a4a; }
.form-field-actions { display: flex; align-items: center; gap: 4px; }
.form-field-move { background: none; border: none; color: #888; font-size: 12px; cursor: pointer; line-height: 1; padding: 0 2px; }
.form-field-move:hover:not(:disabled) { color: var(--accent-strong); }
.form-field-move:disabled { opacity: 0.3; cursor: default; }
/* The hand-rolled "Opciones" row mirrors PropField's row contract so its "?"
   never overflows the panel (PropField's scoped styles don't leak here). */
.form-options-field { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; max-width: 100%; }
.form-options-field .field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; padding-top: 4px; }
.form-options-field .field-input { flex: 1 1 auto; min-width: 0; width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit; resize: vertical; }

/* ── FormBlock typography controls: editor field styling (issue #55) ────────
   The Tipografía <select> and the "Personalizada" <input> are hand-rolled
   inline (not <PropField>), so PropField's SCOPED .field-* styles don't reach
   them and they were rendering as bare browser default controls — visually
   inconsistent with every other panel field. Re-declare the SAME contract here
   (PropField.vue's .prop-field / .field-label / .field-control / .field-input
   /.field-input:focus, byte-for-byte) scoped to the FormBlock editor so these
   match the rest of the panel exactly. Markup/behaviour unchanged. */
.form-editor .prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.form-editor .prop-field .field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.form-editor .prop-field .field-control { flex: 1 1 auto; min-width: 0; }
.form-editor .prop-field .field-input {
  width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444;
  border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit;
}
.form-editor .prop-field .field-input:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }

/* ── FormBlock accordion groups ──────────────────────────────────────────── */
.form-editor { max-width: 100%; }
.fb-group { border: 1px solid #333; border-radius: 6px; margin: 8px 0; overflow: hidden; background: #1f1f1f; }
.fb-group-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; cursor: pointer; user-select: none;
  background: #262626; border-bottom: 1px solid transparent;
}
.fb-group-head:hover { background: #2c2c2c; }
.fb-group-head:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.fb-group-toggle { font-size: 11px; color: #888; width: 12px; flex: 0 0 12px; }
.fb-group-name {
  flex: 1 1 auto; font-size: 12px; font-weight: 600; color: #ddd;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.fb-group-body { padding: 8px 10px; border-top: 1px solid #333; }
.fb-empty { font-size: 11px; color: #777; margin: 4px 0; line-height: 1.4; }

.img-msg { font-size: 11px; padding: 4px 8px; border-radius: 4px; margin-bottom: 6px; }
.img-err { color: #ff8a8a; background: #3a1f1f; border: 1px solid #5a2a2a; }
.img-warn { color: #ffd27a; background: #3a321f; border: 1px solid #5a4a2a; }

/* ── Sitio / Tema (global) ────────────────────────────────────────────────
   Reuse PropField's row contract. Inline color rows pair the native picker
   with a text field (theme colors can be any CSS string, not just hex). The
   inline .prop-field selects/inputs re-declare PropField's scoped styles so
   they match the rest of the panel exactly. */
.global-note { font-size: 11px; color: #8a8a8a; line-height: 1.5; margin: 2px 0 8px; }
.props-content[data-test='props-site'] .prop-field,
.props-content[data-test='props-theme'] .prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.props-content[data-test='props-site'] .field-label,
.props-content[data-test='props-theme'] .field-label { font-size: 11px; color: #999; min-width: 80px; flex-shrink: 0; }
.props-content[data-test='props-site'] .field-control,
.props-content[data-test='props-theme'] .field-control { flex: 1 1 auto; min-width: 0; }
.props-content[data-test='props-site'] .field-input,
.props-content[data-test='props-theme'] .field-input {
  width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444;
  border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit;
}
.props-content[data-test='props-site'] .field-input:focus,
.props-content[data-test='props-theme'] .field-input:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
.color-row { display: flex; align-items: center; gap: 8px; }
.color-row .field-color { width: 32px; height: 24px; flex: 0 0 32px; border: 1px solid #444; border-radius: 4px; padding: 0; cursor: pointer; background: #2a2a2a; }
.color-row .ci-text { flex: 1 1 auto; min-width: 0; }

/* ── Element props (text/png/video/… , the generic v-else props-content) ───
   The TEXTO section mixes <PropField> (which ships its OWN scoped .field-*
   styles) with two hand-rolled rows — Alineación (a labeled <select>) and
   Color (native picker + hex text). PropField's scoped styles do NOT leak
   into these inline controls, so without this block they fell back to bare
   browser chrome — visually inconsistent with every other panel field
   (issue #90). Re-declare PropField.vue's row contract BYTE-FOR-BYTE
   (.prop-field / .field-label / .field-control / .field-input /
   .field-input:focus, label min-width:70px to match) scoped to the element
   panel so Alineación and Color are pixel-consistent with the rest. The
   .color-row/.field-color/.ci-text rules above give the Color row the exact
   same chrome as the Tema color rows. Markup/behaviour unchanged. */
.props-content[data-test='props-element'] .prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.props-content[data-test='props-element'] .field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.props-content[data-test='props-element'] .field-control { flex: 1 1 auto; min-width: 0; }
.props-content[data-test='props-element'] .field-input {
  width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444;
  border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit;
}
.props-content[data-test='props-element'] .field-input:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
.fb-empty { font-size: 11px; color: #777; margin: 4px 0; line-height: 1.4; }

/* ── Homogenize <select> chevron (issue: inconsistent dropdown arrows) ──────
   Every hand-rolled <select.field-input> in this panel (Alineación, Tag,
   Dirección del scroll, Tipo de fondo, transiciones Entrada/Salida, Tipografía,
   "Cuando", etc.) was showing the native OS arrow flush to the right edge,
   while shared controls (PropField / GradientBuilder) use a custom chevron.
   Match that exact chevron here, panel-wide, so every select is identical.
   Strip the native appearance and paint the same SVG chevron with the same
   right-side gap. Styling only — no markup/behaviour change. */
.properties-panel .props-content select.field-input,
.properties-panel .form-editor select.field-input {
  /* Specificity (0,3,1) deliberately beats the scoped .props-content[data-test]
     .field-input rules (0,3,0) above — those use the `background` shorthand
     (which would reset background-image) and `padding:4px 8px` (which would
     reset padding-right), so a weaker rule could not paint the chevron. */
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  padding-right: 28px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='7' viewBox='0 0 10 7'><path d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
</style>
