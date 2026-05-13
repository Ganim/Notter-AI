# Header Redesign — Custom Titlebar + User Menu

**Date:** 2026-05-13
**Scope:** Feature A (custom Tauri titlebar with native window controls disabled) + Feature B (user menu identity card + account-switcher submenu). Both ship together because the window controls live in the same row as the user menu trigger.
**Out of scope:** Settings dialog refactor (Feature C, separate spec). MCP/Plugins/Theme/Language menu items stay where they are; C will migrate them later.

---

## 1. Problem

Two cosmetic-but-load-bearing UX issues:

1. **Generic Windows titlebar**: the OS-drawn frame at the top wastes a row and clashes visually with the app's dark theme. Apps like Discord, VS Code, Microsoft Edge ship their own chrome and reclaim that strip.
2. **Cluttered user menu identity**: the dropdown currently shows three identity rows ("Logado como X" + the same email with a checkmark + "Adicionar conta" sandwich), an inline account list mixed with feature items, and a stale "Verificar atualizações" entry that nobody uses (the Tauri updater can auto-check).

The redesign collapses the chrome into a single row with custom window controls, and reshapes the user menu around an identity card + a Discord-style account-switcher submenu.

## 2. Architecture overview

```
┌────────────────────────────────────────────────────────────────────────┐
│ [tabs]                       [drag region]    [WSswitch][UserMenu][−][▢][×] │  ← single header row
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│                          (app content)                                 │
└────────────────────────────────────────────────────────────────────────┘
```

- The OS titlebar is gone (`decorations: false` in `tauri.conf.json`).
- The existing header row becomes the **drag region** by default, with interactive children opted out via `data-tauri-drag-region="false"`.
- New `<WindowControls>` component renders three buttons (Min, Max/Restore, Close) sitting flush to the right edge.
- `<UserMenu>` keeps its existing position immediately left of the controls.

## 3. Feature A — Custom titlebar

### 3.1 Tauri config

```jsonc
// src-tauri/tauri.conf.json (windows[0])
{
  "title": "Notter-AI",
  "decorations": false,
  // existing fields preserved
}
```

That single flag removes the native frame. **Scope: Windows only is the target use case** (the user develops on Win11; macOS/Linux are not actively tested). Setting `decorations: false` cross-platform is the simplest path — macOS will lose its traffic lights but the app still functions, and we can revisit when/if a macOS build happens.

### 3.2 Drag region

The existing header `<div>` in `Layout.tsx` gets `data-tauri-drag-region` on the OUTER container. Tauri's webview-level handler reads this and intercepts mousedown → drag the window. Interactive children (tabs, workspace switcher, user menu, window controls) get `data-tauri-drag-region="false"` to opt out.

Implementation guideline:
- Add the attribute on the `<div className="flex items-center justify-between ...">` that wraps everything in the header row.
- Add `data-tauri-drag-region="false"` on each `<button>`, the workspace switcher root, the UserMenu trigger, and each WindowControls button.
- Drag-region children inherit, so a single opt-out per interactive root is enough.

Double-click on the drag region toggles maximize (Tauri default behavior — no code needed).

### 3.3 `<WindowControls>` component

New file: `src/components/WindowControls.tsx`.

```tsx
import { useEffect, useState } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let mounted = true;
    win.isMaximized().then((v) => mounted && setMaximized(v));
    const unlisten = win.onResized(async () => {
      const v = await win.isMaximized();
      if (mounted) setMaximized(v);
    });
    return () => {
      mounted = false;
      unlisten.then((fn) => fn());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="flex items-center" data-tauri-drag-region="false">
      <button
        onClick={() => win.minimize()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
        title="Minimize"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        onClick={() => win.close()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-red-600 hover:text-white transition-colors"
        title="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
}
```

Notes:
- 44px wide × 32px tall buttons (Windows 11 convention; same as system buttons that we're replacing).
- Close button turns red on hover (`hover:bg-red-600 hover:text-white`) — Windows convention, also matches Discord.
- The Maximize icon flips to a "two stacked squares" (Copy icon from lucide) when maximized — visual hint that clicking restores.
- `onResized` listener keeps the icon in sync if the user maximizes via OS shortcut (Win+Up, snap, etc.).

### 3.4 Wiring into Layout

`src/components/Layout.tsx:46-49` becomes:

```tsx
<div className="flex items-center gap-1" data-tauri-drag-region="false">
  <WorkspaceSwitcher />
  <UserMenu />
  <WindowControls />
</div>
```

And the OUTER header container gets `data-tauri-drag-region` (no value = enabled). The tab buttons on the left side of the header also get `data-tauri-drag-region="false"` so they remain clickable.

## 4. Feature B — User menu redesign

### 4.1 Component shape

`UserMenu.tsx` keeps its current structure (a `useState` open flag + a portal-less absolute-positioned dropdown), but the dropdown CONTENT is reorganized.

State additions:
```ts
const [subView, setSubView] = useState<'main' | 'accounts'>('main');
```

When the menu closes, reset `subView` to `'main'` so reopening starts at the top.

### 4.2 Identity card (top of dropdown)

Replace the current `<div className="px-3 py-2 ...">` "Logado como" line with:

```tsx
<div className="flex items-center gap-3 px-3 py-3 border-b border-border">
  <div className="w-9 h-9 rounded-full bg-muted text-foreground flex items-center justify-center text-sm font-semibold flex-shrink-0">
    {(displayName || user.email || '?').trim().charAt(0).toUpperCase()}
  </div>
  <div className="flex flex-col min-w-0">
    <span className="text-sm font-medium text-foreground truncate">
      {displayName || user.email?.split('@')[0]}
    </span>
    <span className="text-xs text-muted-foreground truncate">{user.email}</span>
  </div>
</div>
```

`displayName` reads from `user.user_metadata.display_name` (Supabase auth metadata, populated by AccountForm).

### 4.3 Main view items

Below the identity card:

```
[⇄] Trocar conta            ›    (only if more than one account exists)
[+] Adicionar conta
──────────────────────────────
[⚡] Configurar MCP              (KEEP — migrates to Settings in C)
[⚙] Configurações
[🧩] Plugins                    (KEEP — migrates to Settings in C)
[→] Sair
──────────────────────────────
[☾] Modo Escuro            ON  (KEEP — migrates to Settings in C)
[🌐] Idioma                PT
```

The "Trocar conta" row is only rendered when `accounts.length > 1`. If there's only one account, switching is meaningless and the row clutters the menu.

Clicking "Trocar conta" sets `subView = 'accounts'`. Clicking "Adicionar conta" closes the menu and opens `AuthDialog` in `mode="add-account"` (already implemented).

### 4.4 Accounts subview

When `subView === 'accounts'`, the entire dropdown content is REPLACED with:

```
[←] Voltar                       (clicking returns to subView='main')
──────────────────────────────
[✓] guilhermeganim@hotmail.com  ← active
[ ] outra@email.com         [🗑] ← click to switch; trash to remove (on hover)
[ ] ...
```

`AccountSwitcher` gets a minimal reshape:
- Drop the inline "+Adicionar conta" footer (now lives in main view).
- Drop the `onAddAccount` prop (no longer rendered by the switcher).
- Keep `onClose` — UserMenu passes `() => setSubView('main')`, so a successful switch returns the subview to main and lets the user see the new active identity in the card. The actual menu-close happens on the outer outside-click handler.
- Render a Back row at the TOP of UserMenu's subview wrapper (not inside `AccountSwitcher` itself), so the switcher stays a pure list.

### 4.5 Removed: "Verificar atualizações"

Strip from `UserMenu.tsx`:
- The `<button onClick={handleCheckUpdates}>` row.
- The `handleCheckUpdates` function.
- The `handleInstallUpdate` function.
- The entire `<Dialog open={updateDialogOpen}>` block (with all its `updater.checking`/`available`/`downloading`/`installing`/`error` states).
- The `useState` for `updateDialogOpen` and `updateState`.
- The `import { checkForUpdates, downloadAndInstall, type UpdateState } from '@/lib/updater';` line.
- Lucide icons used only here: `Download`, `Loader2`, `CheckCircle2`, `AlertCircle`.

`@/lib/updater` itself stays — `plugin-updater` is still installed and the helpers can be re-wired into an auto-check at startup later. Out of scope for this spec.

Translation keys: remove `user_menu.check_updates`, `updater.*` from `pt-BR.json` and `en.json`.

### 4.6 What does NOT change in B

The following items stay in the menu, identical to today:
- Configurar MCP (with its dialog)
- Configurações (with its dialog, currently showing `AccountForm`)
- Plugins (disabled placeholder button)
- Modo Escuro toggle row
- Idioma toggle row
- Sair button

These are Feature C's job to migrate. B is just the identity + window controls.

## 5. Drag region edge cases

| Case | Handling |
|---|---|
| User clicks a tab | tab has `data-tauri-drag-region="false"` → click registers, no drag |
| User drags from empty space in the header | drag region active → window moves |
| User double-clicks empty space | Tauri default → toggle maximize |
| User clicks WorkspaceSwitcher | switcher root has `data-tauri-drag-region="false"` → opens dropdown normally |
| User clicks a window control | controls wrapper has the opt-out → click registers |
| User drags from a button | the button is opt-out, so drag does NOT initiate. Acceptable. |
| User opens UserMenu and the dropdown extends beyond the drag region | dropdown is positioned absolutely, escapes the row — its own children are clickable normally |

## 6. Cross-platform notes

This spec ships custom controls for Windows. Behavior on macOS/Linux when `decorations: false`:

- **macOS**: loses native traffic-light buttons. The custom Min/Max/Close work but visually don't match the OS. Acceptable until a macOS build is a priority.
- **Linux**: window dragging may or may not work depending on the compositor. Tauri's drag-region implementation is best-effort here. Acceptable.

If the user later wants per-OS behavior, the simplest add is to read `navigator.userAgent` or use a Tauri `platform()` call and conditionally render `<WindowControls />` only when `platform() === 'windows'`. Not in this spec.

## 7. Files touched

| File | Change |
|---|---|
| `src-tauri/tauri.conf.json` | `windows[0].decorations: false` |
| `src/components/WindowControls.tsx` | new |
| `src/components/Layout.tsx` | add `data-tauri-drag-region` on header, opt-out on interactive children, render `<WindowControls />` |
| `src/components/UserMenu.tsx` | replace identity row with avatar card; add `subView` state + accounts subview; remove update-check button + dialog + state + helpers; tweak `<AccountSwitcher>` props |
| `src/components/AccountSwitcher.tsx` | drop the inline "+Adicionar conta" footer (moved to UserMenu main view); minor prop rename if needed |
| `src/i18n/locales/pt-BR.json` | remove `user_menu.check_updates`, `updater.*`; add new strings for "Trocar conta", "Adicionar conta", "Voltar" if not present |
| `src/i18n/locales/en.json` | same |

## 8. Test plan (manual)

After Vite HMR / restart of `pnpm tauri dev`:

1. Native Windows titlebar is gone. App content starts at y=0.
2. Drag the header empty space → window moves.
3. Double-click header empty space → window toggles maximize.
4. Click Minimize / Maximize-toggle / Close in the new controls → each acts correctly.
5. Maximize via Win+Up → the Maximize icon in our controls flips to "restore".
6. Click WorkspaceSwitcher / a tab / UserMenu trigger → opens normally (does NOT drag the window).
7. Open UserMenu → identity card shows avatar circle + name + email.
8. If single account: no "Trocar conta" row.
9. Add a second account → menu shows "Trocar conta ›". Click → subview replaces the dropdown content with the accounts list + a Back row. Click an inactive account → switches. Click Back → returns to main.
10. "Adicionar conta" → AuthDialog opens in add-account mode.
11. The "Verificar atualizações" button is gone. The update dialog modal is gone.
12. MCP, Configurações, Plugins, Modo Escuro, Idioma rows still present and functional.

## 9. Risks

- **Drag region conflicts**: if any interactive child forgets `data-tauri-drag-region="false"`, click events may be eaten by the drag handler. Mitigation: opt-out applied on the wrappers of interactive groups (WorkspaceSwitcher root, UserMenu trigger, WindowControls wrapper, every tab `<button>`).
- **Decorations off on macOS**: visual regression for any macOS user. Mitigation: spec scope is Windows; add per-platform gate if/when a macOS build is on the roadmap.
- **Drag-region double-click maximize**: works on most setups but some Windows display-scaling configs swallow the event. Out of our control; users can still click the Max button.
- **Removing the update dialog without auto-check**: a user won't know when an update is available until we wire startup auto-check. Documented as a follow-up; the spec accepts this gap because the manual button was rarely used in practice (per user feedback).

## 10. Out of scope (Feature C)

- Migrating MCP / Plugins / Theme / Language items into a Settings dialog with sidebar nav.
- Building the Account tab inside Settings.
- Anything to do with sharing, workspaces, or the share-link feature.
