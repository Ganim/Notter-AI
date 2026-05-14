// src/components/settings/tabs/McpTab.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth-store';
import { PROVIDERS, accountSlug } from '@/lib/mcp/providers';
import { getMcpBaseUrl } from '@/lib/mcp/oauth-url';
import { McpProviderCard } from '@/components/settings/McpProviderCard';
import { McpManualSection } from '@/components/settings/McpManualSection';

export function McpTab() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMcpBaseUrl().then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, []);

  if (!user) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">{t('mcp.disabled_banner')}</p>
      </div>
    );
  }

  const slug = accountSlug(user.email ?? user.id);

  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">{t('settings.tabs.mcp')}</h2>
      <p className="text-xs text-muted-foreground mb-4">{t('mcp.providers.title')}</p>
      <div>
        {PROVIDERS.map((p) => (
          <McpProviderCard key={p.id} provider={p} accountSlug={slug} mcpUrl={url} />
        ))}
      </div>
      <McpManualSection mcpUrl={url} />
    </div>
  );
}
