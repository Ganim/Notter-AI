# Settings Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse five operational items (MCP, Plugins, Modo Escuro, Idioma, single-tab Configurações) out of the user menu and into a single Settings dialog with a sidebar nav (Conta, Aparência, Idioma, MCP, Plugins) + content panel.

**Architecture:** A new `<SettingsDialog>` owns `activeTab` state and renders `<SettingsSideNav>` on the left + the matching `*Tab` component on the right. Each tab is a self-contained component under `src/components/settings/tabs/`. The dialog uses `max-w-3xl`, `min-h-[480px]`, grayscale palette. UserMenu loses the four migrated items + the inline single-tab Settings dialog; its Configurações entry now triggers `<SettingsDialog>`.

**Tech Stack:** TypeScript, React 19, lucide-react, react-i18next, existing shadcn Dialog + cn() utility + zustand stores (useAppStore, useAuthStore).

**Atomic delivery:** Single final commit covering all changes (matches earlier feature commits). Do not commit intermediate tasks.

**Test plan:** Manual smoke against the running `pnpm tauri dev` session, against §7 of the spec at `docs/superpowers/specs/2026-05-13-settings-refactor-design.md`.

---

## Task 1: i18n additions (both locales)

**Files:**
- Modify: `src/i18n/locales/pt-BR.json` — add keys under `settings`
- Modify: `src/i18n/locales/en.json` — add parallel keys

- [ ] **Step 1: Add keys to `pt-BR.json` `settings` block**

After the existing `"settings": { ... }` keys (find the `settings` object that contains `"title": "Configurações"`), add nested objects so the final shape includes:

```json
"settings": {
  "title": "Configurações",
  /* existing siblings preserved */
  "tabs": {
    "account": "Conta",
    "appearance": "Aparência",
    "language": "Idioma",
    "mcp": "MCP",
    "plugins": "Plugins"
  },
  "appearance": {
    "dark_mode": "Modo escuro",
    "dark_mode_hint": "Alterna entre o tema claro e o escuro."
  },
  "language": {
    "pt_BR": "Português (Brasil)",
    "en": "English"
  },
  "plugins": {
    "coming_soon": "Em breve."
  }
}
```

- [ ] **Step 2: Mirror in `en.json`**

```json
"settings": {
  /* existing siblings preserved */
  "tabs": {
    "account": "Account",
    "appearance": "Appearance",
    "language": "Language",
    "mcp": "MCP",
    "plugins": "Plugins"
  },
  "appearance": {
    "dark_mode": "Dark mode",
    "dark_mode_hint": "Toggle between light and dark theme."
  },
  "language": {
    "pt_BR": "Portuguese (Brazil)",
    "en": "English"
  },
  "plugins": {
    "coming_soon": "Coming soon."
  }
}
```

- [ ] **Step 3: Validate JSON parses**

Run via fnm node:
```
& "C:\Users\Guilherme\AppData\Roaming\fnm\node-versions\v24.15.0\installation\node.exe" -e "JSON.parse(require('fs').readFileSync('C:/Users/Guilherme/Code/Projetos/Notter-AI/src/i18n/locales/pt-BR.json','utf-8'));JSON.parse(require('fs').readFileSync('C:/Users/Guilherme/Code/Projetos/Notter-AI/src/i18n/locales/en.json','utf-8'));console.log('OK')"
```
Expected: `OK`.

---

## Task 2: SettingsSideNav

**Files:**
- Create: `src/components/settings/SettingsSideNav.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/settings/SettingsSideNav.tsx
//
// Vertical sidebar for the Settings dialog. 200px wide, slightly darker than
// the content (bg-muted/40). Five tab buttons; the active one uses the same
// `bg-accent text-accent-foreground` pair as the workspace switcher selection.
import { useTranslation } from 'react-i18next';
import { User, Palette, Globe, Network, Puzzle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SettingsTab = 'account' | 'appearance' | 'language' | 'mcp' | 'plugins';

interface Props {
  active: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}

const TABS: Array<{ id: SettingsTab; labelKey: string; Icon: typeof User }> = [
  { id: 'account',    labelKey: 'settings.tabs.account',    Icon: User },
  { id: 'appearance', labelKey: 'settings.tabs.appearance', Icon: Palette },
  { id: 'language',   labelKey: 'settings.tabs.language',   Icon: Globe },
  { id: 'mcp',        labelKey: 'settings.tabs.mcp',        Icon: Network },
  { id: 'plugins',    labelKey: 'settings.tabs.plugins',    Icon: Puzzle },
];

export function SettingsSideNav({ active, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <nav className="w-[200px] shrink-0 bg-muted/40 border-r border-border py-3 flex flex-col gap-0.5">
      {TABS.map(({ id, labelKey, Icon }) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={cn(
              'mx-2 px-3 py-2 rounded-md text-sm text-left flex items-center gap-2 transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
            )}
          >
            <Icon size={14} />
            <span>{t(labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Verify TS compile**

Run: `pnpm exec tsc --noEmit` (via fnm pnpm path)
Expected: no errors. Component is unused so far.

---

## Task 3: Account tab

**Files:**
- Create: `src/components/settings/tabs/AccountTab.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/settings/tabs/AccountTab.tsx
import { useTranslation } from 'react-i18next';
import { AccountForm } from '@/components/AccountForm';

export function AccountTab() {
  const { t } = useTranslation();
  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-4">{t('settings.tabs.account')}</h2>
      <AccountForm />
    </div>
  );
}
```

---

## Task 4: Appearance tab

**Files:**
- Create: `src/components/settings/tabs/AppearanceTab.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/settings/tabs/AppearanceTab.tsx
import { useTranslation } from 'react-i18next';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

export function AppearanceTab() {
  const { t } = useTranslation();
  const darkMode = useAppStore((s) => s.darkMode);
  const setDarkMode = useAppStore((s) => s.setDarkMode);
  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-4">{t('settings.tabs.appearance')}</h2>
      <div className="flex items-center justify-between gap-4 py-3 border-t border-border">
        <div className="flex items-start gap-3">
          {darkMode
            ? <Moon size={18} className="text-muted-foreground mt-0.5" />
            : <Sun size={18} className="text-muted-foreground mt-0.5" />}
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">{t('settings.appearance.dark_mode')}</span>
            <span className="text-xs text-muted-foreground">{t('settings.appearance.dark_mode_hint')}</span>
          </div>
        </div>
        <button
          onClick={() => setDarkMode(!darkMode)}
          role="switch"
          aria-checked={darkMode}
          className={cn(
            'relative w-11 h-6 rounded-full transition-colors flex-shrink-0',
            darkMode ? 'bg-foreground/80' : 'bg-muted',
          )}
        >
          <span className={cn(
            'absolute top-0.5 w-5 h-5 rounded-full bg-background transition-transform',
            darkMode ? 'translate-x-[22px]' : 'translate-x-0.5',
          )} />
        </button>
      </div>
    </div>
  );
}
```

---

## Task 5: Language tab

**Files:**
- Create: `src/components/settings/tabs/LanguageTab.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/settings/tabs/LanguageTab.tsx
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

const LANGUAGES = [
  { id: 'pt-BR' as const, labelKey: 'settings.language.pt_BR' },
  { id: 'en'    as const, labelKey: 'settings.language.en' },
];

export function LanguageTab() {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-4">{t('settings.tabs.language')}</h2>
      <div className="border border-border rounded-md divide-y divide-border overflow-hidden">
        {LANGUAGES.map((l) => (
          <button
            key={l.id}
            onClick={() => setLanguage(l.id)}
            className={cn(
              'w-full flex items-center justify-between px-4 py-3 text-left transition-colors',
              language === l.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
            )}
          >
            <span className="text-sm">{t(l.labelKey)}</span>
            {language === l.id && <Check size={14} />}
          </button>
        ))}
      </div>
    </div>
  );
}
```

---

## Task 6: MCP tab

**Files:**
- Create: `src/components/settings/tabs/McpTab.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/settings/tabs/McpTab.tsx
//
// Inlined body of the legacy McpConfigDialog. URL + bearer token + copy
// button. Reads the active account's config via readMcpConfigForAccount.
// Same behavior as before; lives in the Settings sidebar now.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth-store';
import { readMcpConfigForAccount, type McpAccountConfig } from '@/lib/mcp';

export function McpTab() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const [config, setConfig] = useState<McpAccountConfig | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) {
      setConfig(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    readMcpConfigForAccount(user.id)
      .then((c) => { if (!cancelled) setConfig(c); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  const onCopy = async () => {
    if (!config) return;
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    toast.success(t('mcp.copied_toast'));
  };

  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">{t('settings.tabs.mcp')}</h2>
      <p className="text-xs text-muted-foreground mb-4">{t('mcp.dialog_description')}</p>
      {loading && <p className="text-sm text-muted-foreground">…</p>}
      {!loading && !config && (
        <div className="space-y-1">
          <p className="text-sm text-destructive font-medium">{t('mcp.disabled_banner')}</p>
          <p className="text-xs text-muted-foreground">{t('mcp.disabled_reason')}</p>
        </div>
      )}
      {config && (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('mcp.url_label')}</label>
            <code className="block text-xs bg-muted rounded px-2 py-1 break-all">{config.url}</code>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('mcp.token_label')}</label>
            <code className="block text-xs bg-muted rounded px-2 py-1 break-all">{config.bearer_token}</code>
          </div>
          <button
            onClick={onCopy}
            className="px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
          >
            {t('mcp.copy_button')}
          </button>
        </div>
      )}
    </div>
  );
}
```

---

## Task 7: Plugins tab

**Files:**
- Create: `src/components/settings/tabs/PluginsTab.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/settings/tabs/PluginsTab.tsx
import { useTranslation } from 'react-i18next';
import { Puzzle } from 'lucide-react';

export function PluginsTab() {
  const { t } = useTranslation();
  return (
    <div className="p-6 h-full flex flex-col items-center justify-center text-center">
      <Puzzle size={32} className="text-muted-foreground/60 mb-3" />
      <h2 className="text-base font-semibold text-foreground mb-1">{t('settings.tabs.plugins')}</h2>
      <p className="text-sm text-muted-foreground">{t('settings.plugins.coming_soon')}</p>
    </div>
  );
}
```

---

## Task 8: SettingsDialog

**Files:**
- Create: `src/components/settings/SettingsDialog.tsx`

- [ ] **Step 1: Write the dialog parent**

```tsx
// src/components/settings/SettingsDialog.tsx
//
// Hosts the Settings UI as a dialog with a left sidebar (SettingsSideNav)
// and a right content area that swaps between the five Tab components.
// activeTab resets to initialTab on every open so re-entry is predictable.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsSideNav, type SettingsTab } from './SettingsSideNav';
import { AccountTab } from './tabs/AccountTab';
import { AppearanceTab } from './tabs/AppearanceTab';
import { LanguageTab } from './tabs/LanguageTab';
import { McpTab } from './tabs/McpTab';
import { PluginsTab } from './tabs/PluginsTab';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SettingsTab;
}

export function SettingsDialog({ open, onOpenChange, initialTab = 'account' }: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // Reset to initialTab on every reopen so callers can deep-link without
  // residual state from a previous session.
  useEffect(() => {
    if (open) setActiveTab(initialTab);
  }, [open, initialTab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b border-border">
          <DialogTitle>{t('settings.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-[480px] max-h-[70vh]">
          <SettingsSideNav active={activeTab} onChange={setActiveTab} />
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'account' && <AccountTab />}
            {activeTab === 'appearance' && <AppearanceTab />}
            {activeTab === 'language' && <LanguageTab />}
            {activeTab === 'mcp' && <McpTab />}
            {activeTab === 'plugins' && <PluginsTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify TS compile**

Run: `pnpm exec tsc --noEmit`
Expected: no errors yet. `SettingsDialog` is not used; UserMenu still references the legacy inline dialog.

---

## Task 9: UserMenu cleanup

**Files:**
- Modify: `src/components/UserMenu.tsx`

- [ ] **Step 1: Replace the imports**

Replace the existing import block with:

```tsx
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, LogIn, LogOut, User, ArrowLeftRight, UserPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { getAccountManager } from '@/lib/accounts/account-manager';
import { AuthDialog } from '@/components/AuthDialog';
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { toast } from 'sonner';
```

Removed: `Puzzle`, `Globe`, `Moon`, `Sun`, `Network` icons; `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle` from ui/dialog (no longer used here); `useAppStore` (theme + language read by the new tabs); `AccountForm`; `McpConfigDialog`.

- [ ] **Step 2: Replace state + handlers**

Replace the state declarations + handler block with:

```tsx
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [subView, setSubView] = useState<'main' | 'accounts'>('main');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { user, signOut } = useAuthStore();
  const [accountCount, setAccountCount] = useState(() => getAccountManager().list().length);

  useEffect(() => {
    const mgr = getAccountManager();
    return mgr.subscribe(() => setAccountCount(mgr.list().length));
  }, []);

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

  useEffect(() => {
    if (!open) setSubView('main');
  }, [open]);

  const openSettings = () => { setOpen(false); setSettingsOpen(true); };
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

Removed: `mcpConfigOpen` state, `openMcpConfig` handler, `toggleDarkMode`/`toggleLanguage` helpers, `useAppStore` destructure.

- [ ] **Step 3: Replace the dropdown JSX (main view)**

Inside the `{subView === 'main' && ( <> ... </> )}` block, replace the content (everything between the identity card and the closing fragment) with:

```tsx
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

                <button onClick={openSettings} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
                  <Settings size={14} />
                  {t('user_menu.settings')}
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
```

Removed: Configurar MCP button, Plugins disabled button, Modo Escuro toggle row, Idioma toggle row, the bottom divider.

The `{subView === 'accounts' && ...}` block stays unchanged.

- [ ] **Step 4: Replace the trailing dialogs**

Replace the existing dialogs block at the bottom of the returned JSX:

```tsx
      <AuthDialog open={authDialogOpen} onOpenChange={setAuthDialogOpen} />
      <AuthDialog open={addAccountOpen} onOpenChange={setAddAccountOpen} mode="add-account" />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
```

Removed: `<McpConfigDialog>`, the inline `<Dialog open={settingsOpen}>...<AccountForm /></Dialog>` block.

- [ ] **Step 5: Verify TS compile**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

---

## Task 10: Build verification

**Files:** none

- [ ] **Step 1: TypeScript type-check**

Run:
```
& "C:\Users\Guilherme\AppData\Roaming\fnm\node-versions\v24.15.0\installation\pnpm.cmd" exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 2: i18n parse**

Run:
```
& "C:\Users\Guilherme\AppData\Roaming\fnm\node-versions\v24.15.0\installation\node.exe" -e "JSON.parse(require('fs').readFileSync('C:/Users/Guilherme/Code/Projetos/Notter-AI/src/i18n/locales/pt-BR.json','utf-8'));JSON.parse(require('fs').readFileSync('C:/Users/Guilherme/Code/Projetos/Notter-AI/src/i18n/locales/en.json','utf-8'));console.log('OK')"
```
Expected: `OK`.

---

## Task 11: Single atomic commit

**Files:** all of the above.

- [ ] **Step 1: Stage**

```
git -C "C:/Users/Guilherme/Code/Projetos/Notter-AI" add src/components/settings/ src/components/UserMenu.tsx src/i18n/locales/pt-BR.json src/i18n/locales/en.json
```

- [ ] **Step 2: Commit**

```
git -C "C:/Users/Guilherme/Code/Projetos/Notter-AI" commit -m "$(cat <<'EOF'
feat(settings): consolidate menu items into Settings dialog with sidebar nav

Build a SettingsDialog (max-w-3xl, min-h-[480px], grayscale palette) with
a left SettingsSideNav (200px, bg-muted/40) and a right content panel
that swaps between five tabs: Conta, Aparência, Idioma, MCP, Plugins.

Tabs:
- AccountTab: wraps the existing AccountForm
- AppearanceTab: dark-mode switch (role="switch", grayscale styling)
- LanguageTab: list with check mark on active language
- McpTab: URL + bearer token + copy button (inlined from McpConfigDialog)
- PluginsTab: centered "Coming soon" placeholder

UserMenu cleanup:
- drop the MCP, Plugins, Modo Escuro, Idioma rows from the main view
- swap the inline single-tab Settings dialog for <SettingsDialog>
- drop unused imports, state, handlers, and lucide icons

The legacy McpConfigDialog.tsx is left on disk but unreferenced; a
follow-up commit deletes it once the new surface has been smoke-tested.

i18n: add settings.tabs.*, settings.appearance.*, settings.language.*,
settings.plugins.* keys to pt-BR.json and en.json.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Confirm clean tree**

Run: `git -C "C:/Users/Guilherme/Code/Projetos/Notter-AI" status`
Expected: "nothing to commit, working tree clean".
