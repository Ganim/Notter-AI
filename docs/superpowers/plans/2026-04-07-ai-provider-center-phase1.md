# AI Provider Center — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained "Manage AI" dialog that detects, installs, and manages a local Ollama runtime with three pre-defined vision/code models, plus an inline test chat — all from inside the Notter-AI app.

**Architecture:** A new Zustand store (`ai-store`) owns all provider/model state. Rust commands handle filesystem-touching operations (download, installer spawn, service start). All Ollama protocol calls (pull/list/delete/generate) are pure HTTP from JS to `localhost:11434`. UI lives in `src/components/ai/`, opened from a new menu item in UserMenu.

**Tech Stack:** Tauri 2 + React + Zustand + reqwest + tokio::process + Vitest (newly added for tests) + Ollama HTTP API

---

## File map

### Created
- `src-tauri/src/ollama_install.rs` — Rust commands for Ollama installation lifecycle
- `src/lib/ollama.ts` — TypeScript HTTP client for Ollama API
- `src/lib/ai-models.ts` — Pre-defined model registry constant
- `src/stores/ai-store.ts` — Zustand store for provider state
- `src/components/ai/ManageAiDialog.tsx` — Top-level dialog
- `src/components/ai/OllamaPanel.tsx` — Right column for Ollama provider
- `src/components/ai/ModelCard.tsx` — Model row with install/active/remove actions
- `src/components/ai/TestConnection.tsx` — Inline single-shot chat
- `src/lib/__tests__/ollama.test.ts` — Unit tests for HTTP client (mocked fetch)
- `src/stores/__tests__/ai-store.test.ts` — Unit tests for store actions (mocked client)
- `vitest.config.ts` — Test runner config

### Modified
- `src-tauri/Cargo.toml` — No new deps, existing reqwest + tokio
- `src-tauri/src/lib.rs` — Register ollama_install module + add commands to invoke_handler
- `src/App.tsx` — Call `useAiStore.getState().initialize()` on boot
- `src/components/UserMenu.tsx` — Add "Manage AI" menu item + dialog state
- `src/i18n/locales/en.json` — Add `manage_ai.*` keys
- `src/i18n/locales/pt-BR.json` — Add `manage_ai.*` keys (PT translations)
- `package.json` — Add vitest, @testing-library/react, jsdom to devDeps

---

## Tasks

### Task 1: Test infrastructure (Vitest)

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install vitest and supporting libs**

```bash
npm install --save-dev vitest @vitest/ui jsdom @testing-library/jest-dom
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
```

- [ ] **Step 3: Add test script to `package.json`**

Add `"test": "vitest run"` and `"test:watch": "vitest"` to the `scripts` block.

- [ ] **Step 4: Verify no tests yet runs cleanly**

```bash
npm test
```
Expected: "No test files found" (exit 0 from vitest with `--passWithNoTests` defaults, or exit code 1 — accept either as long as it does not crash).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "test: add vitest config and dev deps"
```

---

### Task 2: Pre-defined model registry

**Files:**
- Create: `src/lib/ai-models.ts`
- Test: `src/lib/__tests__/ai-models.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/ai-models.test.ts
import { describe, it, expect } from 'vitest';
import { BUILTIN_MODELS, findModelByTag } from '@/lib/ai-models';

describe('ai-models registry', () => {
  it('exposes exactly 3 builtin models', () => {
    expect(BUILTIN_MODELS).toHaveLength(3);
  });

  it('marks Qwen3-VL 4B as recommended', () => {
    const recommended = BUILTIN_MODELS.filter((m) => m.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].tag).toBe('qwen3-vl:4b');
  });

  it('findModelByTag returns the right entry', () => {
    expect(findModelByTag('qwen3-vl:8b')?.id).toBe('qwen3-vl-8b');
    expect(findModelByTag('nonexistent')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- ai-models
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/ai-models.ts`**

```ts
export interface BuiltinModel {
  id: string;
  tag: string;
  name: string;
  description: string;
  sizeGb: number;
  recommended?: boolean;
}

export const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: 'qwen3-vl-4b',
    tag: 'qwen3-vl:4b',
    name: 'Qwen3-VL 4B',
    description: 'Multimodal vision + code, 256K context, fits 6GB VRAM',
    sizeGb: 3.3,
    recommended: true,
  },
  {
    id: 'qwen3-vl-8b',
    tag: 'qwen3-vl:8b',
    name: 'Qwen3-VL 8B',
    description: 'Higher quality variant, needs ~10GB VRAM',
    sizeGb: 6.1,
  },
  {
    id: 'llama3.2-vision-11b',
    tag: 'llama3.2-vision:11b',
    name: 'Llama 3.2 Vision 11B',
    description: 'Meta vision model, strong image understanding',
    sizeGb: 7.0,
  },
];

export function findModelByTag(tag: string): BuiltinModel | undefined {
  return BUILTIN_MODELS.find((m) => m.tag === tag);
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npm test -- ai-models
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-models.ts src/lib/__tests__/ai-models.test.ts
git commit -m "feat(ai): add pre-defined model registry"
```

---

### Task 3: Ollama HTTP client (`src/lib/ollama.ts`)

**Files:**
- Create: `src/lib/ollama.ts`
- Test: `src/lib/__tests__/ollama.test.ts`

- [ ] **Step 1: Write the failing tests** (mock fetch)

```ts
// src/lib/__tests__/ollama.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ollama from '@/lib/ollama';

describe('ollama http client', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  describe('listInstalledModels', () => {
    it('returns model tags from /api/tags', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: 'qwen3-vl:4b' }, { name: 'mistral:7b' }],
          }),
          { status: 200 },
        ),
      );
      const tags = await ollama.listInstalledModels();
      expect(tags).toEqual(['qwen3-vl:4b', 'mistral:7b']);
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
    });

    it('returns empty array on connection refused', async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('fetch failed'));
      const tags = await ollama.listInstalledModels();
      expect(tags).toEqual([]);
    });
  });

  describe('deleteModel', () => {
    it('sends DELETE /api/delete with tag', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response('', { status: 200 }));
      await ollama.deleteModel('qwen3-vl:4b');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/delete',
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ name: 'qwen3-vl:4b' }),
        }),
      );
    });

    it('throws on non-200 response', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response('not found', { status: 404 }));
      await expect(ollama.deleteModel('missing')).rejects.toThrow();
    });
  });

  describe('generate', () => {
    it('returns the response field from JSON', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({ response: 'Hello there', done: true }),
          { status: 200 },
        ),
      );
      const out = await ollama.generate('qwen3-vl:4b', 'hi');
      expect(out).toBe('Hello there');
    });

    it('throws on HTTP error', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response('boom', { status: 500 }),
      );
      await expect(ollama.generate('m', 'p')).rejects.toThrow();
    });
  });

  describe('pullModel', () => {
    it('parses NDJSON stream and calls onProgress for each event', async () => {
      const ndjson =
        '{"status":"pulling manifest"}\n' +
        '{"status":"downloading","digest":"sha:1","total":1000,"completed":500}\n' +
        '{"status":"success"}\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson));
          controller.close();
        },
      });
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(stream, { status: 200 }),
      );

      const events: any[] = [];
      await ollama.pullModel('qwen3-vl:4b', (p) => events.push(p));

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].status).toBe('pulling manifest');
      const downloading = events.find((e) => e.status === 'downloading');
      expect(downloading?.percent).toBe(50);
    });
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
npm test -- ollama
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/ollama.ts`**

```ts
const OLLAMA_BASE = 'http://localhost:11434';

export interface PullProgressEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent: number;
}

export async function listInstalledModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function deleteModel(tag: string): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tag }),
  });
  if (!res.ok) {
    throw new Error(`delete failed: HTTP ${res.status}`);
  }
}

export async function generate(model: string, prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) {
    throw new Error(`generate failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { response: string };
  return json.response;
}

export async function pullModel(
  tag: string,
  onProgress: (event: PullProgressEvent) => void,
): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: tag, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`pull failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // NDJSON: split on newlines, keep incomplete trailing piece in buffer
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const total = typeof parsed.total === 'number' ? parsed.total : 0;
        const completed = typeof parsed.completed === 'number' ? parsed.completed : 0;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        onProgress({ ...parsed, percent });
        if (parsed.error) {
          throw new Error(parsed.error);
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // skip malformed lines
        throw e;
      }
    }
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test -- ollama
```
Expected: PASS (all 5+ tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ollama.ts src/lib/__tests__/ollama.test.ts
git commit -m "feat(ai): add Ollama HTTP client with NDJSON pull stream"
```

---

### Task 4: Rust install commands

**Files:**
- Create: `src-tauri/src/ollama_install.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `src-tauri/src/ollama_install.rs`**

```rust
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::sleep;

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

const OLLAMA_TAGS_URL: &str = "http://localhost:11434/api/tags";

#[tauri::command]
pub async fn ollama_check_running() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    match client.get(OLLAMA_TAGS_URL).send().await {
        Ok(res) => Ok(res.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn ollama_download_installer(
    url: String,
    dest_path: String,
    app: AppHandle,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP {} from {}", res.status(), url));
    }

    let total = res.content_length().unwrap_or(0);
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir failed: {e}"))?;
    }

    let mut file = File::create(&dest)
        .await
        .map_err(|e| format!("create file failed: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "ollama-download-progress",
            DownloadProgress { downloaded, total },
        );
    }

    file.flush().await.ok();
    Ok(dest_path)
}

#[tauri::command]
pub async fn ollama_run_installer(path: String) -> Result<i32, String> {
    // Try silent flags in order of preference
    for flag in &["/SILENT", "/S"] {
        let result = Command::new(&path)
            .arg(flag)
            .spawn()
            .map_err(|e| format!("spawn failed for {flag}: {e}"))?
            .wait()
            .await
            .map_err(|e| format!("wait failed for {flag}: {e}"))?;

        if result.success() {
            return Ok(result.code().unwrap_or(0));
        }
    }
    Err("installer failed with both /SILENT and /S".to_string())
}

#[tauri::command]
pub async fn ollama_start_service() -> Result<(), String> {
    // Spawn `ollama serve` detached so it survives the app exit.
    // On Windows, the `ollama` binary is in PATH after install.
    Command::new("ollama")
        .arg("serve")
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    // Give it a moment to bind the port
    sleep(Duration::from_millis(500)).await;
    Ok(())
}
```

- [ ] **Step 2: Add `futures-util` to Cargo.toml** (needed for `bytes_stream`)

```toml
# Add under [dependencies]
futures-util = "0.3"
```

- [ ] **Step 3: Wire module into `src-tauri/src/lib.rs`**

Add at the top:
```rust
mod ollama_install;
```

Add to the `tauri::generate_handler![...]` array (the existing list of `create_pty, write_pty, ...`):
```rust
ollama_install::ollama_check_running,
ollama_install::ollama_download_installer,
ollama_install::ollama_run_installer,
ollama_install::ollama_start_service,
```

- [ ] **Step 4: Build the Rust side to verify it compiles**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo check 2>&1
```
Expected: clean check (warnings OK).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/ollama_install.rs src-tauri/src/lib.rs
git commit -m "feat(ai): add Rust commands for Ollama install lifecycle"
```

---

### Task 5: AI store (`src/stores/ai-store.ts`)

**Files:**
- Create: `src/stores/ai-store.ts`
- Test: `src/stores/__tests__/ai-store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/stores/__tests__/ai-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ollama', () => ({
  listInstalledModels: vi.fn(),
  deleteModel: vi.fn(),
  generate: vi.fn(),
  pullModel: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { useAiStore } from '@/stores/ai-store';
import * as ollama from '@/lib/ollama';
import { invoke } from '@tauri-apps/api/core';

beforeEach(() => {
  // reset store
  useAiStore.setState({
    ollamaStatus: 'unknown',
    installedModels: [],
    activeModelTag: null,
    pulling: {},
    installingOllama: null,
  });
  vi.clearAllMocks();
  localStorage.clear();
});

describe('aiStore', () => {
  it('refreshStatus sets running when invoke returns true', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await useAiStore.getState().refreshStatus();
    expect(useAiStore.getState().ollamaStatus).toBe('running');
  });

  it('refreshStatus sets not-installed when invoke returns false', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(false);
    await useAiStore.getState().refreshStatus();
    // not-installed vs stopped is heuristic; for unknown env we land on not-installed
    expect(useAiStore.getState().ollamaStatus).toBe('not-installed');
  });

  it('refreshInstalledModels clears active model if tag was removed', async () => {
    useAiStore.setState({ activeModelTag: 'gone:1', installedModels: [] });
    vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce(['qwen3-vl:4b']);
    await useAiStore.getState().refreshInstalledModels();
    const s = useAiStore.getState();
    expect(s.installedModels).toEqual(['qwen3-vl:4b']);
    expect(s.activeModelTag).toBeNull();
  });

  it('refreshInstalledModels keeps active model if still present', async () => {
    useAiStore.setState({ activeModelTag: 'qwen3-vl:4b' });
    vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce(['qwen3-vl:4b']);
    await useAiStore.getState().refreshInstalledModels();
    expect(useAiStore.getState().activeModelTag).toBe('qwen3-vl:4b');
  });

  it('setActiveModel persists to localStorage', () => {
    useAiStore.getState().setActiveModel('qwen3-vl:4b');
    expect(useAiStore.getState().activeModelTag).toBe('qwen3-vl:4b');
    expect(localStorage.getItem('notter-ai:provider-state')).toContain('qwen3-vl:4b');
  });

  it('initialize loads activeModelTag from localStorage', async () => {
    localStorage.setItem('notter-ai:provider-state', JSON.stringify({ activeModelTag: 'persisted:1' }));
    vi.mocked(invoke).mockResolvedValueOnce(false);
    vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce([]);
    await useAiStore.getState().initialize();
    expect(useAiStore.getState().activeModelTag).toBe('persisted:1');
  });

  it('pullModel rejects when another pull is in progress', async () => {
    useAiStore.setState({ pulling: { 'other:1': { status: 'downloading', layerLabel: null, percent: 50 } } });
    await expect(useAiStore.getState().pullModel('qwen3-vl:4b')).rejects.toThrow();
  });

  it('pullModel sets and clears pulling state on success', async () => {
    vi.mocked(ollama.pullModel).mockImplementationOnce(async (_tag, onProgress) => {
      onProgress({ status: 'pulling manifest', percent: 0 });
      onProgress({ status: 'success', percent: 100 });
    });
    vi.mocked(ollama.listInstalledModels).mockResolvedValueOnce(['qwen3-vl:4b']);
    await useAiStore.getState().pullModel('qwen3-vl:4b');
    expect(useAiStore.getState().pulling).toEqual({});
    expect(useAiStore.getState().installedModels).toContain('qwen3-vl:4b');
  });

  it('pullModel clears pulling and surfaces error on failure', async () => {
    vi.mocked(ollama.pullModel).mockRejectedValueOnce(new Error('boom'));
    await expect(useAiStore.getState().pullModel('qwen3-vl:4b')).rejects.toThrow('boom');
    expect(useAiStore.getState().pulling).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
npm test -- ai-store
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/stores/ai-store.ts`**

```ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import * as ollama from '@/lib/ollama';

const STORAGE_KEY = 'notter-ai:provider-state';

export type OllamaStatus = 'unknown' | 'not-installed' | 'stopped' | 'running';

export interface PullProgress {
  status: string;
  layerLabel: string | null;
  percent: number;
}

interface InstallingOllamaState {
  downloaded: number;
  total: number;
}

interface AiState {
  ollamaStatus: OllamaStatus;
  installedModels: string[];
  activeModelTag: string | null;
  pulling: Record<string, PullProgress>;
  installingOllama: InstallingOllamaState | null;

  initialize(): Promise<void>;
  refreshStatus(): Promise<void>;
  refreshInstalledModels(): Promise<void>;
  installOllama(): Promise<void>;
  startOllamaService(): Promise<void>;
  pullModel(tag: string): Promise<void>;
  removeModel(tag: string): Promise<void>;
  setActiveModel(tag: string): void;
}

function loadPersisted(): { activeModelTag: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { activeModelTag: null };
    const parsed = JSON.parse(raw);
    return { activeModelTag: parsed.activeModelTag ?? null };
  } catch {
    return { activeModelTag: null };
  }
}

function persist(state: { activeModelTag: string | null }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  ollamaStatus: 'unknown',
  installedModels: [],
  activeModelTag: null,
  pulling: {},
  installingOllama: null,

  async initialize() {
    const { activeModelTag } = loadPersisted();
    set({ activeModelTag });
    await get().refreshStatus();
    if (get().ollamaStatus === 'running') {
      await get().refreshInstalledModels();
    }
  },

  async refreshStatus() {
    try {
      const running = await invoke<boolean>('ollama_check_running');
      set({ ollamaStatus: running ? 'running' : 'not-installed' });
    } catch {
      set({ ollamaStatus: 'not-installed' });
    }
  },

  async refreshInstalledModels() {
    const tags = await ollama.listInstalledModels();
    const { activeModelTag } = get();
    const next: Partial<AiState> = { installedModels: tags };
    if (activeModelTag && !tags.includes(activeModelTag)) {
      next.activeModelTag = null;
      persist({ activeModelTag: null });
    }
    set(next);
  },

  async installOllama() {
    set({ installingOllama: { downloaded: 0, total: 0 } });
    try {
      // Listen to download progress events
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<{ downloaded: number; total: number }>(
        'ollama-download-progress',
        (e) => {
          set({ installingOllama: e.payload });
        },
      );

      const url = 'https://ollama.com/download/OllamaSetup.exe';
      const dest = await pickInstallerPath();

      try {
        await invoke('ollama_download_installer', { url, destPath: dest });
        set({ installingOllama: null });
        await invoke('ollama_run_installer', { path: dest });

        // Poll for service up to 60s
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const running = await invoke<boolean>('ollama_check_running');
          if (running) {
            set({ ollamaStatus: 'running' });
            await get().refreshInstalledModels();
            return;
          }
        }
        throw new Error('service did not start within 60s');
      } finally {
        unlisten();
      }
    } catch (e) {
      set({ installingOllama: null });
      throw e;
    }
  },

  async startOllamaService() {
    await invoke('ollama_start_service');
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const running = await invoke<boolean>('ollama_check_running');
      if (running) {
        set({ ollamaStatus: 'running' });
        await get().refreshInstalledModels();
        return;
      }
    }
    throw new Error('service did not start within 15s');
  },

  async pullModel(tag: string) {
    const { pulling } = get();
    if (Object.keys(pulling).length > 0) {
      throw new Error('Another model is currently being pulled');
    }
    set({
      pulling: {
        ...pulling,
        [tag]: { status: 'pulling manifest', layerLabel: null, percent: 0 },
      },
    });

    try {
      await ollama.pullModel(tag, (event) => {
        set((s) => ({
          pulling: {
            ...s.pulling,
            [tag]: {
              status: event.status,
              layerLabel: event.digest ? `layer ${event.digest.slice(7, 13)}` : null,
              percent: event.percent,
            },
          },
        }));
      });
      set((s) => {
        const next = { ...s.pulling };
        delete next[tag];
        return { pulling: next };
      });
      await get().refreshInstalledModels();
    } catch (e) {
      set((s) => {
        const next = { ...s.pulling };
        delete next[tag];
        return { pulling: next };
      });
      throw e;
    }
  },

  async removeModel(tag: string) {
    await ollama.deleteModel(tag);
    await get().refreshInstalledModels();
  },

  setActiveModel(tag: string) {
    set({ activeModelTag: tag });
    persist({ activeModelTag: tag });
  },
}));

async function pickInstallerPath(): Promise<string> {
  // Lazy import to avoid breaking unit tests
  const { appLocalDataDir } = await import('@tauri-apps/api/path');
  const dir = await appLocalDataDir();
  return `${dir}OllamaSetup.exe`;
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test -- ai-store
```
Expected: PASS (8+ tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/ai-store.ts src/stores/__tests__/ai-store.test.ts
git commit -m "feat(ai): add AI provider zustand store"
```

---

### Task 6: i18n keys

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/pt-BR.json`

- [ ] **Step 1: Add `manage_ai` block + `user_menu.manage_ai` key to both files**

Reference the i18n table in the spec for the exact keys. After this step, both JSON files have all 30+ entries under `manage_ai.*` and a new `user_menu.manage_ai` entry.

- [ ] **Step 2: Verify TypeScript build still passes**

```bash
npm run build
```
Expected: success (or only the existing chunk-size warning).

- [ ] **Step 3: Commit**

```bash
git add src/i18n/locales/en.json src/i18n/locales/pt-BR.json
git commit -m "i18n: add manage_ai keys for AI Provider Center"
```

---

### Task 7: ModelCard component

**Files:**
- Create: `src/components/ai/ModelCard.tsx`

- [ ] **Step 1: Implement the component**

```tsx
import { useTranslation } from 'react-i18next';
import { Check, Download, Loader2, Trash2 } from 'lucide-react';
import type { BuiltinModel } from '@/lib/ai-models';
import { useAiStore, type PullProgress } from '@/stores/ai-store';

interface ModelCardProps {
  model: BuiltinModel;
}

export function ModelCard({ model }: ModelCardProps) {
  const { t } = useTranslation();
  const installed = useAiStore((s) => s.installedModels.includes(model.tag));
  const isActive = useAiStore((s) => s.activeModelTag === model.tag);
  const progress = useAiStore((s) => s.pulling[model.tag]);
  const anyPulling = useAiStore((s) => Object.keys(s.pulling).length > 0);
  const pullModel = useAiStore((s) => s.pullModel);
  const removeModel = useAiStore((s) => s.removeModel);
  const setActiveModel = useAiStore((s) => s.setActiveModel);

  function handleInstall() {
    pullModel(model.tag).catch((e) => console.error('pull failed', e));
  }
  function handleRemove() {
    if (!confirm(t('manage_ai.remove_confirm', { name: model.name, size: `${model.sizeGb} GB` }))) {
      return;
    }
    removeModel(model.tag).catch((e) => console.error('remove failed', e));
  }

  return (
    <div className="rounded-md border border-border p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground truncate">{model.name}</h4>
            {model.recommended && (
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                ★
              </span>
            )}
            {isActive && (
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                {t('manage_ai.default_badge')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{model.description}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{model.sizeGb} GB</p>
        </div>
      </div>

      {progress ? (
        <ProgressView progress={progress} />
      ) : installed ? (
        <div className="flex items-center gap-2">
          {!isActive && (
            <button
              onClick={() => setActiveModel(model.tag)}
              className="flex-1 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('manage_ai.set_default')}
            </button>
          )}
          {isActive && (
            <span className="flex-1 inline-flex items-center justify-center gap-1 h-8 text-xs text-emerald-600 dark:text-emerald-400">
              <Check size={14} /> {t('manage_ai.default_badge')}
            </span>
          )}
          <button
            onClick={handleRemove}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={t('manage_ai.remove')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : (
        <button
          onClick={handleInstall}
          disabled={anyPulling}
          className="h-8 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download size={14} /> {t('manage_ai.install')}
        </button>
      )}
    </div>
  );
}

function ProgressView({ progress }: { progress: PullProgress }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        <span className="truncate">
          {progress.status} {progress.percent > 0 && `· ${progress.percent}%`}
        </span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/components/ai/ModelCard.tsx
git commit -m "feat(ai): add ModelCard component"
```

---

### Task 8: TestConnection component

**Files:**
- Create: `src/components/ai/TestConnection.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Loader2 } from 'lucide-react';
import { useAiStore } from '@/stores/ai-store';
import { generate } from '@/lib/ollama';

type State = 'idle' | 'generating' | 'loading-model' | 'received' | 'error';

export function TestConnection() {
  const { t } = useTranslation();
  const activeTag = useAiStore((s) => s.activeModelTag);
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [state, setState] = useState<State>('idle');

  const disabled = !activeTag;

  async function handleSend() {
    if (!activeTag || !prompt.trim()) return;
    setState('generating');
    setResponse('');

    const slowTimer = setTimeout(() => {
      setState((s) => (s === 'generating' ? 'loading-model' : s));
    }, 3000);

    const timeoutTimer = setTimeout(() => {
      setState('error');
      setResponse(t('manage_ai.error_pull', { error: 'timeout (90s)' }));
    }, 90000);

    try {
      const out = await generate(activeTag, prompt);
      setResponse(out);
      setState('received');
    } catch (e) {
      setResponse((e as Error).message);
      setState('error');
    } finally {
      clearTimeout(slowTimer);
      clearTimeout(timeoutTimer);
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t('manage_ai.test_title')}</h3>
      {disabled ? (
        <p className="text-xs text-muted-foreground italic">{t('manage_ai.test_no_default')}</p>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend();
              }}
              placeholder={t('manage_ai.test_placeholder')}
              disabled={state === 'generating' || state === 'loading-model'}
              className="flex-1 h-8 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!prompt.trim() || state === 'generating' || state === 'loading-model'}
              className="h-8 w-8 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {state === 'generating' || state === 'loading-model' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
            </button>
          </div>
          {state === 'loading-model' && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('manage_ai.test_loading_model')}
            </p>
          )}
          {state === 'generating' && (
            <p className="text-xs text-muted-foreground">{t('manage_ai.test_generating')}</p>
          )}
          {(state === 'received' || state === 'error') && response && (
            <div
              className={`rounded-md border p-2 text-xs whitespace-pre-wrap max-h-48 overflow-auto ${
                state === 'error' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-muted/30'
              }`}
            >
              {response}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build + commit**

```bash
npm run build
git add src/components/ai/TestConnection.tsx
git commit -m "feat(ai): add TestConnection component with loading-model UX"
```

---

### Task 9: OllamaPanel component

**Files:**
- Create: `src/components/ai/OllamaPanel.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useTranslation } from 'react-i18next';
import { Download, Play, AlertCircle } from 'lucide-react';
import { useAiStore } from '@/stores/ai-store';
import { BUILTIN_MODELS } from '@/lib/ai-models';
import { ModelCard } from './ModelCard';
import { TestConnection } from './TestConnection';

export function OllamaPanel() {
  const { t } = useTranslation();
  const status = useAiStore((s) => s.ollamaStatus);
  const installingOllama = useAiStore((s) => s.installingOllama);
  const installOllama = useAiStore((s) => s.installOllama);
  const startOllamaService = useAiStore((s) => s.startOllamaService);

  function statusLabel() {
    switch (status) {
      case 'unknown': return t('manage_ai.status_unknown');
      case 'not-installed': return t('manage_ai.status_not_installed');
      case 'stopped': return t('manage_ai.status_stopped');
      case 'running': return t('manage_ai.status_running');
    }
  }

  function statusDotClass() {
    switch (status) {
      case 'running': return 'bg-emerald-500';
      case 'stopped': return 'bg-amber-500';
      case 'not-installed': return 'bg-zinc-400';
      default: return 'bg-zinc-300';
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <h2 className="text-base font-semibold">Ollama</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`w-2 h-2 rounded-full ${statusDotClass()}`} />
          {statusLabel()}
        </span>
        <div className="flex-1" />
        {status === 'not-installed' && (
          <button
            onClick={() => installOllama().catch((e) => console.error(e))}
            disabled={!!installingOllama}
            className="flex items-center gap-1.5 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Download size={14} /> {t('manage_ai.install_ollama')}
          </button>
        )}
        {status === 'stopped' && (
          <button
            onClick={() => startOllamaService().catch((e) => console.error(e))}
            className="flex items-center gap-1.5 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Play size={14} /> {t('manage_ai.start_ollama')}
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {installingOllama && (
          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              {installingOllama.total > 0
                ? t('manage_ai.downloading', {
                    downloaded: formatBytes(installingOllama.downloaded),
                    total: formatBytes(installingOllama.total),
                  })
                : t('manage_ai.installing_ollama')}
            </p>
            {installingOllama.total > 0 && (
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${(installingOllama.downloaded / installingOllama.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}

        {status === 'not-installed' && !installingOllama && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2">
            <AlertCircle size={14} className="text-amber-600 dark:text-amber-400 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              Ollama is not installed. Click "Install Ollama" above to download and install it
              automatically. The installer runs silently — no popup windows.
            </p>
          </div>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('manage_ai.models')}</h3>
          <div className="space-y-2">
            {BUILTIN_MODELS.map((m) => (
              <ModelCard key={m.id} model={m} />
            ))}
          </div>
        </section>

        <TestConnection />
      </div>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/components/ai/OllamaPanel.tsx
git commit -m "feat(ai): add OllamaPanel with status header and install flow"
```

---

### Task 10: ManageAiDialog (top-level)

**Files:**
- Create: `src/components/ai/ManageAiDialog.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAiStore } from '@/stores/ai-store';
import { OllamaPanel } from './OllamaPanel';

interface ManageAiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ManageAiDialog({ open, onOpenChange }: ManageAiDialogProps) {
  const { t } = useTranslation();
  const status = useAiStore((s) => s.ollamaStatus);
  const refreshStatus = useAiStore((s) => s.refreshStatus);
  const refreshInstalledModels = useAiStore((s) => s.refreshInstalledModels);

  useEffect(() => {
    if (open) {
      refreshStatus().then(() => {
        if (useAiStore.getState().ollamaStatus === 'running') {
          refreshInstalledModels();
        }
      });
    }
  }, [open, refreshStatus, refreshInstalledModels]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle>{t('manage_ai.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex h-[600px]">
          {/* Provider list (Phase 1: Ollama only) */}
          <div className="w-48 border-r border-border bg-muted/30 p-2">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              {t('manage_ai.providers')}
            </div>
            <button className="w-full text-left px-2 py-1.5 rounded-md bg-accent text-sm font-medium flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  status === 'running'
                    ? 'bg-emerald-500'
                    : status === 'stopped'
                    ? 'bg-amber-500'
                    : 'bg-zinc-400'
                }`}
              />
              Ollama
            </button>
          </div>

          {/* Provider detail */}
          <div className="flex-1 min-w-0">
            <OllamaPanel />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/components/ai/ManageAiDialog.tsx
git commit -m "feat(ai): add ManageAiDialog top-level layout"
```

---

### Task 11: UserMenu integration

**Files:**
- Modify: `src/components/UserMenu.tsx`

- [ ] **Step 1: Add state, import, menu button, and dialog render**

Edit `UserMenu.tsx`:

1. Add to imports:
   ```ts
   import { Brain } from 'lucide-react';
   import { ManageAiDialog } from '@/components/ai/ManageAiDialog';
   ```

2. Add state below other dialog states:
   ```ts
   const [manageAiOpen, setManageAiOpen] = useState(false);
   ```

3. Add handler:
   ```ts
   const openManageAi = () => {
     setOpen(false);
     setManageAiOpen(true);
   };
   ```

4. Add button in the menu, between Settings and Plugins:
   ```tsx
   <button onClick={openManageAi} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
     <Brain size={14} />
     {t('user_menu.manage_ai')}
   </button>
   ```

5. Render the dialog after the AuthDialog:
   ```tsx
   <ManageAiDialog open={manageAiOpen} onOpenChange={setManageAiOpen} />
   ```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/components/UserMenu.tsx
git commit -m "feat(ai): wire ManageAiDialog into UserMenu"
```

---

### Task 12: App.tsx initialization

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Call ai-store initialize on boot**

Edit App.tsx:
1. Add import: `import { useAiStore } from '@/stores/ai-store';`
2. In the `useEffect`, after `initialize()`, call:
   ```ts
   useAiStore.getState().initialize().catch(console.error);
   ```

- [ ] **Step 2: Build + commit**

```bash
npm run build
git add src/App.tsx
git commit -m "feat(ai): initialize AI provider store on app boot"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run all tests**

```bash
npm test
```
Expected: all pass.

- [ ] **Step 2: Type-check the full project**

```bash
npm run build
```
Expected: success.

- [ ] **Step 3: Build Tauri release with signing**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/notter-ai.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```
Expected: NSIS + MSI bundles produced, signatures emitted.

- [ ] **Step 4: Final commit if needed**

If any minor fixes were needed during the verification step, commit them.

---

## Spec coverage check

| Spec section | Implementing task |
|---|---|
| Entry point (UserMenu item) | Task 11 |
| Two-panel layout | Task 10 |
| Ollama status badge + install button | Task 9 |
| Start Ollama flow | Task 9 (button) + Task 5 (store action) |
| Pre-defined models registry | Task 2 |
| Model card with install/default/remove | Task 7 |
| Pull flow with NDJSON streaming | Task 3 (client) + Task 5 (store wrapping) |
| Test connection with loading-model UX | Task 8 |
| Rust commands for download/install/start/check | Task 4 |
| AI store with persistence + validation | Task 5 |
| i18n keys | Task 6 |
| Initialize on app boot | Task 12 |
| Tests for HTTP client + store | Tasks 3, 5 |
| Build verification | Task 13 |
