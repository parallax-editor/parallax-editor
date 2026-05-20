import { spawn, execSync, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'

// ── Is the `claude` CLI usable on this machine? ──────────────────────────────
// The toolbar's "Claude" button is only enabled when this returns true (a
// non-technical user on a machine WITHOUT claude installed should see it
// disabled with a clear Spanish tooltip, not get a cryptic spawn error).
// The check is CACHED at module level: `command -v claude` is shelled at most
// ONCE per server process (not on every /api/claude/status request), since the
// CLI's presence on PATH does not change while the server is running.
let claudeAvailableCache: boolean | null = null

export function isClaudeAvailable(): boolean {
  if (claudeAvailableCache !== null) return claudeAvailableCache
  try {
    // `command -v claude` exits 0 and prints the path when claude is on PATH,
    // exits non-zero (throws here) otherwise. Short timeout so a weird PATH
    // can't hang the first status request. stdio piped so nothing leaks to the
    // server console.
    execSync('command -v claude', { timeout: 3000, stdio: 'pipe' })
    claudeAvailableCache = true
  } catch {
    claudeAvailableCache = false
  }
  return claudeAvailableCache
}

// ── Continuous Claude session per site slug (TASK 1) ────────────────────────
// Every "Hablar con Claude" / "Analizar con Claude" call used to spawn a
// STATELESS `claude -p <prompt>` — no memory of prior turns for that site.
// Now each site gets a CONTINUOUS Claude session keyed by its slug so
// iterative prompts on the SAME site build on prior context.
//
// Strategy (empirically verified against the real CLI):
//   `claude -p --session-id <uuid> "<p>"`  → creates a new session for <uuid>
//       (exit 0). Reusing --session-id on an EXISTING session fails:
//       "Error: Session ID <uuid> is already in use." (exit 1).
//   `claude -p --resume <uuid> "<p>"`      → resumes, with FULL memory of the
//       earlier turns (exit 0). Resuming a session that does not exist fails:
//       "No conversation found with session ID: <uuid>" (exit 1).
// So per slug: prefer --resume (covers the iterative case AND survives a
// server restart since sessions persist on disk); if resume fails because the
// session does not exist yet, transparently fall back to --session-id to
// create it, then that uuid is reusable via --resume forever after.
//
// The uuid is DERIVED deterministically from the slug (UUIDv5, SHA-1 over a
// fixed namespace) so the same slug ⇒ the same uuid with NO persistence, and
// different slugs ⇒ different uuids. An in-memory Set of slugs we've already
// created this process is just an optimisation to skip the doomed first
// --resume on a known-fresh slug; the auto-fallback makes the whole thing
// resilient even without it (server restart / externally-cleared sessions).

// Fixed namespace UUID for this editor's Claude sessions (random, constant).
const SESSION_NS = '6f1c2a7e-8b3d-4e9f-a1c2-d3e4f5a6b7c8'

// ── Guardrail del prompt base (#98) ──────────────────────────────────────────
// Cada `claude -p` que dispara este editor se ejecuta con `cwd` en el repo
// vecino de contenido (`daniela-reyes-eventos` / `daniela-reyes-site`). Esos
// repos contienen TODA la fuente del sitio (Nuxt config, server/, pages/,
// components/, parallax.config.ts, package.json…) además de `content/`. Sin
// guardrail Claude puede tocar cualquier archivo y romper el sitio. Esto pasa
// a TODA invocación (texto y stream-json/imágenes) vía
// `--append-system-prompt`, conservando session/cancel/timeout/contexto.
// Lo dejamos exportado para que la suite e2e/tests puedan asegurarse de que
// el guardrail SIEMPRE viaja en el argv.
export const CLAUDE_GUARDRAIL_SYSTEM_PROMPT = [
  'Eres asistente de edición del sistema parallax de Daniela Reyes desde un',
  'editor visual no técnico. SOLO puedes leer/modificar archivos DENTRO de',
  '`content/<slug>/` (el `site.json` del proyecto y sus assets en',
  '`content/<slug>/{images,fonts,audio,video}`). PROHIBIDO crear/modificar/',
  'eliminar archivos fuera de `content/`: nada de `parallax-engine`, del',
  'editor (`parallax-editor`), del sitio (`daniela-reyes-site`) ni de eventos',
  '(`daniela-reyes-eventos`) — ni `pages/`, `nuxt.config*`, `parallax.config*`,',
  '`package.json`, `server/`, `src/`, `components/`, `composables/`, ni',
  'cualquier código fuente/config/build. PROHIBIDO ejecutar git,',
  'instalaciones, procesos o cambios de sistema. Si el usuario pide algo fuera',
  'de este alcance, rehúsa amablemente en español y explica que desde aquí',
  'solo puedes ajustar el contenido del sitio actual.',
].join(' ')

// Bandera con la que viaja el guardrail en cada argv (texto y stream-json).
const GUARDRAIL_ARGS = ['--append-system-prompt', CLAUDE_GUARDRAIL_SYSTEM_PROMPT]

/**
 * Deterministic RFC-4122 UUIDv5 (name-based, SHA-1) from `name` within
 * `namespace`. Same input ⇒ same output, no state. Output is a syntactically
 * valid UUID (required by `claude --session-id`).
 */
function uuidv5(name: string, namespace: string): string {
  const nsHex = namespace.replace(/-/g, '')
  const nsBytes = Buffer.from(nsHex, 'hex') // 16 bytes
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(name, 'utf-8'))
    .digest() // 20 bytes
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC variant
  const h = b.toString('hex')
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-` +
    `${h.slice(16, 20)}-${h.slice(20, 32)}`
  )
}

/** Stable session UUID for a site slug. Exported for tests/verification. */
export function sessionIdForSlug(slug: string): string {
  return uuidv5(`site:${slug || '_'}`, SESSION_NS)
}

// Slugs whose session we've already created in THIS server process. Lets the
// first call go straight to --session-id (skip a guaranteed-to-fail --resume).
// Not relied upon for correctness — the resume→session-id fallback covers a
// cold process / externally-cleared session too.
const startedSlugs = new Set<string>()

// "Session does not exist yet" signature from `claude --resume`. When --resume
// fails with this we create the session with --session-id instead.
function isNoSuchSession(stderr: string, stdout: string): boolean {
  const s = `${stderr}\n${stdout}`.toLowerCase()
  return (
    s.includes('no conversation found') ||
    s.includes('no such session') ||
    (s.includes('session') && s.includes('not found'))
  )
}

// PLAN §16: a long Claude run must be cancelable. The child is spawned with a
// 60s safety timeout (unchanged) AND tracked by a caller-supplied `runId` so
// POST /api/claude/cancel can kill it. Killing resolves the original promise
// cleanly with a Spanish "cancelado" message (no hang, no 500).
const running = new Map<string, ChildProcess>()

export function cancelClaude(runId: string): boolean {
  const proc = running.get(runId)
  if (!proc) return false
  // SIGTERM first; the child's own `on('close')` handler resolves the promise.
  // Force-kill a moment later in case `claude` ignores SIGTERM.
  try { proc.kill('SIGTERM') } catch { /* already gone */ }
  setTimeout(() => {
    if (running.has(runId)) {
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
    }
  }, 2000)
  return true
}

interface RunResult { output: string; error?: string; canceled?: boolean }

// An attached image as delivered by the client (data URL → decoded here).
export interface ClaudeImage { mediaType: string; dataBase64: string }

// Build the argv for a single `claude -p` invocation. `mode`:
//   'resume'  → -p --resume <uuid> <prompt>   (continue the slug's session)
//   'create'  → -p --session-id <uuid> <prompt> (start the slug's session)
//   'plain'   → -p <prompt>                   (no slug → legacy stateless)
// Exported for unit-style verification of the exact flags/uuid.
//
// `streamJson` (TASK 3 / #67): when true the prompt is NOT an argv element —
// it is delivered (with the base64 image blocks) via stdin as a stream-json
// user message. The argv then carries `--input-format stream-json
// --output-format json` plus, crucially, the SAME session flags
// (`--resume`/`--session-id <uuid>`) so the per-slug continuity holds for
// image messages too. Verified empirically: session flags are independent of
// `--input-format` and compose correctly with stream-json.
export function buildClaudeArgs(
  prompt: string,
  mode: 'resume' | 'create' | 'plain',
  sessionId?: string,
  streamJson = false,
): string[] {
  // #98: el guardrail viaja en CADA invocación (texto y stream-json) vía
  // `--append-system-prompt`. Va al inicio del argv (después del -p) para
  // dejar la cola estable (prompt argv / session flags en su posición
  // habitual) y para que los tests puedan verificar fácilmente su presencia.
  if (streamJson) {
    // Prompt goes via stdin (JSON user message). Keep the session flags so
    // image messages still build on / start the per-slug session.
    // NOTE (empirically verified, claude 2.1.143): `--input-format
    // stream-json` REQUIRES `--output-format stream-json` (using `json`
    // errors "requires output-format=stream-json"). The result text is then
    // the `{"type":"result",...,"result":"…"}` line — parseStreamJsonOutput
    // extracts it. `--verbose` is required for stream-json output.
    const io = ['-p', ...GUARDRAIL_ARGS, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    if (mode === 'resume' && sessionId) return [...io, '--resume', sessionId]
    if (mode === 'create' && sessionId) return [...io, '--session-id', sessionId]
    return io
  }
  if (mode === 'resume' && sessionId) return ['-p', ...GUARDRAIL_ARGS, '--resume', sessionId, prompt]
  if (mode === 'create' && sessionId) return ['-p', ...GUARDRAIL_ARGS, '--session-id', sessionId, prompt]
  return ['-p', ...GUARDRAIL_ARGS, prompt]
}

// Serialize ONE stream-json user message (text + base64 image blocks) for the
// child's stdin. Shape required by `claude --input-format stream-json`:
//   {"type":"user","message":{"role":"user","content":[ {type:"text",…},
//      {type:"image",source:{type:"base64",media_type,data}} … ]}}
// One line, newline-terminated. base64 must contain NO newlines.
export function buildStreamJsonMessage(prompt: string, images: ClaudeImage[]): string {
  const content: any[] = [{ type: 'text', text: prompt }]
  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.dataBase64.replace(/\s+/g, ''),
      },
    })
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

// `claude --output-format json` returns ONE JSON object (its `result` field is
// the assistant's text). Extract that; on any parse miss fall back to raw.
function parseStreamJsonOutput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // Try whole-string JSON first (output-format json = single object).
  try {
    const obj = JSON.parse(trimmed)
    if (obj && typeof obj.result === 'string') return obj.result
    if (obj && typeof obj.text === 'string') return obj.text
  } catch { /* fall through to line scan */ }
  // stream-json fallback: scan lines for the final result / assistant text.
  let result = ''
  for (const line of trimmed.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o?.type === 'result' && typeof o.result === 'string') result = o.result
      else if (o?.type === 'assistant' && o?.message?.content) {
        const txt = (o.message.content as any[])
          .filter((c) => c?.type === 'text')
          .map((c) => c.text)
          .join('')
        if (txt) result = txt
      } else if (typeof o?.result === 'string') result = o.result
    } catch { /* not JSON — ignore */ }
  }
  return result || raw
}

// Spawn one `claude` invocation and resolve with its result. Cancelable via
// `runId` (tracked in `running`); a kill is reported as a clean cancel.
//
// TASK 1 (#65) ROOT-CAUSE FIX — CRITICAL:
//   This used to be `spawn('claude', args, { cwd, shell: true })`. With
//   `shell:true` AND an args array, Node does NOT quote/escape the args; it
//   joins them with spaces and runs them through `/bin/sh -c`. A multi-word
//   prompt like "Recuerda la palabra clave ZAPOTE-7" was therefore WORD-SPLIT
//   by the shell, so `claude` received `Recuerda` as the prompt and the rest
//   as stray (unparsed) tokens — the prompt was mangled end-to-end and the
//   per-slug `--session-id`/`--resume` continuity was effectively useless
//   (verified: a 2nd call could not recall a keyword from the 1st, and the
//   1st reply was garbled).
//   The clean fix is `shell:false` (Node's default) with the args array
//   passed verbatim: each element — including the whole multi-word prompt —
//   becomes ONE intact argv entry, no shell, no quoting needed. All session
//   flags (`--resume`/`--session-id <uuid>`), the runId cancelability and the
//   60s timeout are preserved unchanged.
//
// `stdin` (optional): when provided it is written to the child's stdin and
// then stdin is closed. Used by the stream-json image path (TASK 3 / #67):
// `claude -p --input-format stream-json` reads the user message (text + base64
// image blocks) from stdin. Text-only runs pass no stdin (unchanged path).
function spawnClaude(
  args: string[],
  cwd: string,
  runId?: string,
  stdin?: string,
): Promise<RunResult> {
  return new Promise((resolve) => {
    // shell:false (default) — args (incl. the intact multi-word prompt and the
    // session flags) are passed verbatim as separate argv entries. NO shell,
    // so NO word-splitting / quoting hazard. This is the #65 fix.
    //
    // TASK 3 (#82) — stdin handling:
    //   The text-only path passes the prompt as an argv element and sends
    //   NOTHING on stdin. With the default `stdio:['pipe','pipe','pipe']`
    //   `claude` does not see EOF on stdin and prints
    //     "Warning: no stdin data received in 3s, proceeding without it..."
    //   then stalls ~3s before continuing. Giving the child NO stdin
    //   (`'ignore'`) makes stdin an immediately-closed /dev/null so `claude`
    //   proceeds INSTANTLY (no warning, no 3s stall).
    //   The stream-json (image) path DOES feed a JSON user message to stdin,
    //   so there we keep a writable stdin pipe ('pipe') — its behaviour is
    //   unchanged (write + end below).
    const hasStdin = typeof stdin === 'string'
    const proc = spawn('claude', args, {
      cwd,
      timeout: 60000,
      stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let canceled = false

    if (typeof stdin === 'string') {
      // stream-json input path: deliver the JSON user message then EOF so
      // `claude --input-format stream-json` processes it and exits.
      proc.stdin?.on('error', () => { /* child gone before write — close handler reports it */ })
      proc.stdin?.write(stdin)
      proc.stdin?.end()
    }

    if (runId) running.set(runId, proc)

    const done = (result: RunResult) => {
      if (runId) running.delete(runId)
      resolve(result)
    }

    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code, signal) => {
      // A kill (cancel) arrives as a signal (SIGTERM/SIGKILL) or null exit
      // code → report a clean cancellation, not an error, so the UI doesn't
      // show a scary message.
      if (canceled || signal === 'SIGTERM' || signal === 'SIGKILL') {
        return done({ output: stdout, canceled: true })
      }
      // Some environments (notably when a shell wraps the child) deliver the
      // signal as a NUMERIC exit code instead of a `signal` arg: 143 = 128 +
      // SIGTERM(15), 130 = 128 + SIGINT(2). Both mean "the run was
      // terminated/canceled", NOT a genuine failure. Treat them as a clean
      // cancel/finish so no spurious "Exit code 143" error surfaces in the
      // chat. Any OTHER non-zero code is still a real error.
      if (code === 143 || code === 130) {
        return done({ output: stdout, canceled: true })
      }
      if (code === 0) {
        done({ output: stdout })
      } else {
        done({ output: stdout, error: stderr || `Exit code ${code}` })
      }
    })

    proc.on('error', (err) => {
      done({ output: '', error: err.message })
    })

    // Mark canceled when the process is explicitly killed via cancelClaude so
    // the close handler can classify it even if no signal is reported.
    proc.once('exit', (_code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') canceled = true
    })
  })
}

// Run ONE invocation in a given session mode. Text-only → the (now non-shell,
// #65-fixed) `-p <prompt>` argv path. With images → the stream-json path:
// argv carries `--input-format stream-json` + the SAME session flags, and the
// JSON user message (text + base64 image blocks) is written to stdin. Output
// is parsed from the JSON envelope. Cancelable via runId in both paths.
function runOnce(
  prompt: string,
  cwd: string,
  mode: 'resume' | 'create' | 'plain',
  sessionId: string | undefined,
  runId: string | undefined,
  images: ClaudeImage[],
): Promise<RunResult> {
  if (images.length > 0) {
    const args = buildClaudeArgs(prompt, mode, sessionId, true)
    const stdin = buildStreamJsonMessage(prompt, images)
    return spawnClaude(args, cwd, runId, stdin).then((r) => {
      // The JSON envelope wraps the assistant text; surface just the text so
      // the chat UI shows a clean reply (errors are passed through as-is).
      if (!r.error && !r.canceled) return { ...r, output: parseStreamJsonOutput(r.output) }
      return r
    })
  }
  return spawnClaude(buildClaudeArgs(prompt, mode, sessionId), cwd, runId)
}

/**
 * Run `claude -p` for a project. When `slug` is given the run uses that
 * site's CONTINUOUS session (resume → on "no such session" fall back to
 * creating it). Without a slug it stays stateless (legacy behaviour, e.g.
 * for ad-hoc callers). Cancelable via `runId`; 60s timeout per invocation.
 *
 * `images` (TASK 3 / #67): when non-empty the message is delivered to claude
 * via the stream-json stdin mechanism (base64 blocks, no path references) and
 * STILL carries the per-slug session flags so image turns are part of the
 * same continuous conversation.
 */
export async function runClaude(
  prompt: string,
  cwd: string,
  runId?: string,
  slug?: string,
  images: ClaudeImage[] = [],
): Promise<RunResult> {
  // No slug → legacy stateless single run (unchanged behaviour; still gains
  // the stream-json image path when images are attached).
  if (!slug) {
    return runOnce(prompt, cwd, 'plain', undefined, runId, images)
  }

  const sessionId = sessionIdForSlug(slug)

  // Known-fresh this process → create directly (skip the doomed --resume).
  if (!startedSlugs.has(slug)) {
    const created = await runOnce(prompt, cwd, 'create', sessionId, runId, images)
    // "already in use" means the session actually exists (e.g. created by a
    // PRIOR server process / externally) — resume it instead so we keep
    // continuity rather than erroring.
    if (
      created.error &&
      !created.canceled &&
      /already in use/i.test(created.error)
    ) {
      startedSlugs.add(slug)
      return runOnce(prompt, cwd, 'resume', sessionId, runId, images)
    }
    if (!created.error && !created.canceled) startedSlugs.add(slug)
    return created
  }

  // Subsequent calls → resume the slug's session for continuity.
  const resumed = await runOnce(prompt, cwd, 'resume', sessionId, runId, images)
  // Resilience: session was cleared/lost (server restarted, disk pruned) →
  // recreate it transparently so the user never sees a raw CLI error.
  if (
    resumed.error &&
    !resumed.canceled &&
    isNoSuchSession(resumed.error, resumed.output)
  ) {
    const recreated = await runOnce(prompt, cwd, 'create', sessionId, runId, images)
    if (!recreated.error && !recreated.canceled) startedSlugs.add(slug)
    return recreated
  }
  return resumed
}
