// ─── Publicar (Fase 3): push + S3 sync + deploy sidecar ─────────────────────────
//
// "Publicar" used to be just `git push`. Now it is a full deploy:
//   1) push pending commits (so S3 reflects what's in git),
//   2) if the workspace has S3 enabled → sync ONLY this slug's content dir,
//   3) write a `.deploy.json` sidecar in the slug dir with the deploy metadata,
//   4) commit + push that sidecar (SCOPED: git add/commit --only -- <path>),
// GUARDAR stays a plain scoped commit (no S3) — this is the only place S3 runs.

import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { resolveWorkspace } from './workspaces'
import { gitPush, gitCommitPath } from './git'
import { getContentRelPath } from './projects'
import { syncSiteToS3, publishCatalogManifest, type SyncResult } from './s3'
import { writeCatalogManifestFile } from './catalog'
import { markSelfWrite } from './selfWrites'

export interface PublishResult {
  ok: boolean
  /** Steps run, for the UI progress/log. */
  pushed?: boolean
  s3?: SyncResult
  deployedAt?: string
  error?: string
  /** Non-fatal note (e.g. push had nothing / S3 disabled). */
  warning?: string
  /** Nº de mundos en el manifest del catálogo regenerado (si aplica). */
  manifest?: number
}

export async function publishWorkspaceSlug(wsId: string, slug: string): Promise<PublishResult> {
  const ws = resolveWorkspace(wsId)
  if (!ws) return { ok: false, error: 'Workspace desconocido.' }
  if (!slug) return { ok: false, error: 'Falta el sitio a publicar.' }

  // 1) Push pending commits first. push may legitimately error if there's no
  //    upstream / nothing to push — that's a warning, not a hard failure.
  let pushed = false
  let warning: string | undefined
  try {
    gitPush(ws.repoPath)
    pushed = true
  } catch (e: any) {
    warning = `No se pudo hacer push: ${e?.message || 'error de git'} (continuo con S3 si aplica).`
  }

  // 2) S3 sync (only if enabled).
  let s3: SyncResult | undefined
  let manifest: number | undefined
  if (ws.s3?.enabled) {
    s3 = await syncSiteToS3(ws, slug)
    if (!s3.ok) {
      return { ok: false, pushed, s3, error: s3.error || 'Falló la sincronización con S3.' }
    }
    // 2b) Catálogo: si el workspace lo pide (portafolio público, NO eventos),
    //     regeneramos+subimos <contentRoot>/manifest.json para que un mundo
    //     nuevo aparezca en el catálogo sin rebuild. Best-effort: el deploy del
    //     slug ya fue exitoso, así que un fallo aquí es solo un warning.
    if (ws.s3.publishManifest) {
      const m = await publishCatalogManifest(ws)
      if (m.ok) {
        manifest = m.count
      } else {
        warning = warning || `El sitio se publicó, pero no se pudo actualizar el catálogo: ${m.error || ''}`
      }
      // Arreglo 4: además del upload a S3, mantén el manifest como ARCHIVO REAL
      // versionado bajo content/. Si cambió, lo commiteamos ACOTADO a
      // `<contentRoot>/manifest.json` (un único archivo del mismo contentRoot —
      // nunca otros slugs) y lo empujamos. Best-effort: el deploy del slug ya
      // fue exitoso, un fallo aquí es solo informativo.
      try {
        const fileRes = writeCatalogManifestFile(ws)
        if (fileRes.ok && fileRes.changed && fileRes.relPath) {
          gitCommitPath(ws.repoPath, `catalog: actualizar manifest.json`, fileRes.relPath)
          try {
            gitPush(ws.repoPath)
          } catch {
            /* push best-effort */
          }
        }
      } catch {
        /* mantener el archivo es best-effort; el catálogo S3 ya se subió */
      }
    }
  } else {
    warning = warning || 'S3 no está habilitado en este workspace; solo se hizo push.'
  }

  // 3) Write the deploy sidecar inside the slug dir.
  const deployedAt = new Date().toISOString()
  const sidecar = {
    deployed: true,
    lastDeployedAt: deployedAt,
    bucket: ws.s3?.bucket || '',
    prefix: ws.s3?.prefix || '',
    region: ws.s3?.region || 'us-east-1',
  }
  const sidecarAbs = resolve(ws.repoPath, ws.contentRoot, slug, '.deploy.json')
  const content = JSON.stringify(sidecar, null, 2)
  try {
    writeFileSync(sidecarAbs, content, 'utf-8')
    // Don't bounce the editor (the sidecar is not site.json, but be safe).
    markSelfWrite(sidecarAbs, Buffer.byteLength(content, 'utf-8'))
  } catch (e: any) {
    return { ok: false, pushed, s3, error: `No se pudo escribir .deploy.json: ${e?.message || ''}` }
  }

  // 4) Commit + push the sidecar, SCOPED to <contentRoot>/<slug>/.deploy.json.
  const relSlug = getContentRelPath(ws.id, slug) // e.g. content/portafolio/<slug>
  if (relSlug) {
    const sidecarRel = `${relSlug}/.deploy.json`
    const fecha = new Date(deployedAt).toLocaleDateString('es-ES')
    gitCommitPath(ws.repoPath, `deploy(${slug}): publicado en S3 ${fecha}`, sidecarRel)
    try {
      gitPush(ws.repoPath)
    } catch {
      /* push of sidecar best-effort — the deploy already happened */
    }
  }

  return { ok: true, pushed, s3, deployedAt, warning, manifest }
}
