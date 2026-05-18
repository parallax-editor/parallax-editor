import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, cpSync, rmSync } from 'fs'
import { resolve } from 'path'

const BASE = process.cwd()

const REPO_MAP: Record<string, string> = {
  eventos: resolve(BASE, '..', 'daniela-reyes-eventos'),
  site: resolve(BASE, '..', 'daniela-reyes-site'),
}

function contentDir(type: string): string {
  const repo = REPO_MAP[type]
  if (!repo) throw new Error(`Unknown project type: ${type}`)
  const dir = type === 'site'
    ? resolve(repo, 'content', 'portafolio')
    : resolve(repo, 'content')
  return dir
}

export function listProjects(type: string): { slug: string; title: string }[] {
  const dir = contentDir(type)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(dir, d.name, 'site.json')))
    .map((d) => {
      try {
        const json = JSON.parse(readFileSync(resolve(dir, d.name, 'site.json'), 'utf-8'))
        return { slug: d.name, title: json.meta?.title || d.name }
      } catch {
        return { slug: d.name, title: d.name }
      }
    })
}

export function readProject(type: string, slug: string): object | null {
  const file = resolve(contentDir(type), slug, 'site.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf-8'))
}

export function writeProject(type: string, slug: string, data: object): void {
  const dir = resolve(contentDir(type), slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'site.json'), JSON.stringify(data, null, 2), 'utf-8')
}

export function createProject(type: string, slug: string): void {
  const dir = resolve(contentDir(type), slug)
  mkdirSync(resolve(dir, 'images'), { recursive: true })
  const template = {
    schemaVersion: '1.0',
    meta: { title: slug.replace(/-/g, ' '), lang: 'es' },
    sections: [],
  }
  writeFileSync(resolve(dir, 'site.json'), JSON.stringify(template, null, 2), 'utf-8')
}

export function duplicateProject(type: string, slug: string): string {
  const src = resolve(contentDir(type), slug)
  const newSlug = `${slug}-copia`
  const dest = resolve(contentDir(type), newSlug)
  cpSync(src, dest, { recursive: true })
  return newSlug
}

export function deleteProject(type: string, slug: string): void {
  const dir = resolve(contentDir(type), slug)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
}

export function getRepoPath(type: string): string {
  return REPO_MAP[type] || ''
}

export function getAssetPath(type: string, slug: string, assetPath: string): string {
  return resolve(contentDir(type), slug, assetPath)
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv'])
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.flac'])

// Asset "kind" → content subdir + the relative src prefix stored in site.json.
// Layout (confirmed via workspace CLAUDE.md + neighbor repos):
//   eventos: content/<slug>/{images,audio,video}
//   site:    content/portafolio/<slug>/{images,audio,video}
// Consumers resolve a relative src by prefixing /content/<slug>/ (and the
// editor preview serves /content/(eventos|site)/<slug>/<src>) — so the src
// is simply "<subdir>/<file>".
export type AssetKind = 'image' | 'video' | 'audio'

const KIND_DIR: Record<AssetKind, string> = {
  image: 'images',
  video: 'video',
  audio: 'audio',
}

const KIND_EXTS: Record<AssetKind, Set<string>> = {
  image: IMAGE_EXTS,
  video: VIDEO_EXTS,
  audio: AUDIO_EXTS,
}

const KIND_FALLBACK_EXT: Record<AssetKind, string> = {
  image: '.png',
  video: '.mp4',
  audio: '.mp3',
}

const KIND_LABEL: Record<AssetKind, string> = {
  image: 'imágenes',
  video: 'video',
  audio: 'audio',
}

/** Classify a mime string into an asset kind, or null if unsupported. */
export function assetKindFromMime(mime: string): AssetKind | null {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return null
}

/**
 * Sanitize an uploaded filename → kebab-case, no accents, lowercased, keep
 * extension. Mirrors the slug convention used across the workspace
 * (kebab-case, no accents). Falls back to "archivo" if the base becomes empty.
 * `kind` decides which extensions are valid and the fallback extension.
 */
export function sanitizeAssetFilename(original: string, kind: AssetKind = 'image'): string {
  const dot = original.lastIndexOf('.')
  const rawExt = dot > 0 ? original.slice(dot).toLowerCase() : ''
  const rawBase = dot > 0 ? original.slice(0, dot) : original
  const base = rawBase
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents (combining diacriticals)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alnum → hyphen
    .replace(/^-+|-+$/g, '') // trim hyphens
    .replace(/-{2,}/g, '-') || 'archivo'
  const ext = KIND_EXTS[kind].has(rawExt) ? rawExt : KIND_FALLBACK_EXT[kind]
  return `${base}${ext}`
}

export interface SaveAssetResult {
  /** Relative src to store in site.json — `<subdir>/<file>` (images/, video/, audio/). */
  src: string
  filename: string
  bytes: number
  kind: AssetKind
}

/**
 * Write an asset buffer into the project's content dir, routed by `kind`:
 *   image → images/   video → video/   audio → audio/
 * Returns the relative `src` (`<subdir>/<file>`) that the engine/consumers
 * expect (consumers prefix it with `/content/<slug>/`, and the editor
 * preview serves it at /content/(eventos|site)/<slug>/<src>). Dedupes by
 * appending `-1`, `-2`, … if a file with the sanitized name already exists.
 * `kind` defaults to 'image' for backwards compatibility.
 */
export function saveProjectAsset(
  type: string,
  slug: string,
  originalName: string,
  buffer: Buffer,
  kind: AssetKind = 'image',
): SaveAssetResult {
  const dot = originalName.lastIndexOf('.')
  const ext = dot > 0 ? originalName.slice(dot).toLowerCase() : KIND_FALLBACK_EXT[kind]
  if (!KIND_EXTS[kind].has(ext)) {
    throw new Error(
      `Tipo de archivo no soportado para ${KIND_LABEL[kind]}: ${ext || '(sin extension)'}`,
    )
  }
  const subdir = KIND_DIR[kind]
  const destDir = resolve(contentDir(type), slug, subdir)
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  const sanitized = sanitizeAssetFilename(originalName, kind)
  const sdot = sanitized.lastIndexOf('.')
  const sBase = sanitized.slice(0, sdot)
  const sExt = sanitized.slice(sdot)

  let filename = sanitized
  let n = 1
  while (existsSync(resolve(destDir, filename))) {
    filename = `${sBase}-${n}${sExt}`
    n++
  }

  writeFileSync(resolve(destDir, filename), buffer)
  return { src: `${subdir}/${filename}`, filename, bytes: buffer.length, kind }
}
