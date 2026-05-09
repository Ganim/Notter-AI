# Feature: ai-providers

## Summary

Multi-provider LLM layer that lets the app speak to a local **Ollama** runtime
or to one of five cloud providers (**Anthropic Claude**, **Groq**,
**Google Gemini**, **OpenAI**, **DeepSeek**). The UI surface is the
`ManageAiDialog` (sidebar of providers + a per-provider panel). State —
including API keys, selected model per cloud provider, the currently active
provider, and the active local Ollama model tag — lives in a Zustand store
(`useAiStore`) that is **persisted as plain JSON in `localStorage`** under the
key `notter-ai:provider-state`. There is **no Tauri secure store and no
Supabase storage** for keys today; the in-memory store is the source of truth
and `localStorage` is the disk.

Two dispatch paths exist:

1. **Cloud path** — `generateText` → `generateCloud` (`src/lib/ai-providers.ts`)
   builds a provider-specific URL/headers/body and hands a single
   `LlmRequestPayload` to the Tauri command `llm_request`
   (`src-tauri/src/lib.rs:202`), which proxies the HTTP call via `reqwest`
   from the Rust side (this is what avoids webview CORS).
2. **Local path** — `generateText` → `generate` (`src/lib/ollama.ts:33`)
   `fetch`es `http://localhost:11434/api/generate` directly from the webview;
   no Rust hop.

The Ollama installer flow is its own branch: `installOllama` in the store
listens for `ollama-download-progress`, calls
`ollama_download_installer` then `ollama_run_installer`
(`src-tauri/src/ollama_install.rs:51` / `:102`), then polls
`ollama_check_running` for up to 60s.

External consumers of the active provider/model:
- `src/lib/callback-analyzer.ts` (agent-chat callback analyzer) — reads
  `useAiStore` selection at call site, calls `generateText`.
- `src/lib/action-processor.ts` (planning-pipeline action processor) — same
  pattern: store selection → `generateText`.

## Mermaid

```mermaid
flowchart TD
    User([User opens AI settings])

    subgraph UI[React UI]
        Dialog["ManageAiDialog<br/>src/components/ai/ManageAiDialog.tsx:15"]
        OllamaPanel["OllamaPanel<br/>src/components/ai/OllamaPanel.tsx:8"]
        CloudPanel["CloudProviderPanel<br/>src/components/ai/CloudProviderPanel.tsx:11"]
        TestConn["TestConnection<br/>src/components/ai/TestConnection.tsx:9"]
        ModelCard["ModelCard (per Ollama tag)<br/>src/components/ai/ModelCard.tsx:11"]
    end

    subgraph Store[Zustand store + persistence]
        AiStore["useAiStore (state + actions)<br/>src/stores/ai-store.ts:94"]
        LoadPersist["loadPersisted / persist<br/>src/stores/ai-store.ts:66"]
        LocalStorage[("localStorage key:<br/>notter-ai:provider-state<br/>src/stores/ai-store.ts:9")]
        UpdateCfg["updateCloudConfig (apiKey/model)<br/>src/stores/ai-store.ts:278"]
        SetActive["setActiveProvider / setActiveModel<br/>src/stores/ai-store.ts:266-276"]
    end

    subgraph Dispatch[Provider dispatch]
        GenText["generateText (provider router)<br/>src/lib/ai-client.ts:11"]
        GenCloud["generateCloud (switch on providerId)<br/>src/lib/ai-providers.ts:63"]
        Decision{{"providerId switch<br/>src/lib/ai-providers.ts:73"}}
        ClaudeBranch["Claude branch (x-api-key)<br/>src/lib/ai-providers.ts:96"]
        GeminiBranch["Gemini branch (?key= in URL)<br/>src/lib/ai-providers.ts:74"]
        OpenAiCompat["Groq | OpenAI | DeepSeek<br/>(Bearer, OpenAI-compatible)<br/>src/lib/ai-providers.ts:121"]
        OllamaGen["Ollama generate (direct fetch)<br/>src/lib/ollama.ts:33"]
    end

    subgraph Tauri[Tauri (Rust) backend]
        LlmReq["llm_request command<br/>(reqwest HTTP proxy)<br/>src-tauri/src/lib.rs:202"]
        OllamaCheckRunning["ollama_check_running (GET /api/tags)<br/>src-tauri/src/ollama_install.rs:21"]
        OllamaCheckInstalled["ollama_check_installed (where/which)<br/>src-tauri/src/ollama_install.rs:34"]
        OllamaDownload["ollama_download_installer + emit progress<br/>src-tauri/src/ollama_install.rs:51"]
        OllamaRun["ollama_run_installer (/SILENT, /S)<br/>src-tauri/src/ollama_install.rs:102"]
        OllamaStart["ollama_start_service (spawn 'ollama serve')<br/>src-tauri/src/ollama_install.rs:139"]
    end

    subgraph External[External providers]
        AnthropicAPI[(api.anthropic.com/v1/messages)]
        GeminiAPI[(generativelanguage.googleapis.com)]
        OpenAiAPI[(api.openai.com/v1/chat/completions)]
        GroqAPI[(api.groq.com/openai/v1/chat/completions)]
        DeepSeekAPI[(api.deepseek.com/v1/chat/completions)]
        OllamaLocal[("localhost:11434<br/>/api/generate · /api/tags · /api/pull")]
        OllamaCom[(ollama.com/download/OllamaSetup.exe)]
    end

    subgraph Consumers[External feature consumers]
        CallbackAn["callback-analyzer (agent-chat)<br/>src/lib/callback-analyzer.ts:103"]
        ActionProc["action-processor (planning-pipeline)<br/>src/lib/action-processor.ts:107"]
        PlannerTab["PlannerTab reads active provider<br/>src/components/PlannerTab.tsx:66"]
        TaskItem["TaskItem reads active provider<br/>src/components/actions/TaskItem.tsx:63"]
    end

    %% Initialization & UI wiring
    User --> Dialog
    Dialog -->|"useEffect refreshStatus"| AiStore
    AiStore --> LoadPersist
    LoadPersist <-->|read/write JSON| LocalStorage
    AiStore -->|"refreshStatus()"| OllamaCheckRunning
    AiStore -->|"if not running"| OllamaCheckInstalled
    Dialog -->|selectedProvider==='ollama'| OllamaPanel
    Dialog -->|cloud provider id| CloudPanel
    OllamaPanel --> ModelCard
    OllamaPanel --> TestConn
    CloudPanel --> TestConn

    %% Cloud config edits
    CloudPanel -->|"onChange apiKey/model"| UpdateCfg
    CloudPanel -->|"Set active"| SetActive
    UpdateCfg --> LocalStorage
    SetActive --> LocalStorage

    %% Ollama install branch
    OllamaPanel -->|"Install Ollama click"| AiStore
    AiStore -->|"installOllama()<br/>src/stores/ai-store.ts:161"| OllamaDownload
    OllamaDownload -->|emit ollama-download-progress| AiStore
    OllamaDownload --> OllamaCom
    AiStore -->|"after download"| OllamaRun
    AiStore -->|"poll up to 60s"| OllamaCheckRunning
    OllamaPanel -->|"Start service click"| OllamaStart
    ModelCard -->|"pullModel(tag)"| OllamaLocal
    ModelCard -->|"removeModel / setActive"| AiStore

    %% Test / generate happy path
    TestConn -->|"handleSend"| GenText
    Consumers --> GenText
    CallbackAn --> GenText
    ActionProc --> GenText
    PlannerTab -.reads.-> AiStore
    TaskItem -.reads.-> AiStore

    GenText -->|providerId === 'ollama'| OllamaGen
    GenText -->|cloud providerId| GenCloud
    GenCloud --> Decision
    Decision -->|claude| ClaudeBranch
    Decision -->|gemini| GeminiBranch
    Decision -->|groq/openai/deepseek| OpenAiCompat

    ClaudeBranch --> LlmReq
    GeminiBranch --> LlmReq
    OpenAiCompat --> LlmReq
    LlmReq --> AnthropicAPI
    LlmReq --> GeminiAPI
    LlmReq --> OpenAiAPI
    LlmReq --> GroqAPI
    LlmReq --> DeepSeekAPI

    OllamaGen --> OllamaLocal

    classDef store fill:#fef3c7,stroke:#b45309
    classDef rust fill:#fee2e2,stroke:#991b1b
    classDef ext fill:#e0e7ff,stroke:#3730a3
    class AiStore,LoadPersist,UpdateCfg,SetActive,LocalStorage store
    class LlmReq,OllamaCheckRunning,OllamaCheckInstalled,OllamaDownload,OllamaRun,OllamaStart rust
    class AnthropicAPI,GeminiAPI,OpenAiAPI,GroqAPI,DeepSeekAPI,OllamaLocal,OllamaCom ext
```

## Key paths

### Happy path (cloud) — Test Connection

1. User opens settings → `ManageAiDialog`
   (`src/components/ai/ManageAiDialog.tsx:15`); the `useEffect` block at line
   26 calls `refreshStatus()` then conditionally `refreshInstalledModels()`.
2. User picks a cloud provider in the sidebar; `CloudProviderPanel`
   (`src/components/ai/CloudProviderPanel.tsx:11`) renders.
3. User pastes API key and edits model; each keystroke calls
   `updateCloudConfig` (`src/stores/ai-store.ts:278`) which mutates the
   Zustand state and immediately writes the full persisted slice to
   `localStorage` via `persist()` (`src/stores/ai-store.ts:86`).
4. User clicks "Set active" → `setActiveProvider`
   (`src/stores/ai-store.ts:272`) updates state + persists.
5. User types a prompt in the embedded `TestConnection`
   (`src/components/ai/TestConnection.tsx:9`) and hits Send. `handleSend`
   (line 47) reads `cloudConfigs[activeProviderId]` and calls
   `generateText({ providerId, model, apiKey, prompt })`
   (`src/lib/ai-client.ts:11`).
6. `generateText` routes to `generateCloud`
   (`src/lib/ai-providers.ts:63`); the `switch (providerId)` at
   `src/lib/ai-providers.ts:73` picks one of three shapes:
   - **Claude**: `POST https://api.anthropic.com/v1/messages` with
     `x-api-key` and `anthropic-version: 2023-06-01`.
   - **Gemini**: `POST` to
     `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`,
     forces `responseMimeType: application/json`.
   - **Groq / OpenAI / DeepSeek**: OpenAI-compatible
     `/v1/chat/completions`, `Authorization: Bearer ${apiKey}`,
     `response_format: json_object`.
7. Each branch calls `llmRequest({ url, method, headers, body })`
   (`src/lib/ai-providers.ts:59`) → Tauri `invoke('llm_request', { payload })`
   → `llm_request` Rust command (`src-tauri/src/lib.rs:202`) which builds a
   `reqwest::Client`, applies headers, sends the request, and returns the
   raw response body string (or an `HTTP {status}: {text}` error).
8. The branch parses the provider-specific response shape (e.g. Claude
   `content[0].text`, Gemini `candidates[0].content.parts[0].text`, OpenAI-
   shape `choices[0].message.content`) and returns the text.

### Happy path (local) — Ollama generate

1. Same UI entry but `selectedProvider === 'ollama'` → `OllamaPanel`
   (`src/components/ai/OllamaPanel.tsx:8`).
2. `generateText` short-circuits the Rust proxy: it calls `generate` in
   `src/lib/ollama.ts:33`, which `fetch`es
   `http://localhost:11434/api/generate` directly from the webview with
   `{ model, prompt, stream: false }`.

### Ollama installer branch

1. `OllamaPanel` shows "Install Ollama" when `status === 'not-installed'`.
2. Click → `installOllama` (`src/stores/ai-store.ts:161`):
   - sets `installingOllama = { downloaded: 0, total: 0 }`,
   - subscribes to the Tauri event `ollama-download-progress` (emitted from
     Rust at `src-tauri/src/ollama_install.rs:91`),
   - resolves the destination via `appLocalDataDir()` +
     `OllamaSetup.exe` (`src/stores/ai-store.ts:289`),
   - calls `invoke('ollama_download_installer', …)` →
     `src-tauri/src/ollama_install.rs:51` (streams chunks to disk and emits
     progress per chunk),
   - calls `invoke('ollama_run_installer', …)` →
     `src-tauri/src/ollama_install.rs:102` (tries `/SILENT` first, then
     `/S`; accepts exit codes `0` and `3010`),
   - polls `ollama_check_running` once per second up to 60 times, then
     calls `refreshInstalledModels()` and exits.
3. "Start service" button (when `status === 'stopped'`) calls
   `startOllamaService` → `ollama_start_service`
   (`src-tauri/src/ollama_install.rs:139`) which spawns `ollama serve` and
   sleeps 500ms; the store then polls running for up to 15s.

### Model listing / pull / remove (all webview → localhost:11434)

- List: `listInstalledModels` `GET /api/tags`
  (`src/lib/ollama.ts:11`).
- Pull (streamed NDJSON, parsed line-by-line for progress):
  `pullModel` `POST /api/pull` (`src/lib/ollama.ts:46`), gated by
  `ai-store.pullModel` so only one tag pulls at a time
  (`src/stores/ai-store.ts:214`).
- Delete: `deleteModel` `DELETE /api/delete`
  (`src/lib/ollama.ts:22`).

## Side effects

- **Disk write (renderer)**: every change to API keys, model strings,
  active provider, or active Ollama tag rewrites the JSON blob at
  `localStorage['notter-ai:provider-state']` synchronously
  (`src/stores/ai-store.ts:86`). API keys are stored **in plaintext** in
  `localStorage`; there is no use of the OS keychain, Tauri secure store, or
  Supabase. (Note for future hardening.)
- **Disk write (backend)**: `ollama_download_installer` writes
  `OllamaSetup.exe` into `appLocalDataDir()` and `mkdir -p`s the parent
  (`src-tauri/src/ollama_install.rs:71`).
- **Process spawn**: `ollama_run_installer` spawns the downloaded
  installer with `/SILENT` then `/S`; `ollama_start_service` spawns
  `ollama serve` detached.
- **HTTP — Rust side**: every cloud LLM call goes through `reqwest` in
  `llm_request` (`src-tauri/src/lib.rs:202`), bypassing webview CORS.
- **HTTP — webview side**: all Ollama traffic
  (`/api/generate`, `/api/tags`, `/api/pull`, `/api/delete`) is plain
  `fetch` to `localhost:11434`.
- **Tauri events**: `ollama-download-progress` (Rust → renderer) drives
  the install progress bar.

## External dependencies

### Inbound (this feature is consumed by)

- **agent-chat**: `src/lib/callback-analyzer.ts:103` calls
  `generateText({ providerId, model, apiKey, prompt })`. Provider/model
  are read from `useAiStore` at the call site by the agent UI.
- **planning-pipeline**: `src/lib/action-processor.ts:107` calls
  `generateText` similarly. The PlannerTab
  (`src/components/PlannerTab.tsx:66`) and TaskItem
  (`src/components/actions/TaskItem.tsx:63`) read `activeProviderId`,
  `activeModelTag`, and `cloudConfigs` directly from `useAiStore`.

### Outbound (this feature depends on)

- **Tauri commands**: `llm_request`, `ollama_check_running`,
  `ollama_check_installed`, `ollama_download_installer`,
  `ollama_run_installer`, `ollama_start_service`
  (registered in `src-tauri/src/lib.rs:260`).
- **External HTTPS**: `api.anthropic.com`, `api.openai.com`,
  `api.groq.com`, `api.deepseek.com`,
  `generativelanguage.googleapis.com`, `ollama.com`.
- **Local HTTP**: `http://localhost:11434` (Ollama daemon).
- **Browser API**: `localStorage` for persistence;
  `@tauri-apps/api/path::appLocalDataDir` for installer destination;
  `@tauri-apps/api/event::listen` for download progress.
