import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Puzzle, LogIn, LogOut, Globe, Moon, Sun, User } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAppStore, TERMINAL_THEMES } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { AuthDialog } from '@/components/AuthDialog';
import { toast } from 'sonner';

export function UserMenu() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  const menuRef = useRef<HTMLDivElement>(null);
  const { terminalSettings, setTerminalSettings } = useAppStore();
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
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
  };

  const toggleLanguage = () => {
    const next = i18n.language === 'pt-BR' ? 'en' : 'pt-BR';
    i18n.changeLanguage(next);
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
                {isDark ? <Sun size={14} /> : <Moon size={14} />}
                {t('user_menu.dark_mode')}
              </span>
              <span className="text-xs text-muted-foreground">{isDark ? 'ON' : 'OFF'}</span>
            </button>

            <button
              onClick={toggleLanguage}
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
            >
              <span className="flex items-center gap-3">
                <Globe size={14} />
                {t('user_menu.language')}
              </span>
              <span className="text-xs text-muted-foreground">{i18n.language === 'pt-BR' ? 'PT' : 'EN'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Auth Dialog */}
      <AuthDialog open={authDialogOpen} onOpenChange={setAuthDialogOpen} />

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
