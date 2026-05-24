// ─── Catálogo del workspace: manifest.json ──────────────────────────────────────
//
// El manifest del catálogo (`<contentRoot>/manifest.json`) es la lista META-ONLY
// de los proyectos de un workspace, para que un catálogo público pueda
// enumerarlos en RUNTIME (sin rebuild). Antes solo se subía a S3 al publicar; a
// partir de ahora es un ARTEFACTO ESTÁNDAR del editor: además de subirlo a S3
// (server/s3.ts → publishCatalogManifest), el editor MANTIENE el mismo manifest
// como ARCHIVO REAL versionado en disco (`<repoPath>/<contentRoot>/manifest.json`).
//
// Este módulo es el ÚNICO builder del manifest (single source of truth):
//   - buildCatalogItems(ws)  → arma los items escaneando los slugs hermanos.
//   - serializeCatalog(items) → el JSON exacto que escribimos/subimos.
//   - writeCatalogManifestFile(ws) → escribe el archivo en disco (markSelfWrite).
// Tanto el archivo local como el objeto S3 comparten buildCatalogItems, así nunca
// divergen. Gated SIEMPRE por ws.s3?.publishManifest en los llamadores — NUNCA
// corre para eventos (slugs privados/por-URL que no deben enumerarse).

import { readdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { Workspace } from './workspaces'
import { markSelfWrite } from './selfWrites'

export interface CatalogItem {
  slug: string
  title: string
  description?: string
  ogImage?: string
}

/**
 * Construye la lista del catálogo escaneando TODOS los slugs hermanos con
 * site.json bajo `<repoPath>/<contentRoot>`. Solo `meta` de cada site.json
 * (slug/title/description/ogImage) — nunca el árbol del mundo. El prefijo de
 * ogImage (`/<contentRoot>/<slug>/<og>`) coincide con el baseline que hornea el
 * build del sitio (nuxt.config getWorldsManifest). Ordenado por title.
 * Un site.json inválido se omite (no rompe el catálogo).
 */
export function buildCatalogItems(ws: Workspace): CatalogItem[] {
  const root = resolve(ws.repoPath, ws.contentRoot)
  if (!existsSync(root)) return []
  let slugs: string[]
  try {
    slugs = readdirSync(root, { withFileTypes: true })
      // 'home' es el sitio del index (`/`), no un mundo del catálogo → se excluye
      // del manifest, igual que en el sitio (nuxt.config getWorldDirs).
      .filter(
        (d) => d.isDirectory() && d.name !== 'home' && existsSync(resolve(root, d.name, 'site.json')),
      )
      .map((d) => d.name)
  } catch {
    return []
  }
  const items: CatalogItem[] = []
  for (const slug of slugs) {
    try {
      const raw = JSON.parse(readFileSync(resolve(root, slug, 'site.json'), 'utf-8'))
      const meta = raw?.meta ?? {}
      const og: string | undefined = meta.ogImage
      items.push({
        slug,
        title: meta.title || slug,
        description: meta.description,
        ogImage:
          og && !og.startsWith('http') && !og.startsWith('/')
            ? `/${ws.contentRoot}/${slug}/${og}`
            : og,
      })
    } catch {
      // site.json inválido → se omite del catálogo.
    }
  }
  items.sort((a, b) => a.title.localeCompare(b.title))
  return items
}

/** El cuerpo JSON exacto del manifest (mismo string para disco y para S3). */
export function serializeCatalog(items: CatalogItem[]): string {
  return JSON.stringify(items)
}

export interface ManifestFileResult {
  ok: boolean
  /** Nº de proyectos en el manifest. */
  count?: number
  /** Path ABSOLUTO del archivo escrito. */
  file?: string
  /** Path RELATIVO al repo (`<contentRoot>/manifest.json`) — para el commit acotado. */
  relPath?: string
  /** true si el contenido cambió respecto a lo que había en disco. */
  changed?: boolean
  error?: string
}

/** Ruta RELATIVA al repo del manifest del workspace (`<contentRoot>/manifest.json`). */
export function catalogManifestRelPath(ws: Workspace): string {
  return `${ws.contentRoot}/manifest.json`.replace(/\/+/g, '/').replace(/^\/+/, '')
}

/**
 * Escribe/actualiza `<repoPath>/<contentRoot>/manifest.json` en disco como
 * archivo versionado. Marca el path como self-write para que el watcher del
 * editor NO rebote por nuestro propio cambio. Idempotente: si el contenido es
 * idéntico al de disco no reescribe (changed:false) — así el commit acotado solo
 * incluye el manifest cuando de verdad cambió.
 */
export function writeCatalogManifestFile(ws: Workspace): ManifestFileResult {
  const root = resolve(ws.repoPath, ws.contentRoot)
  if (!existsSync(root)) {
    return { ok: false, error: `No existe el contentRoot: ${ws.contentRoot}` }
  }
  const items = buildCatalogItems(ws)
  const body = serializeCatalog(items)
  const file = resolve(root, 'manifest.json')
  let changed = true
  try {
    if (existsSync(file) && readFileSync(file, 'utf-8') === body) changed = false
  } catch {
    /* lectura falló → tratamos como cambiado y reescribimos */
  }
  if (changed) {
    try {
      writeFileSync(file, body, 'utf-8')
      markSelfWrite(file, Buffer.byteLength(body, 'utf-8'))
    } catch (e: any) {
      return { ok: false, error: e?.message || 'No se pudo escribir el manifest.' }
    }
  }
  return { ok: true, count: items.length, file, relPath: catalogManifestRelPath(ws), changed }
}
