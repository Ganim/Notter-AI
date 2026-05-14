// src/components/settings/tabs/AccountTab.tsx
//
// AccountForm renders its own "Conta" heading internally, so we don't add a
// second one here — keeps the visual hierarchy clean (sidebar label is the
// tab identifier, the in-content heading is the section title).
import { AccountForm } from '@/components/AccountForm';

export function AccountTab() {
  return (
    <div className="p-6">
      <AccountForm />
    </div>
  );
}
