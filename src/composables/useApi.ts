const BASE = ''

export async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  return res.json()
}

export const projectsApi = {
  list: () => api<{ eventos: any[]; site: any[] }>('/projects'),
  get: (type: string, slug: string) => api(`/projects/${type}/${slug}`),
  save: (type: string, slug: string, data: any) =>
    api(`/projects/${type}/${slug}`, { method: 'PUT', body: JSON.stringify(data) }),
  create: (type: string, slug: string) =>
    api(`/projects/${type}`, { method: 'POST', body: JSON.stringify({ slug }) }),
  duplicate: (type: string, slug: string) =>
    api(`/projects/${type}/${slug}/duplicate`, { method: 'POST' }),
  delete: (type: string, slug: string) =>
    api(`/projects/${type}/${slug}`, { method: 'DELETE' }),
  // Upload an image / video / audio (picked from anywhere / drag&drop) into
  // the project's content dir (images/ | video/ | audio/, routed by mime).
  // dataUrl = FileReader.readAsDataURL result.
  // Returns { ok, src, filename, bytes, kind, warning? } — src is
  // "<subdir>/<file>" (e.g. "images/foo.png", "video/clip.mp4").
  uploadAsset: (type: string, slug: string, filename: string, dataUrl: string) =>
    api<{ ok?: boolean; src?: string; filename?: string; bytes?: number; kind?: string; warning?: string; error?: string }>(
      `/projects/${type}/${slug}/assets`,
      { method: 'POST', body: JSON.stringify({ filename, dataUrl }) },
    ),
}

export const gitApi = {
  log: (type: string) => api(`/git/${type}/log`),
  commit: (type: string, message: string) =>
    api(`/git/${type}/commit`, { method: 'POST', body: JSON.stringify({ message }) }),
  push: (type: string) =>
    api(`/git/${type}/push`, { method: 'POST' }),
  revert: (type: string, hash: string) =>
    api(`/git/${type}/revert/${hash}`, { method: 'POST' }),
}

export const claudeApi = {
  run: (prompt: string, cwd: string) =>
    api<{ output: string; error?: string }>('/claude', {
      method: 'POST',
      body: JSON.stringify({ prompt, cwd }),
    }),
}
