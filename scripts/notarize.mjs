#!/usr/bin/env node
// ─── Notarize hook para electron-builder (Bloque D) ──────────────────────────
//
// electron-builder invoca este script como `afterAllArtifactBuild` con un
// context que incluye `artifactPaths` (los .dmg recién generados). Aquí
// llamamos a `xcrun notarytool submit` para cada .dmg + hacemos `stapler
// staple` en éxito.
//
// Requisitos (via env — típicamente inyectados por GitHub Actions):
//   APPLE_ID              → tu Apple ID
//   APPLE_ID_PASSWORD     → app-specific password generado en appleid.apple.com
//   APPLE_TEAM_ID         → Team ID de tu Developer Program
//
// Si CUALQUIER credencial falta, el script imprime un warning y sale con 0
// (no-op). Esto permite `yarn dist:mac` en local sin cuenta de Apple → el
// .dmg queda firmado ad-hoc (o unsigned si tampoco hay CSC_LINK) sin bloquear.
//
// NOTA: notarytool NECESITA que la app YA esté firmada con un Developer ID.
// Sin firma, esta llamada falla clara. La firma la hace electron-builder
// cuando ve CSC_LINK / CSC_KEY_PASSWORD en el env.

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export default async function notarizeArtifacts(context) {
  const { APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_ID_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Faltan credenciales Apple — saltando notarize (build local unsigned OK).')
    return
  }
  const artifacts = (context?.artifactPaths || []).filter((p) => p.endsWith('.dmg'))
  if (artifacts.length === 0) {
    console.log('[notarize] No hay .dmg para notarizar.')
    return
  }
  for (const dmg of artifacts) {
    if (!existsSync(dmg)) { console.warn(`[notarize] No existe: ${dmg}`); continue }
    console.log(`[notarize] Enviando ${dmg} a Apple…`)
    try {
      execSync(
        `xcrun notarytool submit "${dmg}" \
          --apple-id "${APPLE_ID}" \
          --team-id "${APPLE_TEAM_ID}" \
          --password "${APPLE_ID_PASSWORD}" \
          --wait --timeout 30m`,
        { stdio: 'inherit' },
      )
      console.log(`[notarize] Notarizado. Stapling ticket a ${dmg}…`)
      execSync(`xcrun stapler staple "${dmg}"`, { stdio: 'inherit' })
      console.log(`[notarize] ✓ ${dmg}`)
    } catch (e) {
      // Sin catch propagable: dejamos que electron-builder marque el build
      // como fallido si el notarize revienta (no queremos publicar un .dmg
      // que no pasa Gatekeeper cuando había intención de firmarlo).
      console.error(`[notarize] Fallo notarizando ${dmg}:`, e?.message)
      throw e
    }
  }
}
