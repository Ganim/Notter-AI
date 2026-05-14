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

export function UserMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [subView, setSubView] = useState<'main' | 'accounts'>('main');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { darkMode, setDarkMode, language, setLanguage } = useAppStore();
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

  return (
    <>
      <div ref={menuRef} className="relative">
        <button
          onClick={() => setOpen(!open)}
          data-tauri-drag-region="false"
          className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <User size={16} />
          <span className="hidden sm:inline">{displayName || user?.email?.split('@')[0] || 'User'}</span>
        </button>

        {open && (
          <div
            className="absolute right-0 top-full mt-1 w-64 bg-popover border border-border rounded-md shadow-lg z-50 py-1"
            data-tauri-drag-region="false"
          >
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
      </div>

      {/* Auth Dialog */}
      <AuthDialog open={authDialogOpen} onOpenChange={setAuthDialogOpen} />

      {/* Add Account Dialog */}
      <AuthDialog open={addAccountOpen} onOpenChange={setAddAccountOpen} mode="add-account" />

      {/* MCP Config Dialog */}
      <McpConfigDialog open={mcpConfigOpen} onOpenChange={setMcpConfigOpen} />

      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('settings.title')}</DialogTitle>
          </DialogHeader>

          <div className="min-h-[420px]">
            <AccountForm />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
