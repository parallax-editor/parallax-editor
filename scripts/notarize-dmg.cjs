// ─── afterAllArtifactBuild hook: notariza + staplea cada .dmg ────────────────
//
// electron-builder notariza y staplea el `.app` de adentro, pero NO el `.dmg`
// que envuelve (la notarización corre sobre el app, antes de construir el dmg).
// Resultado: `xcrun stapler validate <dmg>` falla y el archivo descargado no
// valida offline. Este hook cierra ese hueco: submit del dmg a notarytool +
// staple del ticket, para que el .dmg que baja el usuario valide por sí solo.
//
// Credenciales por env (las mismas que usa la firma). Si faltan, no rompe el
// build (p.ej. `dist:dir` no genera dmg → lista vacía): solo avisa y sigue.

const { execFileSync } = require('node:child_process')

exports.default = async function notarizeDmgs(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'))
  if (dmgs.length === 0) return

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.warn('⚠ notarize-dmg: faltan APPLE_API_* en el entorno → dmg queda SIN staple')
    return
  }

  const xcrun = (args) => execFileSync('xcrun', args, { stdio: 'inherit' })
  for (const dmg of dmgs) {
    console.log(`\n▶ notarize-dmg: submit ${dmg}`)
    xcrun([
      'notarytool', 'submit', dmg,
      '--key', APPLE_API_KEY,
      '--key-id', APPLE_API_KEY_ID,
      '--issuer', APPLE_API_ISSUER,
      '--wait',
    ])
    console.log(`▶ notarize-dmg: staple ${dmg}`)
    xcrun(['stapler', 'staple', dmg])
  }
}
