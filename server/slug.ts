// ── Canonical slug transform (TASK 2) ───────────────────────────────────────
// SINGLE source of truth for turning a free-form, human-typed name into the
// workspace slug convention (kebab-case, no accents/diacritics, lowercase,
// safe chars). Used by BOTH:
//   - server/projects.ts  -> the folder/route actually created on disk
//   - ProjectSelector.vue  -> the LIVE read-only preview the human sees
// so the previewed slug === the created folder, exactly. Pure (no Node/DOM
// deps) so it bundles cleanly into the browser via Vite and runs in Node.
//
// Mirrors the accent-strip/kebab logic that already lived in
// sanitizeAssetFilename / sanitizeSlug in server/projects.ts - now both call
// this so there is exactly ONE definition to keep in sync with the convention.

/**
 * Free-form name -> canonical slug.
 *   "Sofia & Juan - 15 de marzo" -> "sofia-juan-15-de-marzo"
 * Empty / all-stripped input -> "" (the caller decides the fallback, e.g.
 * GAP10 auto-naming / collision logic).
 */
export function slugify(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (combining diacriticals)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alnum -> single hyphen
    .replace(/-{2,}/g, '-') // collapse repeats
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
}
