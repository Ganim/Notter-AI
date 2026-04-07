import { useTranslation } from 'react-i18next';
import { Download, Play, AlertCircle } from 'lucide-react';
import { useAiStore } from '@/stores/ai-store';
import { BUILTIN_MODELS } from '@/lib/ai-models';
import { ModelCard } from './ModelCard';
import { TestConnection } from './TestConnection';
import { CloudProvidersSection } from './CloudProvidersSection';

export function OllamaPanel() {
  const { t } = useTranslation();
  const status = useAiStore((s) => s.ollamaStatus);
  const installingOllama = useAiStore((s) => s.installingOllama);
  const installOllama = useAiStore((s) => s.installOllama);
  const startOllamaService = useAiStore((s) => s.startOllamaService);

  function statusLabel() {
    switch (status) {
      case 'unknown':
        return t('manage_ai.status_unknown');
      case 'not-installed':
        return t('manage_ai.status_not_installed');
      case 'stopped':
        return t('manage_ai.status_stopped');
      case 'running':
        return t('manage_ai.status_running');
    }
  }

  function statusDotClass() {
    switch (status) {
      case 'running':
        return 'bg-emerald-500';
      case 'stopped':
        return 'bg-amber-500';
      case 'not-installed':
        return 'bg-zinc-400';
      default:
        return 'bg-zinc-300';
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <h2 className="text-base font-semibold">Ollama</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`w-2 h-2 rounded-full ${statusDotClass()}`} />
          {statusLabel()}
        </span>
        <div className="flex-1" />
        {status === 'not-installed' && (
          <button
            onClick={() => installOllama().catch((e) => console.error(e))}
            disabled={!!installingOllama}
            className="flex items-center gap-1.5 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Download size={14} /> {t('manage_ai.install_ollama')}
          </button>
        )}
        {status === 'stopped' && (
          <button
            onClick={() => startOllamaService().catch((e) => console.error(e))}
            className="flex items-center gap-1.5 h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Play size={14} /> {t('manage_ai.start_ollama')}
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {installingOllama && (
          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              {installingOllama.total > 0
                ? t('manage_ai.downloading', {
                    downloaded: formatBytes(installingOllama.downloaded),
                    total: formatBytes(installingOllama.total),
                  })
                : t('manage_ai.installing_ollama')}
            </p>
            {installingOllama.total > 0 && (
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width: `${(installingOllama.downloaded / installingOllama.total) * 100}%`,
                  }}
                />
              </div>
            )}
          </div>
        )}

        {status === 'not-installed' && !installingOllama && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2">
            <AlertCircle size={14} className="text-amber-600 dark:text-amber-400 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              Ollama is not installed. Click "Install Ollama" above to download and install it
              automatically. The installer runs silently — no popup windows.
            </p>
          </div>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('manage_ai.models')}</h3>
          <div className="space-y-2">
            {BUILTIN_MODELS.map((m) => (
              <ModelCard key={m.id} model={m} />
            ))}
          </div>
        </section>

        <TestConnection />

        <CloudProvidersSection />
      </div>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
