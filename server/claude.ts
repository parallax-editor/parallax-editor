import { spawn } from 'child_process'

export function runClaude(prompt: string, cwd: string): Promise<{ output: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', prompt], {
      cwd,
      shell: true,
      timeout: 60000,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ output: stdout })
      } else {
        resolve({ output: stdout, error: stderr || `Exit code ${code}` })
      }
    })

    proc.on('error', (err) => {
      resolve({ output: '', error: err.message })
    })
  })
}
