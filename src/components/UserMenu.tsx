import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Puzzle, LogIn, LogOut, Globe, Moon, Sun, User, Download, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAppStore, TERMINAL_THEMES } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { AuthDialog } from '@/components/AuthDialog';
import { checkForUpdates, downloadAndInstall, type UpdateState } from '@/lib/updater';
import { toast } from 'sonner';

export function UserMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle' });
  const menuRef = useRef<HTMLDivElement>(null);
  const { darkMode, setDarkMode, language, setLanguage, terminalSettings, setTerminalSettings } = useAppStore();
  const { user, signOut } = useAuthStore();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
  };

  const toggleLanguage = () => {
    setLanguage(language === 'pt-BR' ? 'en' : 'pt-BR');
  };

  const openSettings = () => {
    setOpen(false);
    setSettingsOpen(true);
  };

  const openAuthDialog = () => {
    setOpen(false);
    setAuthDialogOpen(true);
  };

  const handleLogout = async () => {
    setOpen(false);
    await signOut();
    toast.success(t('auth.logout_success'));
  };

  const handleCheckUpdates = async () => {
    setOpen(false);
    setUpdateDialogOpen(true);
    setUpdateState({ kind: 'checking' });
    const result = await checkForUpdates();
    setUpdateState(result);
  };

  const handleInstallUpdate = async () => {
    if (updateState.kind !== 'available') return;
    await downloadAndInstall(updateState.update, setUpdateState);
  };

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <User size={16} />
          <span className="hidden sm:inline">{user?.email ? user.email.split('@')[0] : 'User'}</span>
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 w-56 bg-popover border border-border rounded-md shadow-lg z-50 py-1">
            {user && (
              <>
                <div className="px-3 py-2 text-xs text-muted-foreground truncate border-b border-border mb-1">
                  {t('auth.logged_in_as')} <span className="font-medium text-foreground">{user.email}</span>
                </div>
              </>
            )}

            <button onClick={openSettings} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
              <Settings size={14} />
              {t('user_menu.settings')}
            </button>
            <button onClick={handleCheckUpdates} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
              <Download size={14} />
              {t('user_menu.check_updates')}
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
          </div>
        )}
      </div>

      {/* Auth Dialog */}
      <AuthDialog open={authDialogOpen} onOpenChange={setAuthDialogOpen} />

      {/* Update Dialog */}
      <Dialog open={updateDialogOpen} onOpenChange={setUpdateDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('updater.title')}</DialogTitle>
          </DialogHeader>
          <div className="py-4 flex flex-col items-center gap-3 text-center">
            {updateState.kind === 'checking' && (
              <>
                <Loader2 size={32} className="animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t('updater.checking')}</p>
              </>
            )}
            {updateState.kind === 'up-to-date' && (
              <>
                <CheckCircle2 size={32} className="text-green-500" />
                <p className="text-sm">{t('updater.up_to_date')}</p>
                <p className="text-xs text-muted-foreground">v{updateState.current}</p>
              </>
            )}
            {updateState.kind === 'available' && (
              <>
                <Download size={32} className="text-primary" />
                <p className="text-sm font-medium">{t('updater.available')}</p>
                <p className="text-xs text-muted-foreground">
                  v{updateState.current} → <span className="text-foreground font-medium">v{updateState.next}</span>
                </p>
                <button
                  onClick={handleInstallUpdate}
                  className="mt-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
                >
                  {t('updater.install')}
                </button>
              </>
            )}
            {updateState.kind === 'downloading' && (
              <>
                <Loader2 size={32} className="animate-spin text-primary" />
                <p className="text-sm">{t('updater.downloading')} {updateState.progress}%</p>
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${updateState.progress}%` }} />
                </div>
              </>
            )}
            {updateState.kind === 'installing' && (
              <>
                <Loader2 size={32} className="animate-spin text-primary" />
                <p className="text-sm">{t('updater.installing')}</p>
              </>
            )}
            {updateState.kind === 'error' && (
              <>
                <AlertCircle size={32} className="text-destructive" />
                <p className="text-sm text-destructive">{t('updater.error')}</p>
                <p className="text-xs text-muted-foreground break-all">{updateState.message}</p>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.title')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-6">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-2">{t('settings.terminal')}</h3>

            {/* Theme */}
            <div className="space-y-2">
              <Label className="text-xs">{t('settings.theme')}</Label>
              <div className="grid grid-cols-4 gap-2">
                {TERMINAL_THEMES.map((theme) => (
                  <button
                    key={theme.name}
                    onClick={() => setTerminalSettings({ themeName: theme.name })}
                    className={`flex flex-col items-center gap-1 p-2 rounded-md border transition-colors ${terminalSettings.themeName === theme.name ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/50'}`}
                  >
                    <div className="w-full h-6 rounded-sm" style={{ backgroundColor: theme.background }} />
                    <span className="text-[10px] text-muted-foreground">{theme.name}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Font Family */}
            <div className="space-y-2">
              <Label className="text-xs">{t('settings.font')}</Label>
              <select
                value={terminalSettings.fontFamily}
                onChange={(e) => setTerminalSettings({ fontFamily: e.target.value })}
                className="w-full bg-background text-foreground border border-border rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="'Cascadia Code', 'Fira Code', 'Consolas', monospace">Cascadia Code</option>
                <option value="'Fira Code', 'Cascadia Code', 'Consolas', monospace">Fira Code</option>
                <option value="'JetBrains Mono', 'Fira Code', 'Consolas', monospace">JetBrains Mono</option>
                <option value="'Consolas', monospace">Consolas</option>
                <option value="'Courier New', monospace">Courier New</option>
                <option value="monospace">System Mono</option>
              </select>
            </div>

            {/* Font Size */}
            <div className="space-y-2">
              <Label className="text-xs">{t('settings.font_size')} — {terminalSettings.fontSize}px</Label>
              <input
                type="range"
                min={10}
                max={20}
                value={terminalSettings.fontSize}
                onChange={(e) => setTerminalSettings({ fontSize: parseInt(e.target.value) })}
                className="w-full accent-primary"
              />
            </div>

            {/* Ligatures */}
            <div className="flex items-center justify-between p-3 rounded-md border border-border bg-background">
              <div className="flex flex-col gap-0.5">
                <Label className="text-sm font-medium text-foreground">{t('settings.ligatures')}</Label>
                <span className="text-[11px] text-muted-foreground font-mono">{'=> -> != <='}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${terminalSettings.ligatures ? 'bg-green-500/20 text-green-500' : 'bg-muted text-muted-foreground'}`}>
                  {terminalSettings.ligatures ? 'ON' : 'OFF'}
                </span>
                <Switch
                  checked={terminalSettings.ligatures}
                  onCheckedChange={(val: boolean) => setTerminalSettings({ ligatures: val })}
                />
              </div>
            </div>

            {/* Preview */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Preview</Label>
              <div
                className="rounded-md p-3 border border-border"
                style={{
                  backgroundColor: (TERMINAL_THEMES.find((t) => t.name === terminalSettings.themeName) || TERMINAL_THEMES[0]).background,
                  color: (TERMINAL_THEMES.find((t) => t.name === terminalSettings.themeName) || TERMINAL_THEMES[0]).foreground,
                  fontFamily: terminalSettings.fontFamily,
                  fontSize: terminalSettings.fontSize,
                  fontVariantLigatures: terminalSettings.ligatures ? 'normal' : 'none',
                }}
              >
                <div>$ npm run dev</div>
                <div style={{ opacity: 0.6 }}>{'=> =>'} !== {'!=='} {'<='} {'>='}</div>
                <div>Server running on :3000</div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
