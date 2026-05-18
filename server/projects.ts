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
