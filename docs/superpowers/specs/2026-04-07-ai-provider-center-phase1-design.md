# AI Provider Center — Phase 1 (Ollama BuildIn)

**Date:** 2026-04-07
**Status:** Approved for implementation (revised after design review)
**Strategy:** Vertical slice — first phase of a 7-phase rework

## Goal

Deliver an end-to-end working slice that lets a user, from a fresh install of Notter-AI:

1. Open a "Manage AI" dialog from the user menu
2. Install Ollama silently from inside the app (no manual download, no installer wizard)
3. Pull one of three pre-defined vision/code multimodal models with a real progress bar
4. Mark a model as the active default
5. Test the model in an inline chat and see a response

By the end of Phase 1, the app has a working local AI provider. Phases 2–7 build on top of this foundation: Planner UX rework, Actions tab, processing pipeline, terminal integration, multi-provider expansion, and callback system.

## Non-Goals (out of scope for Phase 1)

- Cloud providers (Gemini, Claude, OpenAI, DeepSeek) — Phase 6
- Role assignment per task type — Phase 6
- Custom Ollama model name input — Phase 6 (stretch)
- Actions schema, Planner UX rework, Actions tab UI, processing pipeline — Phases 2–5
- Syncing provider config to Supabase — provider state is per-machine
- Replacing or removing the existing AgentsTab — it stays in dev mode, not touched

## User experience

### Entry point
A new menu item **"Manage AI"** in the UserMenu, between **Settings** and **Plugins**, opens the dialog. The dialog is full-width (`max-w-3xl`), with a fixed height that fits the model list comfortably.

### Layout
The dialog has two panels side-by-side:

- **Left panel (provider list, ~200px)**
  Lists every supported provider. In Phase 1 there is exactly one entry: **Ollama** (with a small status dot — gray = not installed, amber = installed but service down, green = running). Selecting a provider shows its detail panel on the right. (The list is built to scale to multiple providers in Phase 6, but only one is active now.)

- **Right panel (provider detail, fills remaining width)**
  Header strip with provider name + status badge + a context-sensitive action button:
    - When `not-installed`: **Install Ollama**
    - When `stopped`: **Start Ollama**
    - When `running`: no action button (just the green status dot)
  Below the header, a vertically scrollable area with three sections:
    1. **Models** — three cards, one per pre-defined model
    2. **Active model** — small banner showing which model is currently the default
    3. **Test connection** — a chat box (single-turn) to send a message to the active model and see its response

### Model card
Each card has:
- Model name (large) and one-line description
- Disk size estimate (e.g., "3.3 GB")
- Status: `Not installed` / `Pulling layer X of Y · Z%` / `Installed`
- Actions:
  - When `Not installed`: **Install** button → triggers pull, swaps to a progress display.
    - **Disabled** while any other model is currently pulling (Ollama serializes pulls server-side).
  - When `Installing`: progress display with current layer status + "Hide" link.
    - **No Cancel button** in Phase 1. Once a pull starts, it runs to completion. Reasoning: the Ollama HTTP API has no `cancel` endpoint, so an "abort" on the JS side would only stop UI updates while the backend keeps downloading and leaves orphaned partial files. Adding a real cancel requires an explicit cleanup flow (delete partial layers via filesystem) that's out of scope for Phase 1. The "Hide" link just collapses the progress UI; the pull continues in the background.
  - When `Installed`:
    - **Set as default** button (or "Default" badge if already active)
    - **Remove** button (icon-only, with confirm dialog) → calls `DELETE /api/delete`

### Pre-defined models

| Key | Display name | Ollama tag | Disk | Notes |
|---|---|---|---|---|
| `qwen3-vl-4b` | Qwen3-VL 4B | `qwen3-vl:4b` | 3.3 GB | Recommended default, vision + code |
| `qwen3-vl-8b` | Qwen3-VL 8B | `qwen3-vl:8b` | 6.1 GB | Higher quality, needs ~10GB VRAM |
| `llama3.2-vision-11b` | Llama 3.2 Vision 11B | `llama3.2-vision:11b` | 7.0 GB | Meta alternative, strong vision |

### Install Ollama flow

When Ollama is not detected:
1. User clicks **Install Ollama**
2. Dialog body switches to a centered installer UI:
   - "Downloading OllamaSetup.exe..."
   - Progress bar with `XX MB / YY MB`
3. After download finishes:
   - "Installing Ollama..." (indeterminate spinner)
4. After installer exits:
   - App pings `http://localhost:11434/api/tags` every 1s, up to 60s, until service responds (60s instead of 30s — first run may generate keys/configs)
5. On success: dialog returns to the normal layout, status badge becomes green
6. On failure: red error banner with the underlying error and a manual link to `https://ollama.com/download`

> **Silent install flag — verify during implementation.** Ollama's Windows installer is custom (not pure NSIS). The expected flag is `/SILENT` (Inno Setup-style), but `/S` (NSIS) and `--silent` are alternatives seen in different versions. Implementation must:
> 1. Try `/SILENT` first
> 2. If installer process opens a visible window (detected by checking if it spawned UI in the foreground within 2s) or exits with an unexpected code, fall back to `/S`
> 3. If both fail, surface a clear error and offer the manual download link
> The implementation plan must include a verification task: download the current OllamaSetup.exe and confirm which silent flag works on the target Windows version before wiring it into the Rust command.

### Start Ollama flow (service stopped)

When Ollama is installed but the service is not responding:
1. Status badge shows "Service stopped" (amber)
2. Right panel header shows **Start Ollama** button
3. User clicks → app calls Rust command `ollama_start_service` which runs `ollama serve` as a detached background process
4. App polls `ollama_check_running` every 1s for up to 15s
5. On success: status flips to green, button disappears
6. On failure: red banner with "Could not start Ollama service. Try restarting your machine or [manual instructions]"

> **Why a Tauri command instead of `Start-Service`:** Ollama on Windows installs as a per-user app (no admin rights), not a Windows service in the traditional sense. The `ollama serve` command is the canonical way to start it. We spawn it detached so it survives our app exit.

### Pull model flow

1. User clicks **Install** on a model card (other model Install buttons become disabled)
2. App calls `POST http://localhost:11434/api/pull` with `{"model": "qwen3-vl:4b", "stream": true}`
3. The fetch is owned by the **store**, not the component, so the dialog can be closed and reopened without losing state. The store keeps a reference to the active reader and the latest progress per tag.
4. Streamed NDJSON events (one JSON per line, parsed via a buffered reader) update the card:
   - `{"status":"pulling manifest"}` → "Pulling manifest..."
   - `{"status":"downloading","digest":"sha256:...","total":N,"completed":M}` → "Pulling layer (currentIdx)/(layerCount) · M/N (Z%)" — we use only the current layer's progress; no overall sum across layers in Phase 1
   - `{"status":"verifying sha256 digest"}` → "Verifying..."
   - `{"status":"writing manifest"}` → "Writing manifest..."
   - `{"status":"success"}` → "Installed", refresh `installedModels`, switch to action buttons
5. On error: red text on the card with the error, **Retry** button (calls `pullModel(tag)` again)
6. The number of layers is unknown until the first `downloading` event arrives, so the early UI shows just "Pulling manifest..." then transitions to per-layer once the first layer starts. We don't try to predict layer count.

### Test connection

Below the model list:
- Single text input for a prompt
- **Send** button
- Response area (read-only, multiline)
- Status: `idle` / `loading model` / `generating` / `received` / `error`

This calls `POST http://localhost:11434/api/generate` with the active model and `stream: false`. No history, no chat thread — just one shot to verify the model answers.

> **First-time latency UX.** When a model is called for the first time after the Ollama service starts (or after a long idle), Ollama loads the model into RAM/VRAM. This can take **10–60 seconds** depending on model size. The send flow handles it as follows:
> 1. On click → status `generating`, button disabled, response area shows "Sending..."
> 2. After 3 seconds without a response → status `loading model`, response area shows "Loading model into memory (this can take up to a minute on first use)..."
> 3. When response arrives → status `received`, full text shown
> 4. On timeout (90s) or HTTP error → status `error`, response area shows the error text

If no model is set as active, the test box is disabled with a hint: *"Set a default model first."*

## Architecture

### Frontend modules

```
src/
├── components/
│   ├── UserMenu.tsx              # Add "Manage AI" menu item
│   └── ai/
│       ├── ManageAiDialog.tsx    # Top-level dialog, holds layout
│       ├── ProviderList.tsx      # Left column (Ollama only for now)
│       ├── OllamaPanel.tsx       # Right column for Ollama
│       ├── OllamaInstaller.tsx   # Download + install UI
│       ├── ModelCard.tsx         # Single model card with progress
│       └── TestConnection.tsx    # Inline test chat
├── lib/
│   └── ollama.ts                 # HTTP client for Ollama API
└── stores/
    └── ai-store.ts               # Zustand store: providers, models, active
```

### Backend Rust commands

```rust
// New file: src-tauri/src/ollama_install.rs

#[tauri::command]
async fn ollama_download_installer(
    url: String,
    dest_path: String,
    app: AppHandle,
) -> Result<String, String> { ... }
// Uses reqwest with streaming response. Follows redirects (default).
// Streams progress via Tauri event "ollama-download-progress" { downloaded, total }
// Returns the absolute path to the downloaded file.

#[tauri::command]
async fn ollama_run_installer(path: String) -> Result<i32, String> { ... }
// Uses tokio::process::Command (NOT std::process::Command — must not block runtime).
// Tries silent flag /SILENT first; if installer process is still running with a visible
// window after 2s, kills it and retries with /S. Returns the exit code on success.

#[tauri::command]
async fn ollama_start_service() -> Result<(), String> { ... }
// Spawns `ollama serve` as a detached process so it survives the app exit.
// Uses tokio::process::Command with detached spawn (no waiting).

#[tauri::command]
async fn ollama_check_running() -> Result<bool, String> { ... }
// HTTP GET localhost:11434/api/tags using existing reqwest client, 2s timeout.
// Returns true if 200, false on connection refused or timeout.
```

**Wire-in:** All four commands must be added to the existing `tauri::generate_handler![...]` array in `src-tauri/src/lib.rs`. The new file `ollama_install.rs` must be declared as a module via `mod ollama_install;` and the commands re-exported or referenced via the module path.

The model pull, delete, list, and chat test do **not** need Rust commands — they call `localhost:11434` directly from the JS via `fetch`, since it's a local HTTP server with no CORS issues from a Tauri webview (CSP is `null`).

### Ollama HTTP client (`src/lib/ollama.ts`)

```ts
const OLLAMA_BASE = 'http://localhost:11434';

export async function listInstalledModels(): Promise<string[]>;
export async function pullModel(
  tag: string,
  onProgress: (percent: number, status: string) => void,
): Promise<void>;
export async function deleteModel(tag: string): Promise<void>;
export async function generate(
  model: string,
  prompt: string,
): Promise<string>;
export async function checkRunning(): Promise<boolean>;
```

`pullModel` reads the streaming NDJSON response with a `ReadableStreamDefaultReader` and calls `onProgress` for each event.

### State store (`src/stores/ai-store.ts`)

```ts
type OllamaStatus = 'unknown' | 'not-installed' | 'stopped' | 'running';

interface PullProgress {
  status: string;            // "pulling manifest" | "downloading" | "verifying" | etc.
  layerLabel: string | null; // "layer 2 of 5" (best-effort)
  percent: number;           // 0-100 of current layer
}

interface AiState {
  ollamaStatus: OllamaStatus;
  installedModels: string[];                  // tags returned by /api/tags
  activeModelTag: string | null;              // user's default
  pulling: Record<string, PullProgress>;      // tag -> progress, absent if not pulling
  installingOllama: { downloaded: number; total: number } | null;

  // actions
  initialize(): Promise<void>;                // run on app boot — loads persisted state + refreshStatus
  refreshStatus(): Promise<void>;
  refreshInstalledModels(): Promise<void>;    // also validates activeModelTag still exists
  installOllama(): Promise<void>;
  startOllamaService(): Promise<void>;
  pullModel(tag: string): Promise<void>;
  removeModel(tag: string): Promise<void>;
  setActiveModel(tag: string): void;
}
```

**Key design points:**
- **Pulls live in the store**, not in any component. When the user closes the dialog mid-pull, the fetch continues because the store is app-wide. Reopening the dialog shows the latest progress from `pulling[tag]`.
- **At most one pull at a time** — `pullModel(tag)` throws synchronously if `Object.keys(pulling).length > 0`. The UI disables other Install buttons during a pull.
- **Active model validation** — `refreshInstalledModels` checks `activeModelTag != null && !installedModels.includes(activeModelTag)`. If so, clears `activeModelTag` and persists the change. This prevents the test box from calling a deleted model.
- **Persistence** — `activeModelTag` is the only value persisted, in `localStorage` under key `notter-ai:provider-state`. Everything else is ephemeral runtime state. No Supabase sync — provider config is per-machine and tied to local installation.
- **Initialization** — `initialize()` is called once on app boot from `App.tsx` (alongside `useAuthStore().initialize()`). It loads `activeModelTag` from localStorage, then runs `refreshStatus` and `refreshInstalledModels` in background. The dialog doesn't need to re-run these on every open unless the user forced a manual refresh.

### Pre-defined model registry

A constant in `src/lib/ai-models.ts`:

```ts
export const BUILTIN_MODELS = [
  { id: 'qwen3-vl-4b', tag: 'qwen3-vl:4b', name: 'Qwen3-VL 4B', sizeGb: 3.3, recommended: true },
  { id: 'qwen3-vl-8b', tag: 'qwen3-vl:8b', name: 'Qwen3-VL 8B', sizeGb: 6.1 },
  { id: 'llama3.2-vision-11b', tag: 'llama3.2-vision:11b', name: 'Llama 3.2 Vision 11B', sizeGb: 7.0 },
] as const;
```

## Data flow examples

### Opening the dialog (cold)
1. User clicks "Manage AI" in UserMenu
2. `ManageAiDialog` mounts, calls `aiStore.refreshStatus()` and `refreshInstalledModels()`
3. `refreshStatus` calls Tauri command `ollama_check_running` → updates `ollamaStatus`
4. If running, `refreshInstalledModels` calls `GET /api/tags` → fills `installedModels`
5. UI renders the panel with current state

### Installing Ollama
1. User clicks **Install Ollama**
2. `aiStore.installOllama()`:
   - Resolves installer URL: `https://ollama.com/download/OllamaSetup.exe`
   - Computes destination: `$APPLOCALDATA/notter-ai/OllamaSetup.exe`
   - Calls `ollama_download_installer(url, dest)` which streams progress events
   - Listens to `ollama-download-progress` events, updates `installingOllama` state
   - On download done, calls `ollama_run_installer(dest)`
   - On installer exit, polls `ollama_check_running` until true (max 30s)
   - On running, sets `ollamaStatus = 'running'`, clears `installingOllama`
3. UI auto-updates from store changes

### Pulling a model
1. User clicks **Install** on Qwen3-VL 4B card
2. `aiStore.pullModel('qwen3-vl:4b')`:
   - Throws if any other tag is in `pulling` (UI prevents this; defensive check)
   - Sets `pulling['qwen3-vl:4b'] = { status: 'pulling manifest', layerLabel: null, percent: 0 }`
   - Calls `pullModel(tag, (progress) => store.setProgress(tag, progress))` from `lib/ollama.ts`
   - The fetch reader is held by the store, not the component; closing the dialog doesn't abort it
   - On each NDJSON event, updates `pulling[tag]` with new layer/percent
   - On success: removes from `pulling`, calls `refreshInstalledModels()` (which re-validates active model)
3. UI re-renders the card from `not installed` → `Pulling layer X of Y · Z%` → `installed`

### Test message
1. User types prompt, clicks **Send**
2. `TestConnection` calls `generate(activeModelTag, prompt)`
3. Receives full text, displays in response area

## Error handling

| Failure | Behavior |
|---|---|
| `ollama_check_running` returns false after being true | Status badge flips to "Service stopped" (amber); right panel header shows **Start Ollama** button |
| Download fails (network) | Red banner in installer view: error message + "Try again" button |
| Installer exits with non-zero code or fails both silent flags | Red banner: "Installation failed (exit code N). [Manual download]" link to `https://ollama.com/download` |
| Service does not respond within 60s post-install | Banner: "Ollama installed but service did not start. [Start manually] [Restart app]" |
| `ollama_start_service` fails or service doesn't come up in 15s | Red banner on the right panel: error + manual instructions |
| Port 11434 is in use by a non-Ollama process | `/api/tags` returns unexpected JSON → status stays `unknown`, banner: "Port 11434 is in use by another application. Free the port and retry." |
| Second `pullModel` called while another is in progress | Throws synchronously; UI never allows clicking it (button disabled while `pulling` is non-empty) |
| `pullModel` fails mid-stream | Card shows red text with the error + **Retry** button. `pulling[tag]` is cleared. No partial state — the user can retry clean. |
| `removeModel` fails | Toast-level error; model stays in list, user can retry |
| `generate` fails or times out (90s) in test | Response area shows red error text with the message; status → `error`. User can re-send. |
| Active model tag points to a model no longer installed | On next `refreshInstalledModels`, cleared to null and persisted. Test box re-disables. |

All errors are logged via `console.error`. No global toast spam — errors appear in the relevant panel. Only `removeModel` uses a toast because there's no panel to put the error in.

## Security considerations

- **Installer integrity**: We download the official `OllamaSetup.exe` from `ollama.com/download/OllamaSetup.exe` over HTTPS (with redirects followed). No checksum verification in Phase 1 (Ollama doesn't publish a stable hash file). Phase 6 stretch: verify SHA256 against an embedded list pulled from Ollama's GitHub releases API.
- **Tauri permissions**: New Rust commands need to be added to `invoke_handler` in `lib.rs`. Custom commands don't require capability entries (those are for plugin permissions). The new `reqwest` calls reuse the existing client. No new plugins required.
- **Process spawn**: `tokio::process::Command` is used for installer + service start (NOT `std::process::Command` — would block the async runtime).
- **No API keys yet**: Phase 1 is local-only. No secrets to store. Phase 6 will introduce the secrets vault for cloud providers.

## i18n keys to add

New translation entries under `manage_ai.*` in both `src/i18n/locales/en.json` and `src/i18n/locales/pt-BR.json`:

| Key | EN | PT-BR |
|---|---|---|
| `user_menu.manage_ai` | "Manage AI" | "Gerenciar IA" |
| `manage_ai.title` | "Manage AI Providers" | "Gerenciar Provedores de IA" |
| `manage_ai.providers` | "Providers" | "Provedores" |
| `manage_ai.status_unknown` | "Checking..." | "Verificando..." |
| `manage_ai.status_not_installed` | "Not installed" | "Não instalado" |
| `manage_ai.status_stopped` | "Service stopped" | "Serviço parado" |
| `manage_ai.status_running` | "Running" | "Em execução" |
| `manage_ai.install_ollama` | "Install Ollama" | "Instalar Ollama" |
| `manage_ai.start_ollama` | "Start Ollama" | "Iniciar Ollama" |
| `manage_ai.downloading` | "Downloading {{downloaded}} / {{total}}" | "Baixando {{downloaded}} / {{total}}" |
| `manage_ai.installing_ollama` | "Installing Ollama..." | "Instalando Ollama..." |
| `manage_ai.starting_service` | "Starting service..." | "Iniciando serviço..." |
| `manage_ai.models` | "Models" | "Modelos" |
| `manage_ai.install` | "Install" | "Instalar" |
| `manage_ai.installed` | "Installed" | "Instalado" |
| `manage_ai.pulling_manifest` | "Pulling manifest..." | "Buscando manifesto..." |
| `manage_ai.pulling_layer` | "Layer {{current}} of {{total}} · {{percent}}%" | "Camada {{current}} de {{total}} · {{percent}}%" |
| `manage_ai.verifying` | "Verifying..." | "Verificando..." |
| `manage_ai.set_default` | "Set as default" | "Definir como padrão" |
| `manage_ai.default_badge` | "Default" | "Padrão" |
| `manage_ai.remove` | "Remove" | "Remover" |
| `manage_ai.remove_confirm` | "Remove {{name}}? This frees {{size}} of disk." | "Remover {{name}}? Isso libera {{size}} de disco." |
| `manage_ai.test_title` | "Test connection" | "Testar conexão" |
| `manage_ai.test_placeholder` | "Type a message to test the active model..." | "Digite uma mensagem para testar o modelo ativo..." |
| `manage_ai.test_send` | "Send" | "Enviar" |
| `manage_ai.test_no_default` | "Set a default model first." | "Defina um modelo padrão primeiro." |
| `manage_ai.test_loading_model` | "Loading model into memory (this can take up to a minute on first use)..." | "Carregando modelo na memória (pode levar até um minuto na primeira vez)..." |
| `manage_ai.test_generating` | "Sending..." | "Enviando..." |
| `manage_ai.error_download` | "Download failed: {{error}}" | "Falha no download: {{error}}" |
| `manage_ai.error_install` | "Installation failed (exit code {{code}})." | "Falha na instalação (código {{code}})." |
| `manage_ai.error_service_timeout` | "Ollama installed but service did not start in time." | "Ollama instalado, mas o serviço não iniciou a tempo." |
| `manage_ai.error_port_busy` | "Port 11434 is in use by another application. Free the port and retry." | "A porta 11434 está em uso por outra aplicação. Libere a porta e tente novamente." |
| `manage_ai.error_pull` | "Pull failed: {{error}}" | "Falha no download: {{error}}" |
| `manage_ai.try_again` | "Try again" | "Tentar de novo" |
| `manage_ai.retry` | "Retry" | "Tentar novamente" |
| `manage_ai.manual_download` | "Manual download" | "Download manual" |

## Testing strategy

Manual smoke test (no automated tests in Phase 1):

1. **Silent flag verification (prerequisite)**: Before wiring the install command, manually download the current `OllamaSetup.exe` and test which silent flag is actually silent on the target Windows version. Document the finding in the plan.
2. **Cold install path**: Uninstall Ollama from the test machine, launch Notter-AI, open Manage AI, click Install Ollama, verify download progress shows real MB, verify no installer window pops up, verify status flips to green within 60s.
3. **Pull path**: With Ollama running but no models, click Install on Qwen3-VL 4B, verify "Pulling manifest..." → "Layer X of Y" → "Installed". Verify other model Install buttons are disabled during the pull.
4. **Default + test path**: Click "Set as default", type "Hi" in test box, verify the "Loading model..." state appears if first generate takes >3s, verify a coherent response comes back within 90s.
5. **Remove path**: Click remove on a model, confirm, verify the card flips back to "Not installed". Verify that if the removed model was the active default, the default is cleared.
6. **Restart persistence**: Close the app, reopen, verify the active model is still selected and Ollama status is detected correctly without manual action.
7. **Start service path**: Stop the Ollama service manually (`Stop-Process -Name ollama`), reopen the dialog, click Start Ollama, verify service comes back up.
8. **Active model validation**: Set a model as default, close the dialog, run `ollama rm <model>` in a terminal, reopen the dialog, verify the default is cleared and the test box is disabled.

Edge cases to verify:
- Closing the dialog mid-pull and reopening: progress must still be visible and advancing.
- Port 11434 occupied by another process: error banner must be clear.
- Ollama service stopped manually after install: status should flip to "stopped" on next refresh and show the Start button.
- Calling the pull flow twice in rapid succession (double-click): must not start two pulls.

No unit tests added in Phase 1 — the surface is mostly UI + HTTP calls to a local service that is itself the source of truth. We add tests in Phase 4 when the processing pipeline introduces business logic worth covering.

## Risks & open questions

- **Silent install flag uncertainty**: Ollama's Windows installer silent-flag behavior changes between versions. The implementation plan must include an explicit verification task (download the current installer on a dev machine, try `/SILENT` and `/S` and observe which one runs without UI). If neither works on the current release, the fallback is the manual download link. Do NOT ship this feature until the silent flag is confirmed on a real Windows install.
- **Ollama installer URL stability**: We rely on `ollama.com/download/OllamaSetup.exe` being a permanent URL (with HTTP redirect to the actual CDN). If Ollama changes the path, the download fails. Mitigation: the error path surfaces a manual link. Phase 6 should switch to the GitHub releases API for resilience.
- **Model registry tag stability**: The three pre-defined models are pulled by tag from the Ollama public registry. If a tag is renamed (e.g., `qwen3-vl:4b` → `qwen3-vl:4b-instruct`), pull returns 404. Mitigation: custom model input in Phase 6; for Phase 1 the error surfaces and the user can install another model if the primary is broken.
- **Port 11434 conflict**: If another process owns port 11434 and returns non-JSON on GET `/api/tags`, our detection fails. Phase 1 surfaces a clear error but provides no auto-resolution. User must free the port manually.
- **Disk space**: We don't check available disk space before pulling a 7GB model. If the pull fails due to disk full, the error from Ollama bubbles up to the user. Acceptable for Phase 1.
- **VRAM mismatch**: A user with 4GB VRAM who pulls the 8B model will see slow inference or OOM at runtime. Phase 1 does not validate hardware; model card descriptions hint at requirements but don't enforce them.
- **Pull cancellation absence**: Without a cancel mechanism, a user who clicks Install on the wrong model is committed to waiting (or deleting after it completes). Adding proper cancel requires an out-of-band delete of partial layer files in the Ollama models directory; deferred to Phase 6.
- **CLI-installed extra models not shown**: A user who installs `mistral:7b` via CLI will see it in `/api/tags` but not in the Manage AI UI (only the 3 pre-defined cards are rendered). This is an explicit Phase 1 decision to keep the surface minimal; Phase 6 adds a "Custom models" section.

## Success criteria

Phase 1 is done when, on a fresh machine without Ollama:

1. ✅ User opens Notter-AI, clicks UserMenu → Manage AI
2. ✅ Dialog shows "Ollama: Not installed"
3. ✅ User clicks **Install Ollama**, sees a real download progress bar
4. ✅ After install, status flips to "Running" with a green dot
5. ✅ User clicks **Install** on Qwen3-VL 4B, sees real percent progress
6. ✅ User clicks **Set as default**
7. ✅ User types "Hello" in the test box, gets a coherent response from the model
8. ✅ User restarts the app, all state is preserved (active model, status detection)

No regressions to existing functionality (Planner, Terminals, OAuth login, auto-updater).
