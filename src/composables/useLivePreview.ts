// Editor-tab side of the "Vista en vivo" tab→tab handoff.
//
// Two halves, both keyed PER PROJECT (type+slug) so two projects open in two
// windows never cross-feed:
//
//   • openLivePreview() — stash a snapshot of the CURRENT (possibly dirty)
//     working doc into localStorage, then window.open the SAME-ORIGIN editor
//     route '/live?type=…&slug=…' in a new tab. The snapshot guarantees the
//     fresh tab paints immediately (and survives a manual reload) without
//     waiting for a channel message.
//
//   • useLiveBroadcast() — a mounted composable that watches state.site /
//     deviceMode and posts the current doc on the per-project BroadcastChannel
//     so any open live tab re-renders WITHIN ~1 frame on every unsaved edit.
//     It also keeps the localStorage snapshot fresh (so a live tab opened or
//     reloaded LATER still gets the latest in-memory doc). NO save/commit is
//     involved anywhere — this is pure in-memory, same-origin.
//
// The payload carries the RAW canonical state.site (+ device); the live tab
// runs the SHARED buildPreviewSite() itself (asset-prefix + active-view, NO
// artboard vh-remap). state.site is never mutated here.

import { watch, onBeforeUnmount } from 'vue'
import { state } from '../stores/editor'
import { liveChannelName, liveStorageKey } from './usePreviewSite'

interface LivePayload {
  site: unknown
  deviceMode: 'desktop' | 'mobile'
  projectType: string
  slug: string
  ts: number
}

function snapshotPayload(): LivePayload | null {
  if (!state.projectType || !state.slug || !state.site) return null
  return {
    // Deep clone so a later store mutation can't retroactively change a
    // snapshot already serialized, and so reactivity proxies don't leak.
    site: JSON.parse(JSON.stringify(state.site)),
    deviceMode: state.deviceMode,
    projectType: state.projectType,
    slug: state.slug,
    ts: Date.now(),
  }
}

/**
 * Stash the current working doc and open the live tab (same-origin editor
 * route). Returns the opened URL (for tests / callers) or null if no project
 * is open. Does NOT save or touch the content repos.
 */
export function openLivePreview(): string | null {
  const payload = snapshotPayload()
  if (!payload) return null
  const key = liveStorageKey(payload.projectType, payload.slug)
  try {
    localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    /* private mode / quota — the channel still feeds the tab live */
  }
  const url = `/live?type=${encodeURIComponent(
    payload.projectType,
  )}&slug=${encodeURIComponent(payload.slug)}`
  window.open(url, '_blank', 'noopener')
  return url
}

/**
 * Mount in the editor view: continuously mirror the current (unsaved) doc to
 * any open live tab. Watches the canonical doc + selected device deeply and,
 * debounced to one animation frame, both posts on the per-project
 * BroadcastChannel and refreshes the localStorage snapshot.
 */
export function useLiveBroadcast() {
  let channel: BroadcastChannel | null = null
  let currentKey: string | null = null
  let raf = 0

  function ensureChannel() {
    if (!state.projectType || !state.slug) return
    const name = liveChannelName(state.projectType, state.slug)
    if (channel && currentKey === name) return
    // Project switched (or first use) → re-target the channel.
    if (channel) {
      channel.close()
      channel = null
    }
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(name)
      } catch {
        channel = null
      }
    }
    currentKey = name
  }

  function push() {
    raf = 0
    const payload = snapshotPayload()
    if (!payload) return
    ensureChannel()
    const json = JSON.stringify(payload)
    try {
      localStorage.setItem(
        liveStorageKey(payload.projectType, payload.slug),
        json,
      )
    } catch {
      /* ignore quota/private-mode */
    }
    if (channel) {
      try {
        channel.postMessage(payload)
      } catch {
        /* a structured-clone failure shouldn't break editing */
      }
    }
  }

  function schedule() {
    if (raf) return
    raf = requestAnimationFrame(push)
  }

  const stop = watch(
    () => [state.site, state.deviceMode, state.projectType, state.slug],
    schedule,
    { deep: true },
  )

  onBeforeUnmount(() => {
    stop()
    if (raf) cancelAnimationFrame(raf)
    if (channel) {
      channel.close()
      channel = null
    }
  })
}
