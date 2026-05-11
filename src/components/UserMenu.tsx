import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Puzzle, LogIn, LogOut, Globe, Moon, Sun, User, Download, Loader2, CheckCircle2, AlertCircle, Brain, Network } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAppStore } from '@/stores/app-store';
import { useAuthStore } from '@/stores/auth-store';
import { AuthDialog } from '@/components/AuthDialog';
import { AccountForm } from '@/components/AccountForm';
import { AccountSwitcher } from '@/components/AccountSwitcher';
import { ManageAiDialog } from '@/components/ai/ManageAiDialog';
import { McpConfigDialog } from '@/components/McpConfigDialog';
import { checkForUpdates, downloadAndInstall, type UpdateState } from '@/lib/updater';
import { toast } from 'sonner';

export function UserMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle' });
  const [manageAiOpen, setManageAiOpen] = useState(false);
  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { darkMode, setDarkMode, language, setLanguage } = useAppStore();
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

  const openManageAi = () => {
    setOpen(false);
    setManageAiOpen(true);
  };

  const openMcpConfig = () => {
    setOpen(false);
    setMcpConfigOpen(true);
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
                <AccountSwitcher
                  onAddAccount={() => setAddAccountOpen(true)}
                  onClose={() => setOpen(false)}
                />
                <button
                  onClick={openMcpConfig}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                >
                  <Network size={14} />
                  {t('mcp.menu_label')}
                </button>
              </>
            )}

            <button onClick={openSettings} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
              <Settings size={14} />
              {t('user_menu.settings')}
            </button>
            <button onClick={openManageAi} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors">
              <Brain size={14} />
              {t('user_menu.manage_ai')}
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

      {/* Add Account Dialog */}
      <AuthDialog open={addAccountOpen} onOpenChange={setAddAccountOpen} mode="add-account" />

      {/* Manage AI Dialog */}
      <ManageAiDialog open={manageAiOpen} onOpenChange={setManageAiOpen} />

      {/* MCP Config Dialog */}
      <McpConfigDialog open={mcpConfigOpen} onOpenChange={setMcpConfigOpen} />

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
