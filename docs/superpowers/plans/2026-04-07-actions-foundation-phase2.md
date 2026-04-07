# Actions Foundation — Phase 2 Implementation Plan

**Goal:** Scaffold the Actions tab (data model + store + UI) without any AI wiring.

**Architecture:** New `actions-store` Zustand store with JSON file persistence in `$APPLOCALDATA/notter-ai/actions.json`. Four new React components under `src/components/actions/`. Integrate via Layout + App.tsx.

**Tech Stack:** Zustand + tauri-plugin-fs + react-i18next + react-markdown (already present) + Vitest

## Tasks

### Task 1: Types (`src/types/actions.ts`)
Create the exported types: `ActionStatus`, `ActionTaskStatus`, `ActionTask`, `Action`.

### Task 2: Store (`src/stores/actions-store.ts`) + tests
- Load from JSON file on boot (with error handling + backup of corrupted file)
- Debounced write on every mutation (300ms)
- `addAction`, `updateAction`, `deleteAction`, `setSelected`, `updateTask`, `cycleTaskStatus`
- `getProgress` selector
- Unit tests with mocked `@tauri-apps/plugin-fs`

### Task 3: i18n
Add `actions.*` keys + `nav.actions` to both `en.json` and `pt-BR.json`.

### Task 4: TaskItem component
Single collapsible task card with status dot (cycles on click), objective, and expandable details (prompt, return, metadata).

### Task 5: ActionDetail component
Right column of the layout. Header (title + status + delete), context (markdown), tasks section.

### Task 6: ActionCard + ActionList components
Left column of the layout. Search input, counter, scrollable list.

### Task 7: ActionsTab top-level component
Combines ActionList + ActionDetail with resizable panels. Handles empty state.

### Task 8: Layout integration
Add `actions` to `Tab` type, add tab entry in dev TABS, add to App.tsx children.

### Task 9: App boot
Call `useActionsStore.getState().load()` in `App.tsx`.

### Task 10: Verify
Run all tests, build, verify empty state shows, inject test action via devtools.

## Spec coverage

| Spec section | Task |
|---|---|
| Types | Task 1 |
| Store + persistence | Task 2 |
| Empty state | Task 7 |
| Action list with search + counter | Task 6 |
| Detail panel with header/context/tasks | Task 5 |
| Task status cycling | Task 4 |
| Delete action flow | Task 5 |
| Tab entry in navbar (dev only) | Task 8 |
| App boot load | Task 9 |
| i18n keys | Task 3 |
| Unit tests | Task 2 |
