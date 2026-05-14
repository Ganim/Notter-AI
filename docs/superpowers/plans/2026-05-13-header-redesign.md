# Header Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native Tauri titlebar with custom window controls flush to the right of the user menu, and redesign the user menu around an identity card + a Discord-style account-switcher submenu. "Verificar atualizações" is dropped entirely.

**Architecture:** `decorations: false` in `tauri.conf.json` removes the native frame. The existing header row in `Layout.tsx` gains `data-tauri-drag-region` on its outer container, with `data-tauri-drag-region="false"` on every interactive child. A new `<WindowControls>` component renders Min / Max-toggle / Close buttons that drive `getCurrentWindow().minimize() / .toggleMaximize() / .close()`. `UserMenu.tsx` is rewritten around a `subView: 'main' | 'accounts'` state, with the existing `AccountSwitcher` reused (minus its inline "+Adicionar conta" footer).

**Tech Stack:** TypeScript, React 19, Tauri 2, `@tauri-apps/api/window`, lucide-react, react-i18next.

**Atomic delivery:** Single final commit covering all changes. Do not commit intermediate tasks.

**Test plan:** Manual smoke against the running `pnpm tauri dev` session — automated tests are not added (matches the file's existing pattern; no vitest coverage for Layout or UserMenu today).

---

## Task 1: Disable native window decorations

**Files:**
- Modify: `src-tauri/tauri.conf.json` (windows[0])

- [ ] **Step 1: Read the current windows config**

Run: `git -C "C:/Users/Guilherme/Code/Projetos/Notter-AI" show HEAD:src-tauri/tauri.conf.json | grep -A 10 '"windows"'`
Expected: the existing `windows[0]` block prints. Confirm there is no current `"decorations"` field.

- [ ] **Step 2: Add the decorations key**

In the `windows[0]` object, add (next to `"title"`):

```jsonc
"decorations": false
```

- [ ] **Step 3: Verify config still parses**

Run: `git -C "C:/Users/Guilherme/Code/Projetos/Notter-AI" diff src-tauri/tauri.conf.json`
Expected: a single `+    "decorations": false,` line under `windows[0]`.

---

## Task 2: WindowControls component

**Files:**
- Create: `src/components/WindowControls.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/WindowControls.tsx
//
// Custom Min / Max-toggle / Close buttons that replace the native Windows
// titlebar (disabled via tauri.conf.json windows[0].decorations: false).
// Sized to Windows 11 system buttons (44x32). Close turns red on hover.
// The Maximize icon flips to a "restore" glyph when the window is already
// maximized, kept in sync via `onResized` to catch OS-side state changes
// (Win+Up, snap, double-click on the drag region, etc.).
import { useEffect, useState } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let mounted = true;
    win.isMaximized().then((v) => { if (mounted) setMaximized(v); });
    const unlistenPromise = win.onResized(async () => {
      const v = await win.isMaximized();
      if (mounted) setMaximized(v);
    });
    return () => {
      mounted = false;
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="flex items-center" data-tauri-drag-region="false">
      <button
        onClick={() => win.minimize()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
        title="Minimize"
        type="button"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
        title={maximized ? 'Restore' : 'Maximize'}
        type="button"
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        onClick={() => win.close()}
        className="w-11 h-8 inline-flex items-center justify-center text-muted-foreground hover:bg-red-600 hover:text-white transition-colors"
        title="Close"
        type="button"
      >
        <X size={14} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify TS compile**

Run: `pnpm tsc --noEmit` (via the fnm pnpm path)
Expected: no errors. Component is not yet wired in anywhere, so no usage errors either.

---

## Task 3: Wire WindowControls into Layout + drag region

**Files:**
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Add the import**

Near the existing `import { UserMenu }` / `import { WorkspaceSwitcher }` lines, add:

```tsx
import { WindowControls } from './WindowControls';
```

- [ ] **Step 2: Mark the header outer container as a drag region**

Find the outermost `<div>` of the header row (the one that wraps tabs + WorkspaceSwitcher + UserMenu). Add `data-tauri-drag-region` (no value).

For example, if the current line is:
```tsx
<div className="flex items-center justify-between px-4 py-2 border-b border-border">
```
it becomes:
```tsx
<div className="flex items-center justify-between px-4 py-2 border-b border-border" data-tauri-drag-region>
```

- [ ] **Step 3: Opt-out the tab buttons and the right-side group**

The tabs `<div>` (the one that wraps `TABS.map((tab) => <button>...))`) gets:
```tsx
<div className="..." data-tauri-drag-region="false">
```

The right-side `<div className="flex items-center gap-1">` (containing WorkspaceSwitcher + UserMenu) gets the same opt-out.

- [ ] **Step 4: Render WindowControls after UserMenu**

Inside the right-side group (already `data-tauri-drag-region="false"`):

```tsx
<div className="flex items-center gap-1" data-tauri-drag-region="false">
  <WorkspaceSwitcher />
  <UserMenu />
  <WindowControls />
</div>
```

- [ ] **Step 5: Verify TS compile**

Run: `pnpm tsc --noEmit`
Expected: no errors.

---

## Task 4: i18n strings

**Files:**
- Modify: `src/i18n/locales/pt-BR.json`
- Modify: `src/i18n/locales/en.json`

- [ ] **Step 1: Remove `user_menu.check_updates` and the entire `updater.*` block**

In **both** locale files, delete the line `"check_updates": "..."` inside `user_menu`. Then delete the entire `"updater": { ... }` object including its trailing comma.

- [ ] **Step 2: Add new keys for the redesigned menu**

Inside `accounts` (the existing object near the top of each locale), confirm or add these keys:

`pt-BR.json`:
```json
"switch_account": "Trocar conta",
"add": "Adicionar conta",
"back": "Voltar"
```

`en.json`:
```json
"switch_account": "Switch account",
"add": "Add account",
"back": "Back"
```

If `accounts.add` already exists, leave it as-is; the rest are likely new.

- [ ] **Step 3: Verify JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/pt-BR.json','utf-8'))" && node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/en.json','utf-8'))"`
Expected: no output (success).

---

## Task 5: Reshape AccountSwitcher

**Files:**
- Modify: `src/components/AccountSwitcher.tsx`

- [ ] **Step 1: Drop the `onAddAccount` prop and the inline footer**

Remove the `onAddAccount` field from the `AccountSwitcherProps` interface and from the function signature destructuring. Delete the `import { UserPlus } from 'lucide-react'` if `UserPlus` is no longer used anywhere in the file (the inline "Add account" button is what referenced it).

Replace the existing return-statement footer (the `<button onClick={() => { onClose(); onAddAccount(); }}>...UserPlus.../>{t('accounts.add')}...</button>`) — DELETE that entire `<button>...</button>` block, leaving only the accounts loop and the closing `</div>`.

The component now renders ONLY the list of accounts. UserMenu hosts "Add account" itself in the main view.

- [ ] **Step 2: Verify TS compile**

Run: `pnpm tsc --noEmit`
Expected: a single error in `UserMenu.tsx` saying `Property 'onAddAccount' is missing` — that's expected; Task 6 fixes it.

---

## Task 6: Rewrite UserMenu

**Files:**
- Modify: `src/components/UserMenu.tsx`

- [ ] **Step 1: Replace the imports block**

Replace lines 1-13 (everything from `import { useState ...` through `import { toast } from 'sonner';`) with:

```tsx
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Puzzle, LogIn, LogOut, Globe, Moon, Sun, User, Network, ArrowLeftRight, UserPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { AuthDialog } from '@/components/AuthDialog';
import { AccountForm } from '@/components/AccountForm';
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { McpConfigDialog } from '@/components/McpConfigDialog';
import { toast } from 'sonner';
```

Removed: `Download`, `Loader2`, `CheckCircle2`, `AlertCircle`, `Brain` lucide icons (used only by the old updater dialog and the removed Manage AI item); `checkForUpdates`, `downloadAndInstall`, `UpdateState` from updater lib.

Added: `ArrowLeftRight`, `UserPlus`, `ChevronLeft`, `ChevronRight` icons; `getAccountManager` (to count accounts for showing/hiding the switch row).

- [ ] **Step 2: Replace state declarations**

Replace the state block (lines ~17-27 of the current file) with:

```tsx
  const [open, setOpen] = useState(false);
  const [subView, setSubView] = useState<'main' | 'accounts'>('main');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { darkMode, setDarkMode, language, setLanguage } = useAppStore();
  const { user, signOut } = useAuthStore();
  const accountCount = getAccountManager().list().length;
```

Removed: `updateDialogOpen`, `updateState`. Added: `subView`, `accountCount`.

- [ ] **Step 3: Replace helper functions**

Replace the helper block (the `useEffect` for outside-click stays, but `openManageAi`, `handleCheckUpdates`, `handleInstallUpdate` are deleted; `openMcpConfig`, `openSettings`, `openAuthDialog`, `handleLogout`, `toggleDarkMode`, `toggleLanguage` stay) with:

```tsx
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSubView('main');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Reset subview whenever the menu closes (next open starts at main).
  useEffect(() => {
    if (!open) setSubView('main');
  }, [open]);

  const toggleDarkMode = () => setDarkMode(!darkMode);
  const toggleLanguage = () => setLanguage(language === 'pt-BR' ? 'en' : 'pt-BR');

  const openSettings = () => { setOpen(false); setSettingsOpen(true); };
  const openMcpConfig = () => { setOpen(false); setMcpConfigOpen(true); };
  const openAuthDialog = () => { setOpen(false); setAuthDialogOpen(true); };
  const handleAddAccount = () => { setOpen(false); setAddAccountOpen(true); };

  const handleLogout = async () => {
    setOpen(false);
    await signOut();
    toast.success(t('auth.logout_success'));
  };

  const displayName =
    (user?.user_metadata as Record<string, unknown> | undefined)?.['display_name'] as string | undefined;
  const initial = (displayName || user?.email || '?').trim().charAt(0).toUpperCase() || '?';
```

- [ ] **Step 4: Replace the dropdown JSX**

Replace the entire `{open && ( <div className="absolute right-0 top-full ..."> ... </div> )}` block with the two-view dropdown:

```tsx
        {open && (
          <div className="absolute right-0 top-full mt-1 w-64 bg-popover border border-border rounded-md shadow-lg z-50 py-1" data-tauri-drag-region="false">
            {subView === 'main' && (
              <>
                {user && (
                  <div className="flex items-center gap-3 px-3 py-3 border-b border-border">
                    <div className="w-9 h-9 rounded-full bg-muted text-foreground flex items-center justify-center text-sm font-semibold flex-shrink-0">
                      {initial}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-medium text-foreground truncate">
                        {displayName || user.email?.split('@')[0]}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">{user.email}</span>
                    </div>
                  </div>
                )}

                {user && accountCount > 1 && (
                  <button
                    onClick={() => setSubView('accounts')}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                  >
                    <span className="flex items-center gap-3">
                      <ArrowLeftRight size={14} />
                      {t('accounts.switch_account')}
                    </span>
                    <ChevronRight size={14} className="text-muted-foreground" />
                  </button>
                )}
                {user && (
                  <button
                    onClick={handleAddAccount}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                  >
                    <UserPlus size={14} />
                    {t('accounts.add')}
                  </button>
                )}

                {user && <div className="border-t border-border my-1" />}

                {user && (
                  <button
                    onClick={openMcpConfig}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                  >
                    <Network size={14} />
                    {t('mcp.menu_label')}
                  </button>
                )}
                <button onClick={openSettings} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
                  <Settings size={14} />
                  {t('user_menu.settings')}
                </button>
                <button disabled className="w-full flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground cursor-not-allowed">
                  <Puzzle size={14} />
                  {t('user_menu.plugins')}
                </button>

                {user ? (
                  <button onClick={handleLogout} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
                    <LogOut size={14} />
                    {t('auth.logout')}
                  </button>
                ) : (
                  <button onClick={openAuthDialog} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
                    <LogIn size={14} />
                    {t('auth.login')}
                  </button>
                )}

                <div className="border-t border-border my-1" />

                <button
                  onClick={toggleDarkMode}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                >
                  <span className="flex items-center gap-3">
                    {darkMode ? <Sun size={14} /> : <Moon size={14} />}
                    {t('user_menu.dark_mode')}
                  </span>
                  <span className="text-xs text-muted-foreground">{darkMode ? 'ON' : 'OFF'}</span>
                </button>

                <button
                  onClick={toggleLanguage}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                >
                  <span className="flex items-center gap-3">
                    <Globe size={14} />
                    {t('user_menu.language')}
                  </span>
                  <span className="text-xs text-muted-foreground">{language === 'pt-BR' ? 'PT' : 'EN'}</span>
                </button>
              </>
            )}

            {subView === 'accounts' && (
              <>
                <button
                  onClick={() => setSubView('main')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors border-b border-border"
                >
                  <ChevronLeft size={14} />
                  {t('accounts.back')}
                </button>
                <AccountSwitcher onClose={() => setSubView('main')} />
              </>
            )}
          </div>
        )}
```

- [ ] **Step 5: Replace the trigger button to opt out of drag**

The trigger `<button onClick={() => setOpen(!open)} ...>` gets `data-tauri-drag-region="false"`:

```tsx
        <button
          onClick={() => setOpen(!open)}
          data-tauri-drag-region="false"
          className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <User size={16} />
          <span className="hidden sm:inline">{displayName || user?.email?.split('@')[0] || 'User'}</span>
        </button>
```

- [ ] **Step 6: Remove the entire `<Dialog open={updateDialogOpen}>` block**

Delete the JSX that renders the update dialog (the one with `updater.checking`, `updater.up_to_date`, `updater.available`, etc.). Goes from `{/* Update Dialog */}` through the matching `</Dialog>`.

- [ ] **Step 7: Remove the `<ManageAiDialog ...>` line if it's still present**

It was removed in `f3ab3f8` but verify the file does not still reference it. (If `git diff main` says it's still there, delete it.)

- [ ] **Step 8: Verify TS compile**

Run: `pnpm tsc --noEmit`
Expected: no errors.

---

## Task 7: Build verification

**Files:** none

- [ ] **Step 1: TypeScript type-check the whole app**

Run from repo root, with fnm path prefixed if needed:
```
& "C:\Users\Guilherme\AppData\Roaming\fnm\node-versions\v24.15.0\installation\pnpm.cmd" exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 2: Cargo check the Rust side**

Run:
```
cd src-tauri && cargo check
```
Expected: `Finished` line, no errors. (No Rust files changed in this plan, but the tauri.conf.json change triggers a config rebuild.)

---

## Task 8: Single atomic commit

**Files:** all of the above.

- [ ] **Step 1: Stage**

```
git -C "C:/Users/Guilherme/Code/Projetos/Notter-AI" add src-tauri/tauri.conf.json src/components/WindowControls.tsx src/components/Layout.tsx src/components/UserMenu.tsx src/components/AccountSwitcher.tsx src/i18n/locales/pt-BR.json src/i18n/locales/en.json
```

- [ ] **Step 2: Commit**

```
git -C "C:/Users/Guilherme/Code/Projetos/Notter-AI" commit -m "$(cat <<'EOF'
feat(header): custom Tauri titlebar + redesigned user menu

Feature A (titlebar):
- decorations: false in tauri.conf.json removes the native frame
- new WindowControls component (Min / Max-toggle / Close) flush right
- Layout's header outer div is a tauri drag region; tabs, workspace
  switcher, user menu, and window controls opt out via
  data-tauri-drag-region="false"
- Max icon flips to "restore" glyph when window is maximized; synced
  via onResized so OS-side state changes (Win+Up, snap, etc.) are
  reflected

Feature B (user menu):
- replace "Logado como" duplicate header + inline AccountSwitcher with
  an avatar identity card (initial circle, display name, email)
- "Trocar conta" pushed behind a subView state — clicking replaces the
  dropdown content with the accounts list + Back row. Only rendered
  when more than one account exists.
- "Adicionar conta" promoted to a top-level button in the main view
- AccountSwitcher reshaped: inline +Adicionar conta footer dropped (it
  lives in UserMenu now); onAddAccount prop removed
- "Verificar atualizações" surface gone entirely: button, helpers,
  dialog, state, lucide icons, updater.* i18n strings, user_menu.check_updates
- MCP / Plugins / Configurações / Modo Escuro / Idioma rows kept in
  place; Feature C will migrate them into Settings tabs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Confirm clean tree**

Run: `git -C "C:/Users/Guilherme/Code/Projetos/Notter-AI" status`
Expected: "nothing to commit, working tree clean".
