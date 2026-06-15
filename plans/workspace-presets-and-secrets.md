# Plan: workspace presets + S3/Git credenciales via Keychain

Estado: APROBADO — pendiente de arranque.

Decisiones tomadas:
- **Preset behaviors elegidos**: a (slug `home` reservado + pineado), c (`publishManifest` default por preset), d/e/f (naming + warnings).
  - Descartado: b (esconder `link.site` en multi-tenant) — sigue ofreciéndose en ambos.
- **Git auth**: Opción C — PAT + git CLI con Doctor guía.

Orden de arranque sugerido por el plan: PR 1 primero, después PR 2 (desbloquea 3 y 4).
**Falta confirmar el arranque** — el usuario dijo que retoma para arrancar; cuando lo confirme, ejecutar el PR que indique.

---

## Estado actual del código (snapshot a 2026-06-14)

- `Workspace` schema (`server/workspaces.ts` + `src/stores/workspaces.ts`): tiene `id, name, repoPath, contentRoot, gitRemote?, useGit, s3?`. NO sabe del preset.
- `WorkspaceS3`: `enabled, bucket, prefix, region, publishManifest?`. NO tiene credenciales.
- `server/s3.ts`: `client(region)` instancia `new S3Client({ region })` sin credenciales explícitas → siempre usa la cadena por defecto de la SDK (~/.aws/credentials, env vars, SSO).
- `server/git.ts`: todo es `execSync('git …')` → requiere git CLI en PATH + auth pre-configurada (SSH key / osxkeychain / etc). NO usamos isomorphic-git ni simple-git.
- **Electron**: `safeStorage` (Chromium → macOS Keychain / Windows DPAPI / Linux libsecret) está disponible y NO se usa. Sin keytar.
- **Web mode** (sin Electron): no hay `safeStorage` → degradan a sesión efímera.
- `server/diagnostics.ts`: tiene `awsStatus()` (detecta ~/.aws o AWS_* env) y `git: gitConfigStatus()`. La Doctor screen los pinta.

---

## PR 1 — Preset por workspace (~2 días)

### Schema

`server/workspaces.ts` + `src/stores/workspaces.ts`:

```ts
interface Workspace {
  // …existente
  preset?: 'linked-home' | 'multi-tenant'   // default 'multi-tenant' (back-compat)
}
```

### Cambios

1. **`server/workspaces.ts`**: extender `Workspace`, parsear `raw.preset`, validar enum. Default `multi-tenant` cuando ausente — los workspaces existentes en localStorage no cambian comportamiento al cargar.

2. **`src/views/ProjectSelector.vue`** — modal de config (gear):
   - Nuevo bloque "Tipo de workspace" con dos cards radio:
     - **Sitio público con home** (`linked-home`) — "El slug `home` se renderiza en `/`; los demás slugs son sub-sitios enlazables desde el home."
     - **Sitios privados por URL** (`multi-tenant`) — "Cada slug es un sitio independiente accesible solo por URL directa."
   - El cambio de preset refresca `publishManifest` default SI el usuario no lo tocó explícitamente (ver punto 4).

3. **Comportamiento (a) — `home` pineado** (lista del selector):
   - Si `preset === 'linked-home'`: filtrar `home` de la lista normal, renderizarlo como card destacada arriba con badge "Inicio". Si no existe `home`, mostrar CTA "Crear sitio Home".
   - Si `preset === 'multi-tenant'`: lista plana, sin pin.

4. **Comportamiento (c) — `publishManifest` default**:
   - Al activar `linked-home`, si `publishManifest === undefined`, setear `true`.
   - Al activar `multi-tenant`, si `publishManifest === undefined`, setear `false`.
   - Si el usuario lo tocó (campo persistido en localStorage), respetar su elección — necesita un flag `publishManifestUserSet?: boolean` para distinguir "no tocado" de "explícitamente false".

5. **Comportamiento (d/e/f) — copy + warnings** (`src/locales/{es,en}.ts` + i18n keys):
   - Copy del botón "Nuevo proyecto" → "Nuevo evento" (multi-tenant) / "Nuevo sitio" (linked-home).
   - Placeholder slug del modal de crear → `maria-y-jose` (multi-tenant) / `mi-mundo` (linked-home).
   - En `GitPanel.vue` (botón Publicar), si `multi-tenant` y `site.meta.ogImage` falta → modal blocker "Este sitio no tiene imagen para compartir por WhatsApp. ¿Publicar de todos modos?"
   - Doctor screen muestra warning amarillo "Robots.txt inconsistente" si workspace es `linked-home` y el bucket tiene `Disallow: /`, o viceversa para multi-tenant.

6. **Test**: extender `e2e/fixtures/content/` con un fixture de cada preset; nuevo smoke test que valida defaults aplicados.

### NO incluye

- Cambio (b) "esconder `link.site` en multi-tenant" — descartado.

---

## PR 2 — SecretsBus: Electron safeStorage + IPC (~1.5 días)

Foundation reutilizable por S3 y Git. Regla dura: **nunca exponer secretos al renderer en texto plano**.

### Archivos nuevos

- **`electron/secrets.cjs`** (main process):
  - `loadStore()`: lee `userData/secrets.json` (formato `{ [key]: base64-encrypted-blob }`).
  - `setSecret(key, value)`: `safeStorage.encryptString(value)` → base64 → write atomic (write to `.tmp` + rename).
  - `getSecret(key)`: lee blob → `safeStorage.decryptString` → devuelve string.
  - `deleteSecret(key)`: borra entrada, persiste.
  - `listKeys()`: devuelve solo las claves (no los valores) — para diagnóstico.
- **`electron/preload.cjs`**: agregar canal IPC `parallax:secrets:{set,get,delete,list}` con allowlist explícita. NO exponer una API genérica de IPC.
- **`src/composables/useSecrets.ts`**: wrapper que detecta Electron (`window.parallax?.secrets`) vs web. En web: fallback a `sessionStorage` cifrado simétricamente con clave random en memoria (efímero por sesión, warning claro en UI).

### Convención de keys

```
s3:<workspace.id>          → JSON { accessKeyId, secretAccessKey }
git:<workspace.id>         → JSON { username, token, provider }
```

### Diagnóstico

- `server/diagnostics.ts`: agregar `secretsBackend: 'safeStorage'|'session'|null` al payload.
- Doctor screen pinta como badge ("Keychain del Mac" vs "Sesión efímera").

### Tests

- Unit test del wrapper en modo web (sessionStorage path).
- E2E manual de safeStorage en Electron empaquetado (validar que persiste entre reinicios).
- Caso edge: `safeStorage.isEncryptionAvailable()` — en algunos Linux sin libsecret devuelve false; el wrapper debe caer a sesión efímera con warning.

---

## PR 3 — S3 con credenciales por workspace (~1.5 días, depende de PR 2)

### Schema

```ts
interface WorkspaceS3 {
  // …existente
  credentialsMode: 'system' | 'explicit'   // default 'system' (back-compat)
  // accessKeyId/secret NUNCA viven aquí — referencia via key `s3:${ws.id}` en SecretsBus
}
```

### Cambios

1. **`server/s3.ts`**:
   - `client(region, credentials?)`: si `credentials` viene, pasar al `S3Client({ credentials })`; si no, default chain.
   - Cada función expuesta (`syncSiteToS3`, `publishCatalogManifest`, `deleteSiteFromS3`, `createBucket`, `listBuckets`) acepta `credentials?` opcional en su firma.

2. **`server/api.ts`**: endpoints `/api/s3/*` y `/api/git/:type/push` aceptan body opcional `{ credentials: { accessKeyId, secretAccessKey } }`. Validar shape, NO loguear, NO persistir en el cache del host.

3. **`src/views/ProjectSelector.vue`** (modal):
   - Nuevo bloque "Credenciales S3" con radio:
     - "Usar las del sistema (AWS CLI / variables de entorno)" — default.
     - "Definir credenciales solo para este workspace".
   - Cuando "explicit": campos `accessKeyId` (text) + `secretAccessKey` (password) + botón "Mostrar/Ocultar".
   - Al guardar: `useSecrets.set('s3:'+ws.id, JSON.stringify({accessKeyId, secretAccessKey}))`. NO va al localStorage.
   - Botón ícono "?" abre `<S3PolicyHelpModal>` (nuevo componente) con la policy IAM mínima en bloque copiable + instrucciones paso-a-paso de cómo crear un IAM user en AWS Console.

### Policy IAM mínima a mostrar en el modal de ayuda

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject","s3:DeleteObject","s3:GetObject","s3:ListBucket"],
    "Resource": ["arn:aws:s3:::TU-BUCKET","arn:aws:s3:::TU-BUCKET/*"]
  }]
}
```

4. **`src/composables/useApi.ts`**: `s3Api.publish(...)` resuelve las credenciales del SecretsBus JUSTO ANTES del fetch y las inyecta en el body. Si `credentialsMode === 'system'`, no las manda.

5. **Validación**: al pulsar "Guardar" en el modal con credenciales explícitas, hacer un `HeadBucket` test antes de cerrar. Si falla → mensaje claro "Las credenciales no pueden acceder al bucket".

### Tests

- Unit con `@aws-sdk/client-s3` mockeado: verifica que `credentials` llega al constructor cuando `credentialsMode === 'explicit'` y NO llega cuando es `'system'`.
- E2E opcional con `localstack` (no bloqueante).

---

## PR 4 — Git PAT + Doctor guía (~3 días, depende de PR 2)

### Schema

```ts
interface WorkspaceGit {
  authMode: 'system' | 'pat'    // default 'system'
  provider?: 'github' | 'gitlab' | 'bitbucket'
  // username/token NUNCA viven aquí — referencia via key `git:${ws.id}` en SecretsBus
}
interface Workspace {
  // …existente
  git?: WorkspaceGit
}
```

### Cambios

1. **`server/git.ts`**:
   - Nueva función `gitPushWithAuth(cwd, auth?)`:
     - Si `auth` está presente: crear un script temporal `GIT_ASKPASS` en `os.tmpdir()` que printea `auth.username` o `auth.token` según `$1`. `chmod +x`. Setear `GIT_ASKPASS=<path>` + `GIT_TERMINAL_PROMPT=0` en el env del `execSync`. Borrar script en `finally`.
     - Si `auth` ausente: comportamiento actual (`git push` puro).
   - Validar que el remote sea HTTPS (no SSH) cuando se usa PAT — si es SSH, devolver error claro "El remoto está en SSH, pero configuraste un PAT. Cambia el remoto a HTTPS para usar PAT, o quita el PAT para usar tu SSH key."
   - El path actual `gitPush(cwd)` queda como compat — internamente llama a `gitPushWithAuth(cwd, undefined)`.

2. **`server/api.ts`**: `/api/git/:type/push` acepta body `{ auth?: { username, token } }`. Igual que S3: NO se cachea en el host.

3. **`src/views/ProjectSelector.vue`** (modal):
   - Nuevo bloque "Autenticación Git" con radio:
     - "Usar autenticación del sistema (SSH key / Keychain)" — default.
     - "Personal Access Token (para HTTPS)".
   - Cuando "PAT": select de provider, campos `username` + `token` (password). Botón "?" → `<GitTokenHelpModal>` con instrucciones por provider:
     - **GitHub**: enlace directo a Settings → Developer settings → Personal access tokens → Fine-grained tokens → seleccionar el repo + scope `Contents: read & write` + `Metadata: read`.
     - **GitLab**: enlace a Settings → Access Tokens → scope `write_repository`.
     - **Bitbucket**: enlace a Personal Bitbucket settings → App passwords → `Repositories: write`.
   - Validación al guardar: hacer un `git ls-remote --heads <remote>` con el ASKPASS inyectado. Si responde → token válido.

4. **Doctor screen** (`server/diagnostics.ts` + `src/components/doctor/DoctorHost.vue`):
   - Detectar "git CLI ok pero no hay credenciales útiles" — heurística: `git config --get credential.helper` Y no hay `~/.ssh/id_*`.
   - Si workspace activo usa git Y no hay credenciales detectadas Y `authMode === 'system'`: warning amarillo "No detecté autenticación de Git en tu sistema. Si vas a publicar, configura un PAT en este workspace."
   - Warning per-workspace, no global.
   - Botón "Configurar ahora" abre el modal del workspace en el bloque "Autenticación Git".

5. **`useApi.ts`**: igual que S3, `gitApi.push(...)` resuelve el secret antes del fetch.

### Tests

- E2E con un repo local "bare" como remoto + un PAT falso → valida que ASKPASS se invoca con el token.
- Manual: push real contra un repo de prueba en GitHub con un fine-grained PAT.

---

## Total y orden

| PR | Estimación | Dependencias | Riesgo |
|---|---|---|---|
| 1 — Preset por workspace | ~2 días | ninguna | bajo |
| 2 — SecretsBus | ~1.5 días | ninguna | medio (Electron safeStorage en build firmado — aún no hay firma de código, validar que no rompe nada cuando se agregue) |
| 3 — S3 credenciales | ~1.5 días | PR 2 | bajo |
| 4 — Git PAT + Doctor | ~3 días | PR 2 | medio (validación de remote SSH→HTTPS, edge cases de git config) |

**Total: ~8 días hábiles**, 4 PRs.

## Fuera de scope (intencional)

- Migrar git CLI a `isomorphic-git` (opción A descartada). Si en el futuro hay que soportar Windows sin Git for Windows, ese trabajo se planea aparte (~2 semanas).
- Sincronización cloud de la config de workspaces — fuera de scope del editor local.
- Cambio (b) "esconder `link.site` en multi-tenant" — descartado.
