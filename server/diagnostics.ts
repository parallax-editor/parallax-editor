// ─── Diagnóstico de entorno (FASE 4 — pantalla doctor) ───────────────────────
//
// Agrega el estado de las herramientas que el editor necesita en la máquina del
// usuario y lo sirve en GET /api/diagnostics. La pantalla doctor (primer
// arranque / menú Ayuda) lo pinta con guía en español.
//
//   git    → ¿hay user.name/user.email global? (necesario para commit/push)
//   claude → ¿está el CLI `claude` en PATH? (botón "Hablar con Claude")
//   aws    → ¿hay credenciales? (OPCIONAL: solo si el workspace publica a S3)
//
// También devolvemos dónde resolvió cada binario (`bins`) — útil para depurar el
// problema clásico de PATH al abrir desde Finder (ver electron/path-fix.cjs).

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { gitConfigStatus } from './git'
import { isClaudeAvailable } from './claude'

/** Ruta del binario `bin` según el PATH actual del proceso, o null. */
function which(bin: string): string | null {
  try {
    const out = execSync(`command -v ${bin}`, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const p = out.toString().trim()
    return p || null
  } catch {
    return null
  }
}

export interface AwsStatus {
  configured: boolean
  /** De dónde salen las credenciales (para mostrarle al usuario). */
  source: string | null
}

/**
 * ¿Hay credenciales de AWS resolubles SIN llamar a la red? Heurística barata:
 * archivos ~/.aws/{credentials,config} o variables de entorno estándar. La SDK
 * usa la cadena de credenciales por defecto; esto solo decide qué mostrar.
 */
export function awsStatus(): AwsStatus {
  const home = homedir()
  const hasFiles =
    existsSync(join(home, '.aws', 'credentials')) || existsSync(join(home, '.aws', 'config'))
  const hasEnv = !!(
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_PROFILE ||
    process.env.AWS_ROLE_ARN ||
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  )
  return {
    configured: hasFiles || hasEnv,
    source: hasFiles ? 'archivo (~/.aws)' : hasEnv ? 'variables de entorno' : null,
  }
}

export interface Diagnostics {
  git: ReturnType<typeof gitConfigStatus>
  claude: { available: boolean }
  aws: AwsStatus
  // Solo las CLIs que importan en la máquina del usuario. NO va `node` (Electron
  // trae su propio runtime embebido — el usuario NO necesita Node instalado) ni
  // `aws` (el editor usa el SDK JS, lee ~/.aws / env, nunca el CLI).
  bins: { git: string | null; claude: string | null }
}

export function getDiagnostics(): Diagnostics {
  return {
    git: gitConfigStatus(),
    claude: { available: isClaudeAvailable() },
    aws: awsStatus(),
    bins: {
      git: which('git'),
      claude: which('claude'),
    },
  }
}
