// src/components/settings/tabs/AppearanceTab.tsx
import { useTranslation } from 'react-i18next';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

export function AppearanceTab() {
  const { t } = useTranslation();
  const darkMode = useAppStore((s) => s.darkMode);
  const setDarkMode = useAppStore((s) => s.setDarkMode);
  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-4">{t('settings.tabs.appearance')}</h2>
      <div className="flex items-center justify-between gap-4 py-3 border-t border-border">
        <div className="flex items-start gap-3">
          {darkMode
            ? <Moon size={18} className="text-muted-foreground mt-0.5" />
            : <Sun size={18} className="text-muted-foreground mt-0.5" />}
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">{t('settings.appearance.dark_mode')}</span>
            <span className="text-xs text-muted-foreground">{t('settings.appearance.dark_mode_hint')}</span>
          </div>
        </div>
        <button
          onClick={() => setDarkMode(!darkMode)}
          role="switch"
          aria-checked={darkMode}
          className={cn(
            'relative w-11 h-6 rounded-full transition-colors flex-shrink-0',
            darkMode ? 'bg-foreground/80' : 'bg-muted',
          )}
        >
          <span className={cn(
            'absolute top-0.5 w-5 h-5 rounded-full bg-background transition-transform',
            darkMode ? 'translate-x-[22px]' : 'translate-x-0.5',
          )} />
        </button>
      </div>
    </div>
  );
}
