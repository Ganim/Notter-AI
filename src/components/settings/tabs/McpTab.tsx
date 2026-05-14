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
