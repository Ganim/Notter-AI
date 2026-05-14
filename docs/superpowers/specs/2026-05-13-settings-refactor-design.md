# Settings Refactor — Sidebar + Tabs

**Date:** 2026-05-13
**Scope:** Feature C of the header/settings reorganization. Migrate MCP config, theme toggle, language toggle, and the Plugins placeholder from the user menu into tabs of a single Settings dialog with a sidebar nav + content layout. The Account form (existing) becomes the first tab.
**Out of scope:** Anything outside the Settings surface. Sharing, workspaces, MCP server internals, plugin runtime — none of those change. The downstream cleanup of `McpConfigDialog.tsx` (no longer used) is left for a follow-up commit.

---

## 1. Problem

After Feature A+B, the user menu still carries five operational items that don't belong in an identity menu: Configurar MCP, Plugins, Modo Escuro, Idioma, plus a single-tab Configurações that only shows the Account form. Five clicks deep in a single dropdown for things that are clearly "preferences" feels wrong. The user described the current Settings dialog as "uma porcaria" and wants a proper sidebar-nav layout (left rail of tabs, right content panel).

This spec collapses those five items into a single Settings surface with a tab list on the left and the tab content on the right.

## 2. Architecture

A single `<Dialog>` hosts the settings. Inside the dialog content:

```
┌────────────────────────────────────────────────────────────┐
│ <DialogHeader> Configurações                          [×] │
├──────────────┬─────────────────────────────────────────────┤
│ <SideNav>    │ <ActiveTab />                               │
│              │                                             │
│ Conta        │                                             │
│ Aparência    │   (renders one of 5 tab components based    │
│ Idioma       │    on activeTab state)                      │
│ MCP          │                                             │
│ Plugins      │                                             │
└──────────────┴─────────────────────────────────────────────┘
```

- One `SettingsDialog` component holds the `activeTab` state, the sidebar, and dispatches to the active tab component.
- Each tab is a self-contained component under `src/components/settings/tabs/`. No shared state; each tab reads its own data from the relevant store / API.
- The dialog uses `max-w-3xl` (768px) like the current Settings dialog; height is `min-h-[480px]` so all tabs share a consistent vertical footprint regardless of content height.
- Palette stays grayscale: `bg-muted/40` on the sidebar (slightly darker than the content), `bg-popover` (same as the current dialog) on the content; active tab uses the existing `bg-accent`/`text-accent-foreground` pair already used by the workspace switcher.

## 3. Components

### 3.1 `src/components/settings/SettingsDialog.tsx`

```tsx
type SettingsTab = 'account' | 'appearance' | 'language' | 'mcp' | 'plugins';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SettingsTab;  // default 'account'
}
```

- Holds `const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'account')`.
- Resets to `initialTab` whenever `open` transitions false → true (so reopening starts on the requested tab, not where the user left off — predictable behavior).
- Renders `<DialogContent className="max-w-3xl p-0 overflow-hidden">` with a flex row inside: `<SettingsSideNav>` + `<div className="flex-1 min-h-[480px] overflow-y-auto">{tabContent}</div>`.
- `tabContent` is a `switch (activeTab)` rendering the matching `*Tab` component.

### 3.2 `src/components/settings/SettingsSideNav.tsx`

```tsx
interface Props {
  active: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}
```

- Renders a vertical list of buttons, 200px wide, `bg-muted/40`, separated from content by a 1px border.
- Each button: icon (lucide) on the left, label on the right, `px-3 py-2`, `text-sm`.
- Active button uses `bg-accent text-accent-foreground`; inactive: `text-muted-foreground hover:text-foreground hover:bg-muted/60`.

| key | label key | icon |
|---|---|---|
| `account` | `settings.tabs.account` | `User` |
| `appearance` | `settings.tabs.appearance` | `Palette` |
| `language` | `settings.tabs.language` | `Globe` |
| `mcp` | `settings.tabs.mcp` | `Network` |
| `plugins` | `settings.tabs.plugins` | `Puzzle` |

### 3.3 `src/components/settings/tabs/AccountTab.tsx`

Thin wrapper over the existing `AccountForm`:

```tsx
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

`AccountForm` already renders the "Conta" heading internally — but it's a `<h3>` with `border-b`. We'll keep that AS-IS to avoid scope creep; the redundant heading is acceptable for v1. If it bugs us later, drop the inner heading in a polish pass.

### 3.4 `src/components/settings/tabs/AppearanceTab.tsx`

```tsx
export function AppearanceTab() {
  const { t } = useTranslation();
  const { darkMode, setDarkMode } = useAppStore();
  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-4">{t('settings.tabs.appearance')}</h2>
      <div className="flex items-center justify-between gap-4 py-3 border-t border-border">
        <div className="flex items-start gap-3">
          {darkMode ? <Moon size={18} className="text-muted-foreground mt-0.5" /> : <Sun size={18} className="text-muted-foreground mt-0.5" />}
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
            'relative w-11 h-6 rounded-full transition-colors',
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

A proper "switch" row, semantically tagged `role="switch"`. Grayscale only.

### 3.5 `src/components/settings/tabs/LanguageTab.tsx`

Renders a list of selectable languages, one per row:

```tsx
const LANGUAGES = [
  { id: 'pt-BR', labelKey: 'settings.language.pt_BR' },
  { id: 'en',    labelKey: 'settings.language.en' },
] as const;

export function LanguageTab() {
  const { t } = useTranslation();
  const { language, setLanguage } = useAppStore();
  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-4">{t('settings.tabs.language')}</h2>
      <div className="border border-border rounded-md divide-y divide-border">
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

Easier to extend later (just append to `LANGUAGES`).

### 3.6 `src/components/settings/tabs/McpTab.tsx`

Inlines the body of `McpConfigDialog.tsx` (URL + token + copy button) without the dialog chrome:

```tsx
export function McpTab() {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [config, setConfig] = useState<McpAccountConfig | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    readMcpConfigForAccount(user.id)
      .then(setConfig)
      .finally(() => setLoading(false));
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

Behavior matches the current dialog. The legacy `McpConfigDialog.tsx` is no longer reachable from the user menu but stays on disk for one commit cycle (delete in a follow-up to keep the diff focused on the migration).

### 3.7 `src/components/settings/tabs/PluginsTab.tsx`

```tsx
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

Centered placeholder, no interaction.

## 4. UserMenu changes

`src/components/UserMenu.tsx`:

- Remove the entire `<button onClick={openMcpConfig}>` row (the Network/MCP item).
- Remove the `<button disabled>` Puzzle/Plugins row.
- Remove the "toggle dark mode" `<button>` row at the bottom.
- Remove the "toggle language" `<button>` row at the bottom.
- Remove the final `<div className="border-t border-border my-1" />` divider that separated the (now gone) theme/lang rows from the rest.
- Remove `openMcpConfig`, `toggleDarkMode`, `toggleLanguage` handlers.
- Remove the `<McpConfigDialog>` render at the bottom.
- Remove the `mcpConfigOpen` useState.
- Remove the `McpConfigDialog` import.
- Drop now-unused lucide icons: `Network`, `Puzzle`, `Moon`, `Sun`, `Globe`.
- Drop now-unused `darkMode`, `setDarkMode`, `language`, `setLanguage` from the `useAppStore` destructure.
- Replace the existing inline `<Dialog open={settingsOpen}>` (which renders `<AccountForm>` directly) with `<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />`.

After these cuts, the dropdown's main view is:

```
[card]
[Trocar conta › if >1 account]
[Adicionar conta]
─────────
[Configurações]
[Sair / Login]
```

Five rows total at most (plus the identity card). Clean.

## 5. i18n additions

Both `pt-BR.json` and `en.json` gain a new `settings.tabs.*` block and a couple of helper keys. Removals from the existing locales: none beyond what the new keys add. The existing `mcp.*` keys are reused by `McpTab`.

`pt-BR.json` additions, inside the existing `settings` object:

```json
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
```

`en.json` additions, parallel:

```json
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
```

`settings.title` already exists. `user_menu.plugins` and `user_menu.dark_mode` and `user_menu.language` become orphans after the UserMenu cuts — leave them in the locale files (cheap, and they may be reused) and remove only `user_menu.plugins` if it's truly never referenced anywhere (verify before deletion).

## 6. File layout

| File | Action |
|---|---|
| `src/components/settings/SettingsDialog.tsx` | create |
| `src/components/settings/SettingsSideNav.tsx` | create |
| `src/components/settings/tabs/AccountTab.tsx` | create |
| `src/components/settings/tabs/AppearanceTab.tsx` | create |
| `src/components/settings/tabs/LanguageTab.tsx` | create |
| `src/components/settings/tabs/McpTab.tsx` | create |
| `src/components/settings/tabs/PluginsTab.tsx` | create |
| `src/components/UserMenu.tsx` | modify (remove migrated rows, swap inline Settings dialog for `<SettingsDialog>`) |
| `src/components/McpConfigDialog.tsx` | leave in place this commit; delete in a separate cleanup commit after smoke test |
| `src/i18n/locales/pt-BR.json` | add `settings.tabs.*`, `settings.appearance.*`, `settings.language.*`, `settings.plugins.*` |
| `src/i18n/locales/en.json` | parallel additions |

## 7. Test plan

Manual, against the running Tauri dev session:

1. Open user menu → confirm only identity card + Trocar conta (if applicable) + Adicionar conta + Configurações + Sair are visible. No MCP, Plugins, Modo Escuro, Idioma rows.
2. Click Configurações → settings dialog opens on "Conta" tab. Sidebar shows 5 tabs.
3. Click each tab → content area updates. Sidebar active state moves with the click.
4. Close dialog and reopen → starts back on Conta (initialTab default).
5. On Aparência → toggle switch flips Light ↔ Dark across the whole app. The switch animates.
6. On Idioma → click EN → all visible strings (sidebar, content, user menu when reopened) switch.
7. On MCP → URL + bearer token appear; clipboard copy works (toast confirms).
8. On Plugins → centered "Em breve" placeholder, no interactive elements.
9. Esc / click outside dialog → closes normally.
10. No regression in AccountForm Save flow (edit display name, save, see toast).

## 8. Risks

- **`McpConfigDialog.tsx` left on disk**: it's no longer imported by any component, but the file remains. Dead-code-friendly — TypeScript won't complain, build won't include it. Follow-up commit deletes it.
- **i18n orphan keys** (`user_menu.plugins`, `user_menu.dark_mode`, `user_menu.language`): low impact; leave them or delete in the same follow-up cleanup.
- **AccountForm still has its internal "Conta" heading**: visually we now show "Conta" twice (sidebar tab label + AccountForm's own heading). Acceptable for v1; polish later by passing a `showHeading={false}` prop to AccountForm or by deleting its heading.
- **Tab state lost on dialog close**: by design — reopens on `initialTab` (Conta). If the user wants persistent tab memory, that's a future enhancement; it's not asked for here.

## 9. Future hooks

- `initialTab` prop on `SettingsDialog` already exists so future call sites can deep-link to a specific tab (e.g., a "Configure MCP →" link from a banner could pass `initialTab="mcp"`).
- Adding new tabs is a 3-line change in `SettingsSideNav` (add to the array) + 1 line in `SettingsDialog`'s switch + a new file under `tabs/`.
- The "Sobre" / About tab (app version, updater status, links) is the most likely next addition once the silent auto-update check is wired up.
