import { useTranslation } from 'react-i18next';
import { ExternalLink, Check } from 'lucide-react';
import { useAiStore } from '@/stores/ai-store';
import { CLOUD_PROVIDERS, type CloudProviderId } from '@/lib/ai-providers';

export function CloudProvidersSection() {
  const { t } = useTranslation();
  const cloudConfigs = useAiStore((s) => s.cloudConfigs);
  const activeProviderId = useAiStore((s) => s.activeProviderId);
  const setActiveProvider = useAiStore((s) => s.setActiveProvider);
  const updateCloudConfig = useAiStore((s) => s.updateCloudConfig);

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{t('manage_ai.cloud_providers')}</h3>
        <p className="text-[11px] text-muted-foreground">{t('manage_ai.cloud_hint')}</p>
      </div>

      {CLOUD_PROVIDERS.map((preset) => {
        const config = cloudConfigs[preset.id as CloudProviderId];
        const isActive = activeProviderId === preset.id;
        return (
          <div
            key={preset.id}
            className={`rounded-md border p-3 space-y-2 ${
              isActive ? 'border-primary/60 bg-primary/5' : 'border-border'
            }`}
          >
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium flex-1">{preset.name}</h4>
              <a
                href={preset.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                {t('manage_ai.get_api_key')} <ExternalLink size={10} />
              </a>
            </div>
            <div className="grid grid-cols-[1fr_140px] gap-2">
              <input
                type="password"
                value={config.apiKey}
                onChange={(e) => updateCloudConfig(preset.id, { apiKey: e.target.value })}
                placeholder={preset.keyPlaceholder}
                className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                type="text"
                value={config.model}
                onChange={(e) => updateCloudConfig(preset.id, { model: e.target.value })}
                placeholder="Model"
                className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            {isActive ? (
              <div className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                <Check size={12} /> {t('manage_ai.active_provider')}
              </div>
            ) : (
              <button
                onClick={() => setActiveProvider(preset.id)}
                disabled={!config.apiKey.trim()}
                className="h-6 px-2 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t('manage_ai.set_active')}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
