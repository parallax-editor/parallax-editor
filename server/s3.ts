// ─── S3 publishing (Fase 3) ─────────────────────────────────────────────────────
//
// Publishing a site = git push (existing) + sync ONLY that slug's content dir
// to S3. Credentials come from the HOST's default AWS credential chain
// (~/.aws/credentials, env, SSO…) — the editor never handles secrets. Region
// defaults to us-east-1 (override per workspace).
//
// HARD SCOPE: syncSiteToS3 only ever touches keys under
//   s3://<bucket>/<prefix?>/<contentRoot>/<slug>/
// It uploads every file under <repoPath>/<contentRoot>/<slug>/** and DELETES
// orphaned objects under THAT slug prefix only (objects that no longer exist on
// disk). It never lists/deletes anything outside the slug prefix.

import { readdirSync, statSync, createReadStream, existsSync, readFileSync } from 'fs'
import { resolve, relative, extname, join } from 'path'
import {
  S3Client,
  ListBucketsCommand,
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import type { Workspace } from './workspaces'
import { buildCatalogItems, serializeCatalog } from './catalog'

// Content-type by extension (mirrors the editor's MIME table + a few extras).
const MIME: Record<string, string> = {
  '.json': 'application/json', '.html': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.txt': 'text/plain', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
}
function contentType(file: string): string {
  return MIME[extname(file).toLowerCase()] || 'application/octet-stream'
}

function client(region: string): S3Client {
  // Default credential chain (host ~/.aws / env / SSO). No secrets in the editor.
  return new S3Client({ region: region || 'us-east-1' })
}

export interface ListBucketsResult {
  ok: boolean
  buckets?: string[]
  error?: string
}

export async function listBuckets(region = 'us-east-1'): Promise<ListBucketsResult> {
  try {
    const out = await client(region).send(new ListBucketsCommand({}))
    return { ok: true, buckets: (out.Buckets || []).map((b) => b.Name || '').filter(Boolean) }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'No se pudieron listar los buckets de S3.' }
  }
}

export interface CreateBucketResult {
  ok: boolean
  bucket?: string
  error?: string
}

export async function createBucket(name: string, region = 'us-east-1'): Promise<CreateBucketResult> {
  const bucket = (name || '').trim()
  if (!bucket) return { ok: false, error: 'Falta el nombre del bucket.' }
  try {
    // us-east-1 must NOT pass a LocationConstraint (the API rejects it).
    const input: any = { Bucket: bucket }
    if (region && region !== 'us-east-1') {
      input.CreateBucketConfiguration = { LocationConstraint: region }
    }
    await client(region).send(new CreateBucketCommand(input))
    return { ok: true, bucket }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'No se pudo crear el bucket.' }
  }
}

// Recursively collect every file path under a dir (absolute paths). Skips
// dotfiles like .DS_Store but KEEPS the .deploy.json sidecar (a dotfile we want
// uploaded so the deploy state is visible on S3 too).
function walkFiles(dir: string): string[] {
  const out: string[] = []
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...walkFiles(full))
    } else if (e.isFile()) {
      if (e.name === '.DS_Store') continue
      out.push(full)
    }
  }
  return out
}

export interface SyncResult {
  ok: boolean
  uploaded?: number
  deleted?: number
  bucket?: string
  prefix?: string
  error?: string
}

/**
 * Sync ONLY the slug's content dir to S3. Key layout under the bucket:
 *   <prefix?>/<contentRoot>/<slug>/<relative file path>
 * (prefix omitted when empty). Uploads everything on disk, then deletes any
 * object under that slug prefix that no longer exists locally (orphan cleanup).
 * Acotado al slug — nunca toca nada fuera de ese prefijo.
 */
export async function syncSiteToS3(ws: Workspace, slug: string): Promise<SyncResult> {
  const s3cfg = ws.s3
  if (!s3cfg || !s3cfg.enabled || !s3cfg.bucket) {
    return { ok: false, error: 'El workspace no tiene S3 habilitado o falta el bucket.' }
  }
  const slugDir = resolve(ws.repoPath, ws.contentRoot, slug)
  if (!existsSync(slugDir)) {
    return { ok: false, error: `No existe la carpeta del sitio: ${ws.contentRoot}/${slug}` }
  }
  const region = s3cfg.region || 'us-east-1'
  const c = client(region)
  // Key prefix scoped to this slug. Always ends with a trailing slash so the
  // orphan-listing/delete can never match a sibling slug with a shared prefix.
  const parts = [s3cfg.prefix, ws.contentRoot, slug].filter(Boolean)
  const keyPrefix = parts.join('/').replace(/\/+/g, '/').replace(/^\/+/, '') + '/'

  try {
    // 1) Upload every file under the slug dir.
    const files = walkFiles(slugDir)
    const liveKeys = new Set<string>()
    let uploaded = 0
    for (const file of files) {
      const rel = relative(slugDir, file).split(/[\\/]/).join('/')
      const Key = keyPrefix + rel
      liveKeys.add(Key)
      await c.send(
        new PutObjectCommand({
          Bucket: s3cfg.bucket,
          Key,
          Body: createReadStream(file),
          ContentType: contentType(file),
          ContentLength: statSync(file).size,
        }),
      )
      uploaded++
    }

    // 2) Delete orphans: list everything under THIS slug prefix and remove
    //    objects that no longer exist on disk.
    let deleted = 0
    let ContinuationToken: string | undefined
    const toDelete: { Key: string }[] = []
    do {
      const listed = await c.send(
        new ListObjectsV2Command({
          Bucket: s3cfg.bucket,
          Prefix: keyPrefix,
          ContinuationToken,
        }),
      )
      for (const obj of listed.Contents || []) {
        if (obj.Key && !liveKeys.has(obj.Key)) toDelete.push({ Key: obj.Key })
      }
      ContinuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
    } while (ContinuationToken)

    // DeleteObjects caps at 1000 keys per call.
    for (let i = 0; i < toDelete.length; i += 1000) {
      const batch = toDelete.slice(i, i + 1000)
      await c.send(
        new DeleteObjectsCommand({
          Bucket: s3cfg.bucket,
          Delete: { Objects: batch, Quiet: true },
        }),
      )
      deleted += batch.length
    }

    return { ok: true, uploaded, deleted, bucket: s3cfg.bucket, prefix: keyPrefix }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Falló la sincronización con S3.' }
  }
}

// ── Deploy sidecar (.deploy.json) ─────────────────────────────────────────────
export interface DeploySidecar {
  deployed: boolean
  lastDeployedAt: string
  bucket: string
  prefix: string
  region: string
}

/** Read the slug's .deploy.json (deploy state), or null if absent/invalid. */
export function readDeploySidecar(ws: Workspace, slug: string): DeploySidecar | null {
  const file = resolve(ws.repoPath, ws.contentRoot, slug, '.deploy.json')
  if (!existsSync(file)) return null
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8'))
    if (j && typeof j === 'object' && j.deployed) return j as DeploySidecar
    return null
  } catch {
    return null
  }
}

// ── Catálogo: manifest.json ──────────────────────────────────────────────────
//
// Cuando el sitio consumidor lista sus mundos desde un `manifest.json` cargado
// en RUNTIME, al publicar un slug regeneramos ese manifest escaneando TODOS
// los slugs hermanos del contentRoot y lo subimos a S3 — así un mundo nuevo
// aparece en el catálogo SIN rebuild. Gated por `ws.s3.publishManifest`: solo
// se activa en workspaces cuyo catálogo es público (no en workspaces privados
// donde los slugs no deben enumerarse).
//
// El BUILDER del manifest vive en server/catalog.ts (single source of truth,
// compartido con el archivo local versionado). Aquí solo subimos a S3 el
// MISMO cuerpo que se escribe en disco.

export interface ManifestResult {
  ok: boolean
  count?: number
  error?: string
}

/**
 * Regenera <contentRoot>/manifest.json (lista del catálogo) desde el disco y lo
 * sube a s3://<bucket>/<prefix?>/<contentRoot>/manifest.json. Solo `meta` de
 * cada site.json (slug/title/description/ogImage) — nunca el árbol del mundo.
 * Usa el builder compartido (server/catalog.ts) para que el objeto S3 y el
 * archivo local NUNCA divergan.
 */
export async function publishCatalogManifest(ws: Workspace): Promise<ManifestResult> {
  const s3cfg = ws.s3
  if (!s3cfg || !s3cfg.enabled || !s3cfg.bucket) {
    return { ok: false, error: 'El workspace no tiene S3 habilitado o falta el bucket.' }
  }
  const root = resolve(ws.repoPath, ws.contentRoot)
  if (!existsSync(root)) return { ok: false, error: `No existe el contentRoot: ${ws.contentRoot}` }

  const items = buildCatalogItems(ws)

  const parts = [s3cfg.prefix, ws.contentRoot].filter(Boolean)
  const Key = parts.join('/').replace(/\/+/g, '/').replace(/^\/+/, '') + '/manifest.json'
  try {
    const body = serializeCatalog(items)
    await client(s3cfg.region || 'us-east-1').send(
      new PutObjectCommand({
        Bucket: s3cfg.bucket,
        Key,
        Body: body,
        ContentType: 'application/json',
        ContentLength: Buffer.byteLength(body, 'utf-8'),
      }),
    )
    return { ok: true, count: items.length }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'No se pudo subir el manifest del catálogo.' }
  }
}

export interface DeleteS3Result {
  ok: boolean
  deleted?: number
  error?: string
}

/**
 * Borra de S3 TODOS los objetos del slug bajo
 *   s3://<bucket>/<prefix?>/<contentRoot>/<slug>/
 * El prefijo SIEMPRE termina en `/`, así nunca toca un slug hermano con prefijo
 * compartido. Es la inversa de syncSiteToS3: se usa al ELIMINAR un proyecto para
 * que el sitio publicado deje de existir. Acotado al slug — nada más.
 */
export async function deleteSiteFromS3(ws: Workspace, slug: string): Promise<DeleteS3Result> {
  const s3cfg = ws.s3
  if (!s3cfg || !s3cfg.enabled || !s3cfg.bucket) {
    return { ok: false, error: 'El workspace no tiene S3 habilitado o falta el bucket.' }
  }
  const c = client(s3cfg.region || 'us-east-1')
  const parts = [s3cfg.prefix, ws.contentRoot, slug].filter(Boolean)
  const keyPrefix = parts.join('/').replace(/\/+/g, '/').replace(/^\/+/, '') + '/'
  try {
    let deleted = 0
    let ContinuationToken: string | undefined
    do {
      const listed = await c.send(
        new ListObjectsV2Command({ Bucket: s3cfg.bucket, Prefix: keyPrefix, ContinuationToken }),
      )
      const objs = (listed.Contents || [])
        .map((o) => ({ Key: o.Key as string }))
        .filter((o) => !!o.Key)
      for (let i = 0; i < objs.length; i += 1000) {
        const batch = objs.slice(i, i + 1000)
        if (batch.length) {
          await c.send(
            new DeleteObjectsCommand({ Bucket: s3cfg.bucket, Delete: { Objects: batch, Quiet: true } }),
          )
          deleted += batch.length
        }
      }
      ContinuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
    } while (ContinuationToken)
    return { ok: true, deleted }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'No se pudo borrar el sitio de S3.' }
  }
}
