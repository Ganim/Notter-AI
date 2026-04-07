# AI Provider Center — Phase 1 (Ollama BuildIn)

**Date:** 2026-04-07
**Status:** Approved for implementation
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
  Header strip with provider name + status badge + "Install Ollama" button (only when not installed).
  Below the header, a vertically scrollable area with three sections:
    1. **Models** — three cards, one per pre-defined model
    2. **Active model** — small banner showing which model is currently the default
    3. **Test connection** — a chat box (single-turn) to send a message to the active model and see its response

### Model card
Each card has:
- Model name (large) and one-line description
- Disk size estimate (e.g., "3.3 GB")
- Status: `Not installed` / `Installing 47%` / `Installed`
- Actions:
  - When `Not installed`: **Install** button → triggers pull, swaps to a progress bar
  - When `Installing`: progress bar with percent + "Cancel" link
  - When `Installed`:
    - **Set as default** button (or "Default" badge if already active)
    - **Remove** button (icon-only, with confirm)

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
   - App pings `http://localhost:11434/api/tags` every 1s, up to 30s, until service responds
5. On success: dialog returns to the normal layout, status badge becomes green
6. On failure: red error banner with the underlying error and a manual link to `https://ollama.com/download`

### Pull model flow

1. User clicks **Install** on a model card
2. App calls `POST http://localhost:11434/api/pull` with `{"model": "qwen3-vl:4b", "stream": true}`
3. Streamed JSON events update the card's progress bar:
   - `{"status":"pulling manifest"}` → "Pulling manifest..."
   - `{"status":"pulling ...","total":N,"completed":M}` → percent = `M/N * 100`
   - `{"status":"success"}` → "Installed", switch to action buttons
4. On error: red text on the card with the error, retry button

### Test connection

Below the model list:
- Single text input for a prompt
- **Send** button
- Response area (read-only, multiline)
- Status: idle / sending / received / error

This calls `POST http://localhost:11434/api/generate` with the active model and a non-streaming response. No history, no chat thread — just one shot to verify the model answers.

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
// Streams progress via event "ollama-download-progress" { downloaded, total }

#[tauri::command]
async fn ollama_run_installer(path: String) -> Result<(), String> { ... }
// Runs OllamaSetup.exe with /S, blocks until exit

#[tauri::command]
async fn ollama_check_running() -> Result<bool, String> { ... }
// HTTP GET localhost:11434/api/tags, returns true if 200
```

The model pull and chat test do **not** need Rust commands — they call `localhost:11434` directly from the JS via `fetch`, since it's a local HTTP server with no CORS issues from a Tauri webview.

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

interface AiState {
  ollamaStatus: OllamaStatus;
  installedModels: string[];          // tags returned by ollama
  activeModelTag: string | null;      // user's default
  installing: Record<string, number>; // tag -> percent (0..100), absent if not installing
  installingOllama: { downloaded: number; total: number } | null;

  // actions
  refreshStatus(): Promise<void>;
  refreshInstalledModels(): Promise<void>;
  installOllama(): Promise<void>;
  pullModel(tag: string): Promise<void>;
  cancelPull(tag: string): void;
  removeModel(tag: string): Promise<void>;
  setActiveModel(tag: string): void;
}
```

Active model and any other settings persist in `localStorage` under key `notter-ai:provider-state`. (No Supabase sync — provider config is per-machine and tied to local installation state.)

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
   - Sets `installing['qwen3-vl:4b'] = 0`
   - Calls `pullModel(tag, (percent, status) => store.setProgress(tag, percent))`
   - On success: removes from `installing`, refreshes `installedModels`
3. UI re-renders the card from `not installed` → `installing X%` → `installed`

### Test message
1. User types prompt, clicks **Send**
2. `TestConnection` calls `generate(activeModelTag, prompt)`
3. Receives full text, displays in response area

## Error handling

| Failure | Behavior |
|---|---|
| `ollama_check_running` returns false unexpectedly | Status badge shows "Service stopped"; "Install Ollama" button reverts to "Restart Ollama" (Phase 2 stretch — Phase 1 just shows the status, no action) |
| Download fails (network) | Red banner in installer view: error message + "Try again" button |
| Installer exits with non-zero code | Red banner: "Installation failed (exit code N). [Manual download]" link |
| Service does not respond within 30s post-install | Banner: "Ollama installed but service did not start. Try restarting your machine, or [Manual download]" |
| `pullModel` fails mid-stream | Card shows red text with the error + "Retry" button. State reverts to `not installed`. |
| `generate` fails in test | Response area shows red error text with the message |

All errors are logged via `console.error`. No global toast spam — errors appear in the relevant panel.

## Security considerations

- **Installer integrity**: We download the official `OllamaSetup.exe` from `ollama.com/download/OllamaSetup.exe` over HTTPS. No checksum verification in Phase 1 (Ollama doesn't publish a stable hash file). Phase 6 stretch: verify SHA256 against an embedded list.
- **Tauri permissions**: New Rust commands need to be added to `invoke_handler` in `lib.rs`. No new plugins required — uses existing `reqwest` and `std::process::Command`.
- **No API keys yet**: Phase 1 is local-only. No secrets to store. Phase 6 will introduce the secrets vault for cloud providers.

## Testing strategy

Manual smoke test (no automated tests in Phase 1):

1. **Cold install path**: Uninstall Ollama from the test machine, launch Notter-AI, open Manage AI, click Install Ollama, verify download progress, verify silent install, verify status flips to green.
2. **Pull path**: With Ollama running but no models, click Install on Qwen3-VL 4B, verify percent increments, verify final state shows "Installed".
3. **Default + test path**: Click "Set as default", type "Hi" in test box, verify a response comes back.
4. **Remove path**: Click remove on a model, confirm, verify the card flips back to "Not installed".
5. **Restart persistence**: Close the app, reopen, verify active model is still selected and Ollama status is detected correctly.

Edge cases to verify:
- Pulling two models simultaneously (should both progress in parallel)
- Closing the dialog mid-pull (should keep pulling in the background)
- Ollama service stopped manually after install (status should reflect on next refresh)

No unit tests added in Phase 1 — the surface is mostly UI + HTTP calls to a local service that is itself the source of truth. We add tests in Phase 4 when the processing pipeline introduces business logic worth covering.

## Risks & open questions

- **Ollama installer URL stability**: We rely on `ollama.com/download/OllamaSetup.exe` being a permanent URL. If Ollama changes their download path, we break. Mitigation: log failure cleanly and provide a manual link as fallback. Worth revisiting in Phase 6 to fetch via Ollama's GitHub releases API instead.
- **Model availability**: The three pre-defined models are pulled by tag from the public Ollama registry. If Ollama's registry changes a tag (e.g., `qwen3-vl:4b` becomes `qwen3-vl:4b-instruct`), pull will 404. Mitigation: manual override via custom model input is on the Phase 6 list.
- **Disk space**: We don't check available disk space before pulling a 7GB model. If the pull fails due to disk full, the error from Ollama bubbles up to the user. Acceptable for Phase 1.
- **VRAM mismatch**: A user with 4GB VRAM who pulls the 8B model will see slow inference or OOM errors at runtime. We don't validate this in Phase 1. The model card descriptions hint at requirements but don't enforce them.

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
