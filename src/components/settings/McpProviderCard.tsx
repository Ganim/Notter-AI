// src/components/settings/McpProviderCard.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { McpInstallProvider, DetectStatus } from '@/lib/mcp/providers';

interface Props {
  provider: McpInstallProvider;
  accountSlug: string;
  mcpUrl: string | null;
}

export function McpProviderCard({ provider, accountSlug, mcpUrl }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DetectStatus>('unknown');
  const [linked, setLinked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await provider.detect();
      const l = await provider.isLinked(accountSlug);
      if (!cancelled) { setStatus(s); setLinked(l); }
    })();
    return () => { cancelled = true; };
  }, [provider, accountSlug]);

  const onConnect = async () => {
    if (!mcpUrl) { toast.error(t('mcp.no_url')); return; }
    setBusy(true);
    try {
      await provider.install(accountSlug, mcpUrl);
      setLinked(true);
      toast.success(t('mcp.providers.connected', { name: provider.label }));
    } catch (e: any) {
      toast.error(`${provider.label}: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  const onDisconnect = async () => {
    setBusy(true);
    try {
      await provider.uninstall(accountSlug);
      setLinked(false);
      toast.success(t('mcp.providers.disconnected', { name: provider.label }));
    } catch (e: any) {
      toast.error(`${provider.label}: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  const badge =
    status === 'installed' ? t('mcp.providers.detected') :
    status === 'missing'   ? t('mcp.providers.not_detected') :
                              '';

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{provider.label}</div>
        <div className="text-xs text-muted-foreground">{badge}</div>
      </div>
      {linked ? (
        <button
          onClick={onDisconnect}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted disabled:opacity-50"
        >
          {t('mcp.providers.disconnect')}
        </button>
      ) : (
        <button
          onClick={onConnect}
          disabled={busy || status === 'missing'}
          title={status === 'missing' ? t('mcp.providers.install_first', { name: provider.label }) : ''}
          className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('mcp.providers.connect')}
        </button>
      )}
    </div>
  );
}
