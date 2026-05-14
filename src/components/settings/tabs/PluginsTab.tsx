// src/components/settings/tabs/PluginsTab.tsx
import { useTranslation } from 'react-i18next';
import { Puzzle } from 'lucide-react';

export function PluginsTab() {
  const { t } = useTranslation();
  return (
    <div className="p-6 h-full flex flex-col items-center justify-center text-center">
      <Puzzle size={32} className="text-muted-foreground/60 mb-3" />
      <h2 className="text-base font-semibold text-foreground mb-1">{t('settings.tabs.plugins')}</h2>
      <p className="text-sm text-muted-foreground">{t('settings.plugins.coming_soon')}</p>
    </div>
  );
}
