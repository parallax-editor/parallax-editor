// ─── Native folder picker (macOS) ──────────────────────────────────────────────
//
// The editor runs LOCALLY on Daniela's Mac (never deployed). To let her point a
// workspace at a folder without typing an absolute path, we shell out to
// AppleScript's `choose folder`, which opens the native Finder picker and
// returns the chosen path. Cancelling raises a "User canceled" error which we
// translate into a clean { canceled:true } result (NOT an error the UI must
// explain).
//
// macOS only by design (this editor only runs on Daniela's Mac). On any other
// platform / if osascript is missing, we degrade to { ok:false } with a Spanish
// hint so the user can fall back to typing the path manually.

import { execFile } from 'child_process'

export interface PickFolderResult {
  ok: boolean
  /** POSIX absolute path of the chosen folder. */
  path?: string
  /** True when the user pressed Cancel in the Finder dialog. */
  canceled?: boolean
  error?: string
}

// AppleScript: open the folder chooser, then return its POSIX path.
const SCRIPT = 'set f to choose folder with prompt "Elige la carpeta del proyecto"\nreturn POSIX path of f'

export function pickFolder(): Promise<PickFolderResult> {
  if (process.platform !== 'darwin') {
    return Promise.resolve({
      ok: false,
      error: 'El selector de carpeta solo está disponible en macOS. Escribe la ruta manualmente.',
    })
  }
  return new Promise((resolve) => {
    execFile('osascript', ['-e', SCRIPT], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${stderr || err.message || ''}`.toLowerCase()
        // User pressed Cancel → not an error.
        if (msg.includes('user canceled') || msg.includes('-128')) {
          return resolve({ ok: true, canceled: true })
        }
        return resolve({ ok: false, error: 'No se pudo abrir el selector de carpeta.' })
      }
      const path = stdout.trim()
      if (!path) return resolve({ ok: true, canceled: true })
      resolve({ ok: true, path })
    })
  })
}
