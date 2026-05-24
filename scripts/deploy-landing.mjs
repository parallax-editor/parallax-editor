// ─── Publica la landing estática al bucket público ───────────────────────────
//
//   yarn deploy:landing        (o: node scripts/deploy-landing.mjs)
//
// Sube landing/ (index.html, editor.html, style.css, icon.png) a
// s3://parallax-engine/. NO toca los .dmg ni versions.json — eso lo maneja el
// release (yarn release). La página de descarga (editor.html) enlaza a
// `latest.dmg`, que vive en el mismo bucket.

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUCKET = 'parallax-engine'
const REGION = 'us-east-1'
const LANDING = resolve(ROOT, 'landing')

// Sin --delete (el bucket también tiene los .dmg/versions.json del release, que
// NO deben borrarse). Aditivo: sube/actualiza solo los archivos de la landing.
console.log(`▶ Subiendo landing/ → s3://${BUCKET}/ …`)
execSync(
  `aws s3 sync "${LANDING}" "s3://${BUCKET}/" --region ${REGION} --cache-control "no-cache"`,
  { stdio: 'inherit' },
)
console.log(`✓ Landing publicada → http://${BUCKET}.s3-website-${REGION}.amazonaws.com`)
