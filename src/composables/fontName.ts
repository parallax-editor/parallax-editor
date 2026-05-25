// Deriva un nombre de familia legible a partir del nombre de archivo de una
// fuente subida a Recursos (`content/<slug>/fonts/<archivo>`). UN solo lugar
// para esta lógica: la usan el registro automático al SUBIR en Recursos, el
// auto-registro al ELEGIR una fuente en Propiedades, el preview del dropdown y
// las sugerencias del selector. Si cada sitio derivara distinto, el selector
// ofrecería un nombre y el registro guardaría otro → `meta.fonts[].family` no
// coincidiría con el `font` del elemento y la fuente NO se aplicaría.
//
// "marderey-semibolditalic.otf" → "Marderey Semibolditalic".
export function fileToFontFamily(filename: string): string {
  return filename
    .replace(/\.(ttf|otf|woff2?|woff)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
