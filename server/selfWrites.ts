// Self-write suppression for the chokidar file-watcher.
//
// Problem (PLAN §16): the editor's own writes to site.json (manual Guardar and
// the ~1.5s Autosave) land on the same file the chokidar watcher observes, so
// the watcher broadcasts `file-changed`, the client reloads the project, and
// the user's selection / in-progress edit is wiped. With Autosave this fires
// every couple of seconds → very disruptive.
//
// Fix: whenever the editor writes site.json through its API (writeProject),
// register that absolute path here with a short-lived ignore window. The
// watcher consults `shouldIgnoreSelfWrite(path)` on each change event and skips
// the WS broadcast when the change is attributable to our own write — but
// EXTERNAL changes (claude -p, hand edits) still broadcast and reload, because
// no marker was registered for them.
//
// Robustness:
//  - Coalesces rapid Autosaves: each write refreshes the window (the marker is
//    re-armed on every writeProject call).
//  - Survives the awaitWriteFinish stabilityThreshold (500ms) plus filesystem
//    latency by using a generous window (2000ms) measured from the LAST write.
//  - Matches by absolute path + post-write size: a self-write marker only
//    suppresses a change whose on-disk size equals what we just wrote, so an
//    external edit that races within the window (different content/size) is
//    NOT suppressed.
//  - Bounded memory: only one marker per path; cleared after it fires or after
//    the window elapses (a self-arming timer).

import { resolve } from 'path'

interface SelfWriteMarker {
  /** Byte length of the content we wrote (post-write file size). */
  size: number
  /** Timestamp (ms) of the most recent self-write to this path. */
  ts: number
  /** Pending expiry timer so a never-observed write still gets cleaned up. */
  timer: NodeJS.Timeout
}

// How long after a self-write a matching change event is still attributed to
// us. Must comfortably exceed the watcher's awaitWriteFinish stabilityThreshold
// (500ms) + FS event latency, while staying short enough that a genuinely
// external edit arriving later is NOT swallowed.
const SELF_WRITE_WINDOW_MS = 2000

const markers = new Map<string, SelfWriteMarker>()

function key(path: string): string {
  return resolve(path)
}

/**
 * Record that the editor itself just wrote `path` with `size` bytes. Called by
 * writeProject after the writeFileSync. Re-arming on every call coalesces a
 * burst of autosaves into one rolling ignore window.
 */
export function markSelfWrite(path: string, size: number): void {
  const k = key(path)
  const existing = markers.get(k)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    const m = markers.get(k)
    // Only delete if this is still the same (un-refreshed) marker.
    if (m && m.timer === timer) markers.delete(k)
  }, SELF_WRITE_WINDOW_MS)
  // Don't keep the process alive just for cleanup.
  if (typeof timer.unref === 'function') timer.unref()
  markers.set(k, { size, ts: Date.now(), timer })
}

/**
 * Returns true if a change event for `path` (with the given current on-disk
 * `size`) should be treated as the editor's own write and therefore NOT
 * broadcast. Consuming the marker (deleting it) so the NEXT change — e.g. a
 * later external edit — is not suppressed unless a fresh self-write re-armed
 * it. If size doesn't match what we wrote, treat as external (don't suppress).
 */
export function shouldIgnoreSelfWrite(path: string, size: number): boolean {
  const k = key(path)
  const m = markers.get(k)
  if (!m) return false
  const withinWindow = Date.now() - m.ts <= SELF_WRITE_WINDOW_MS
  const sizeMatches = m.size === size
  if (withinWindow && sizeMatches) {
    clearTimeout(m.timer)
    markers.delete(k)
    return true
  }
  // Stale or content differs → an external change. Drop the (now irrelevant)
  // marker and let it broadcast.
  clearTimeout(m.timer)
  markers.delete(k)
  return false
}

// Exposed for tests / introspection.
export const __selfWriteWindowMs = SELF_WRITE_WINDOW_MS
