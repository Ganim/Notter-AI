import { useTranslation } from 'react-i18next';
import { Check, ExternalLink } from 'lucide-react';
import { useAiStore } from '@/stores/ai-store';
import { CLOUD_PROVIDERS, type CloudProviderId } from '@/lib/ai-providers';
import { TestConnection } from './TestConnection';

interface Props {
  providerId: CloudProviderId;
}

export function CloudProviderPanel({ providerId }: Props) {
  const { t } = useTranslation();
  const preset = CLOUD_PROVIDERS.find((p) => p.id === providerId);
  const cloudConfigs = useAiStore((s) => s.cloudConfigs);
  const activeProviderId = useAiStore((s) => s.activeProviderId);
  const setActiveProvider = useAiStore((s) => s.setActiveProvider);
  const updateCloudConfig = useAiStore((s) => s.updateCloudConfig);

  if (!preset) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Unknown provider
      </div>
    );
  }

  const config = cloudConfigs[providerId];
  const isActive = activeProviderId === providerId;
  const hasKey = !!config.apiKey.trim();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <h2 className="text-base font-semibold">{preset.name}</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={`w-2 h-2 rounded-full ${
              isActive ? 'bg-emerald-500' : hasKey ? 'bg-sky-500' : 'bg-zinc-400'
            }`}
          />
          {isActive
            ? t('manage_ai.active_provider')
            : hasKey
            ? t('manage_ai.configured')
            : t('manage_ai.not_configured')}
        </span>
        <div className="flex-1" />
        {!isActive && (
          <button
            onClick={() => setActiveProvider(providerId)}
            disabled={!hasKey}
            className="h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('manage_ai.set_active')}
          </button>
        )}
        {isActive && (
          <span className="inline-flex items-center gap-1 h-7 px-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check size={14} /> {t('manage_ai.active_provider')}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* API Key */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold">{t('manage_ai.api_key')}</label>
            <a
              href={preset.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              {t('manage_ai.get_api_key')} <ExternalLink size={10} />
            </a>
          </div>
          <input
            type="password"
            value={config.apiKey}
            onChange={(e) => updateCloudConfig(providerId, { apiKey: e.target.value })}
            placeholder={preset.keyPlaceholder}
            className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground">{t('manage_ai.cloud_hint')}</p>
        </section>

        {/* Model */}
        <section className="space-y-2">
          <label className="text-sm font-semibold">{t('manage_ai.model')}</label>
          <input
            type="text"
            value={config.model}
            onChange={(e) => updateCloudConfig(providerId, { model: e.target.value })}
            placeholder={preset.defaultModel}
            className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm font-mono outline-none focus:ring-1 focus:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground">
            {t('manage_ai.model_default_hint', { model: preset.defaultModel })}
          </p>
        </section>

        <TestConnection />
      </div>
    </div>
  );
}
