// ─── Fix de PATH para apps lanzadas desde Finder (FASE 3) ─────────────────────
//
// Una app de macOS abierta desde Finder/Launchpad hereda un PATH MÍNIMO
// (`/usr/bin:/bin:/usr/sbin:/sbin`) — NO el de tu terminal. Por eso `claude`,
// `git` o `node` instalados vía Homebrew/nvm/npm-global (que viven en
// /opt/homebrew/bin, ~/.local/bin, etc.) "no se encuentran" cuando el editor
// hace `spawn('claude'…)` o `spawn('git'…)`.
//
// Arreglo: preguntarle al SHELL DE LOGIN del usuario por su PATH real (sourcea
// .zprofile/.zshrc/.bash_profile) y mezclarlo con una lista de rutas comunes.
// Se llama UNA vez al arrancar el proceso principal, ANTES de levantar el
// server in-process, así todos los `spawn` heredan el PATH corregido.

const { execFileSync } = require('child_process')
const path = require('path')
const os = require('os')

/** PATH real del shell de login del usuario (o null si no se pudo obtener). */
function loginShellPath() {
  if (process.platform === 'win32') return null
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    // -i -l -c: interactive + login → sourcea .zprofile/.zshrc (zsh) o
    // .bash_profile/.bashrc (bash). Usamos un sentinel para extraer SOLO el
    // PATH y descartar cualquier ruido del prompt. Timeout corto: si el shell
    // del usuario cuelga, seguimos con los fallbacks.
    const out = execFileSync(shell, ['-ilc', 'printf "__PXPATH__%s__PXEND__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = out.match(/__PXPATH__([\s\S]*?)__PXEND__/)
    return m && m[1] ? m[1] : null
  } catch {
    return null
  }
}

/**
 * Mezcla en `process.env.PATH`: lo que ya hay + el PATH del shell de login +
 * rutas comunes de macOS donde viven los binarios. Idempotente. Devuelve el
 * PATH resultante.
 */
function fixPath() {
  const parts = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean))

  const fromShell = loginShellPath()
  if (fromShell) {
    for (const p of fromShell.split(path.delimiter).filter(Boolean)) parts.add(p)
  }

  // Fallbacks: Homebrew (Apple Silicon + Intel), sistema, y rutas de usuario
  // habituales para node/npm/herramientas locales.
  const home = os.homedir()
  const fallbacks = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'bin'),
  ]
  for (const p of fallbacks) parts.add(p)

  process.env.PATH = Array.from(parts).join(path.delimiter)
  return process.env.PATH
}

module.exports = { fixPath, loginShellPath }
