import { useTranslation } from 'react-i18next';
import { Check, Download, Loader2, Trash2 } from 'lucide-react';
import type { BuiltinModel } from '@/lib/ai-models';
import { useAiStore, type PullProgress } from '@/stores/ai-store';

interface ModelCardProps {
  model: BuiltinModel;
}

export function ModelCard({ model }: ModelCardProps) {
  const { t } = useTranslation();
  const installed = useAiStore((s) => s.installedModels.includes(model.tag));
  const isActive = useAiStore(
    (s) => s.activeModelTag === model.tag && s.activeProviderId === 'ollama',
  );
  const progress = useAiStore((s) => s.pulling[model.tag]);
  const anyPulling = useAiStore((s) => Object.keys(s.pulling).length > 0);
  const pullModel = useAiStore((s) => s.pullModel);
  const removeModel = useAiStore((s) => s.removeModel);
  const setActiveModel = useAiStore((s) => s.setActiveModel);
  const setActiveProvider = useAiStore((s) => s.setActiveProvider);

  function handleSetDefault() {
    setActiveModel(model.tag);
    setActiveProvider('ollama');
  }

  function handleInstall() {
    pullModel(model.tag).catch((e) => console.error('pull failed', e));
  }

  function handleRemove() {
    if (
      !confirm(
        t('manage_ai.remove_confirm', { name: model.name, size: `${model.sizeGb} GB` }),
      )
    ) {
      return;
    }
    removeModel(model.tag).catch((e) => console.error('remove failed', e));
  }

  return (
    <div className="rounded-md border border-border p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground truncate">{model.name}</h4>
            {model.recommended && (
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                ★
              </span>
            )}
            {isActive && (
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                {t('manage_ai.default_badge')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{model.description}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{model.sizeGb} GB</p>
        </div>
      </div>

      {progress ? (
        <ProgressView progress={progress} />
      ) : installed ? (
        <div className="flex items-center gap-2">
          {!isActive ? (
            <button
              onClick={handleSetDefault}
              className="flex-1 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('manage_ai.set_default')}
            </button>
          ) : (
            <span className="flex-1 inline-flex items-center justify-center gap-1 h-8 text-xs text-emerald-600 dark:text-emerald-400">
              <Check size={14} /> {t('manage_ai.default_badge')}
            </span>
          )}
          <button
            onClick={handleRemove}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={t('manage_ai.remove')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : (
        <button
          onClick={handleInstall}
          disabled={anyPulling}
          className="h-8 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download size={14} /> {t('manage_ai.install')}
        </button>
      )}
    </div>
  );
}

function ProgressView({ progress }: { progress: PullProgress }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        <span className="truncate">
          {progress.status}
          {progress.layerLabel && ` · ${progress.layerLabel}`}
          {progress.percent > 0 && ` · ${progress.percent}%`}
        </span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}
