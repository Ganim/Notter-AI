// src/components/settings/tabs/LanguageTab.tsx
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

const LANGUAGES = [
  { id: 'pt-BR' as const, labelKey: 'settings.language.pt_BR' },
  { id: 'en'    as const, labelKey: 'settings.language.en' },
];

export function LanguageTab() {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-4">{t('settings.tabs.language')}</h2>
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
    </div>
  );
}
