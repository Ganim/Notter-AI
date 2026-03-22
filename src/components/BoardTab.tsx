import { useTranslation } from 'react-i18next';
import { LayoutDashboard } from 'lucide-react';

export function BoardTab() {
  const { t } = useTranslation();

  return (
    <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
      <LayoutDashboard size={48} className="opacity-20" />
      <h2 className="text-lg font-semibold">{t('board.coming_soon')}</h2>
      <p className="text-sm max-w-md text-center">{t('board.description')}</p>
    </div>
  );
}
