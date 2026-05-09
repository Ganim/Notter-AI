import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Trash2, UserPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth-store';
import { getAccountManager } from '@/lib/accounts/account-manager';
import type { AccountSummary } from '@/lib/accounts/types';

interface AccountSwitcherProps {
  onAddAccount: () => void;
  onClose: () => void;
}

export function AccountSwitcher({ onAddAccount, onClose }: AccountSwitcherProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const mgr = getAccountManager();

  const [accounts, setAccounts] = useState<AccountSummary[]>(() => mgr.list());
  const [activeId, setActiveId] = useState<string | null>(() => mgr.activeAccountId);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  // Subscribe to AccountManager mutations. The earlier useEffect-on-user.id
  // was racy: user.id transitions on signInWithEmail BEFORE mgr.add finishes,
  // so the snapshot was stale until next sign-out/in. Subscribe fires AFTER
  // every add/remove/setActive/switch, guaranteeing fresh state.
  useEffect(() => {
    const sync = () => {
      setAccounts(mgr.list());
      setActiveId(mgr.activeAccountId);
    };
    sync(); // initial pull in case mounting after a mutation
    return mgr.subscribe(sync);
  }, [mgr]);
  void user; // user.id is observed implicitly via mgr.subscribe

  const handleSwitch = async (id: string) => {
    if (id === activeId || switchingId) return;
    setSwitchingId(id);
    try {
      await mgr.switchAccount(id);
      const account = mgr.get(id);
      toast.success(t('accounts.signed_in_as', { email: account?.email ?? id }));
      setActiveId(id);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('session expired') || msg.includes('refresh')) {
        toast.error(t('accounts.session_expired'));
      } else {
        toast.error(t('accounts.switch_failed'));
      }
    } finally {
      setSwitchingId(null);
    }
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm(t('accounts.confirm_remove'))) return;
    try {
      await mgr.remove(id);
      setAccounts(mgr.list());
    } catch {
      // active account removal is blocked by AccountManager; ignore silently
    }
  };

  if (accounts.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">{t('accounts.none')}</div>
    );
  }

  return (
    <div className="border-t border-border mt-1 pt-1">
      {accounts.map((account) => {
        const isActive = account.id === activeId;
        const isSwitching = switchingId === account.id;
        return (
          <div
            key={account.id}
            className="group flex items-center gap-2 px-3 py-1.5 hover:bg-muted transition-colors cursor-pointer"
            onClick={() => handleSwitch(account.id)}
          >
            <div className="w-4 flex-shrink-0">
              {isSwitching ? (
                <Loader2 size={12} className="animate-spin text-muted-foreground" />
              ) : isActive ? (
                <Check size={12} className="text-primary" />
              ) : null}
            </div>
            <span className={`flex-1 text-xs truncate ${isActive ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
              {account.email}
            </span>
            {!isActive && (
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); handleRemove(account.id); }}
                title={t('accounts.remove')}
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        );
      })}
      <button
        onClick={() => { onClose(); onAddAccount(); }}
        className="w-full flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <UserPlus size={12} />
        {t('accounts.add')}
      </button>
    </div>
  );
}
