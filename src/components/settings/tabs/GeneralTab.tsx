// src/components/settings/tabs/GeneralTab.tsx
//
// Combined "Geral" tab: appearance toggle (dark mode), language selector,
// and updates section (current version + manual check + install).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, CheckCircle2, Download, AlertCircle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { checkForUpdates, downloadAndInstall, getCurrentVersion, type UpdateState } from '@/lib/updater';

const LANGUAGES = [
  { id: 'pt-BR' as const, labelKey: 'settings.language.pt_BR' },
  { id: 'en'    as const, labelKey: 'settings.language.en' },
];

export function GeneralTab() {
  const { t } = useTranslation();
  const darkMode = useAppStore((s) => s.darkMode);
  const setDarkMode = useAppStore((s) => s.setDarkMode);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);

  const [version, setVersion] = useState<string>('');
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    getCurrentVersion()
      .then((v) => { if (!cancelled) setVersion(v); })
      .catch(() => {/* leave version empty; UI degrades gracefully */});
    return () => { cancelled = true; };
  }, []);

  const handleCheck = async () => {
    setUpdateState({ kind: 'checking' });
    const r = await checkForUpdates();
    setUpdateState(r);
    if (r.kind === 'up-to-date') toast.success(t('updater.up_to_date'));
    if (r.kind === 'error') toast.error(t('updater.error'));
  };

  const handleInstall = async () => {
    if (updateState.kind !== 'available') return;
    await downloadAndInstall(updateState.update, setUpdateState);
  };

  return (
    <div className="p-6 space-y-8">
      {/* Tema */}
      <section>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('settings.theme.section')}</h3>
        <div
          role="radiogroup"
          aria-label={t('settings.theme.section')}
          className="inline-flex p-0.5 bg-muted rounded-md border border-border"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!darkMode}
            onClick={() => setDarkMode(false)}
            className={cn(
              'px-4 py-1.5 text-sm rounded-[5px] transition-colors',
              !darkMode
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('settings.theme.light')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={darkMode}
            onClick={() => setDarkMode(true)}
            className={cn(
              'px-4 py-1.5 text-sm rounded-[5px] transition-colors',
              darkMode
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('settings.theme.dark')}
          </button>
        </div>
      </section>

      {/* Idioma */}
      <section>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('settings.language.section')}</h3>
        <div className="border border-border rounded-md divide-y divide-border overflow-hidden">
          {LANGUAGES.map((l) => (
            <button
              key={l.id}
              onClick={() => setLanguage(l.id)}
              className={cn(
                'w-full flex items-center justify-between px-4 py-3 text-left transition-colors',
                language === l.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
              )}
            >
              <span className="text-sm">{t(l.labelKey)}</span>
              {language === l.id && <Check size={14} />}
            </button>
          ))}
        </div>
      </section>

      {/* Atualizações */}
      <section>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('settings.updates.section')}</h3>
        <div className="flex items-center justify-between gap-4 py-3 border-t border-border">
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {t('settings.updates.current_version')}
            </span>
            <span className="text-xs text-muted-foreground">
              {version ? `v${version}` : '…'}
            </span>
          </div>
          <button
            onClick={handleCheck}
            disabled={updateState.kind === 'checking' || updateState.kind === 'downloading' || updateState.kind === 'installing'}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {updateState.kind === 'checking'
              ? <Loader2 size={14} className="animate-spin" />
              : <RefreshCw size={14} />}
            {t('settings.updates.check_button')}
          </button>
        </div>

        {/* Inline state row (only shown when something non-idle is happening) */}
        {updateState.kind === 'up-to-date' && (
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            <CheckCircle2 size={14} className="text-green-500" />
            <span>{t('updater.up_to_date')}</span>
          </div>
        )}
        {updateState.kind === 'available' && (
          <div className="flex items-center justify-between gap-2 mt-2">
            <div className="flex items-center gap-2 text-sm">
              <Download size={14} className="text-primary" />
              <span>
                {t('updater.available')} — v{updateState.current} → <span className="font-medium">v{updateState.next}</span>
              </span>
            </div>
            <button
              onClick={handleInstall}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:bg-primary/90"
            >
              {t('updater.install')}
            </button>
          </div>
        )}
        {updateState.kind === 'downloading' && (
          <div className="mt-2 space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <Loader2 size={14} className="animate-spin text-primary" />
              <span>{t('updater.downloading')} {updateState.progress}%</span>
            </div>
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${updateState.progress}%` }}
              />
            </div>
          </div>
        )}
        {updateState.kind === 'installing' && (
          <div className="flex items-center gap-2 mt-2 text-xs">
            <Loader2 size={14} className="animate-spin text-primary" />
            <span>{t('updater.installing')}</span>
          </div>
        )}
        {updateState.kind === 'error' && (
          <div className="flex items-start gap-2 mt-2 text-xs">
            <AlertCircle size={14} className="text-destructive mt-0.5" />
            <div className="flex flex-col">
              <span className="text-destructive">{t('updater.error')}</span>
              <span className="text-muted-foreground break-all">{updateState.message}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
