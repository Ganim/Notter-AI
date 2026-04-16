# Notter AI — Technology Stack

> **Note:** This document was produced as a stack-decision artifact, but the project is **not greenfield**. The choices below reflect the stack already in place (verified via `package.json`, `src-tauri/`, `tailwind.config.js`, `vite.config.ts`, `supabase/`). Each entry records the chosen technology and the rationale for keeping it.

## 1. Frontend Framework — **React 19**
- **Package:** `react@^19.1.0`, `react-dom@^19.1.0`
- **Rationale:** Largest ecosystem for desktop-style UIs, first-class TypeScript support, and direct compatibility with the existing component library (`@base-ui/react`, `shadcn`, `lucide-react`). React 19's concurrent features fit Notter AI's streaming/async task UIs (executor, queue worker, terminal panes).

## 2. Build Tool — **Vite 7** (with TypeScript)
- **Package:** `vite@^7.0.4`, `@vitejs/plugin-react`, `typescript@~5.8.3`
- **Rationale:** Native ESM dev server with sub-second HMR, ideal for a Tauri front-end where the renderer is loaded as a local web app. Vite is the officially recommended bundler for Tauri 2 templates and is already wired into `vite.config.ts` and `tsconfig.json`. Vitest (`vitest@^4.1.3`) provides test runner parity with the bundler.

## 3. Styling — **Tailwind CSS 3 + shadcn/ui (Base UI primitives)**
- **Packages:** `tailwindcss@^3.4.19`, `@tailwindcss/typography`, `tailwindcss-animate`, `tw-animate-css`, `tailwind-merge`, `class-variance-authority`, `clsx`, `shadcn@^4.1.0`, `@base-ui/react`, `next-themes`
- **Rationale:** Utility-first styling keeps component CSS colocated and tree-shakable. shadcn provides copy-in primitives (already configured via `components.json`) so the design system stays under project control instead of being a versioned dependency. `next-themes` handles dark/light switching, and `tailwind-merge` + `cva` give predictable variant composition.

## 4. State Management — **Zustand**
- **Package:** `zustand@^5.0.12`
- **Rationale:** Minimal boilerplate compared to Redux, no React context overhead, supports slice-based stores (already used by the executor/actions store, e.g. `requeueExecution`, queue worker boot). Works cleanly with React 19 and integrates with persisted local state. i18n is handled separately by `i18next` + `react-i18next`.

## 5. Backend / BaaS — **Supabase**
- **Package:** `@supabase/supabase-js@^2.101.1`
- **Local assets:** `supabase/` directory (migrations, RLS policies), `.env` with project URL/anon key
- **Rationale:** Provides Postgres + Auth + Row Level Security + Realtime in a single managed service. Already wired for Notter AI authentication and data sync (see `project_alpha4_auth` memory). RLS policies exist and must be respected by any new feature work — no replacement is justified.

## 6. Desktop Shell — **Tauri 2**
- **Packages:** `@tauri-apps/api@^2`, `@tauri-apps/cli@^2`, plus official plugins: `plugin-deep-link`, `plugin-dialog`, `plugin-fs`, `plugin-opener`, `plugin-process`, `plugin-shell`, `plugin-updater`
- **Rust workspace:** `src-tauri/`
- **Rationale:** Significantly smaller binaries and lower memory footprint than Electron, native OS integration via Rust, and a fine-grained capability/permission system suited to a tool that spawns local processes (Claude CLI, terminal sessions via `xterm`). Auto-updater plugin already configured (`latest.json`, `RELEASE.md`).

---

## Summary Table

| Category            | Choice                      | Status     |
|---------------------|-----------------------------|------------|
| Frontend framework  | React 19                    | In use     |
| Build tool          | Vite 7 + TypeScript 5.8     | In use     |
| Styling             | Tailwind 3 + shadcn/Base UI | In use     |
| State management    | Zustand 5                   | In use     |
| Backend / BaaS      | Supabase                    | In use     |
| Desktop shell       | Tauri 2                     | In use     |

No scaffolding, dependency installation, or `package.json` mutation was performed by this task — documentation only.
