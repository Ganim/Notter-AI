// src/components/settings/tabs/AccountTab.tsx
import { useTranslation } from 'react-i18next';
import { AccountForm } from '@/components/AccountForm';

export function AccountTab() {
  const { t } = useTranslation();
  return (
    <div className="p-6">
      <h2 className="text-base font-semibold text-foreground mb-4">{t('settings.tabs.account')}</h2>
      <AccountForm />
    </div>
  );
}
