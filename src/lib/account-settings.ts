// src/lib/account-settings.ts
import { supabase } from '@/lib/supabase';

export interface AccountSettings {
  theme: 'light' | 'dark' | 'system';
  language: 'pt-BR' | 'en-US';
  update_settings: { auto_check: boolean; auto_install: boolean };
  default_workspace_id: string | null;
}

const DEFAULTS: AccountSettings = {
  theme: 'system',
  language: 'pt-BR',
  update_settings: { auto_check: true, auto_install: false },
  default_workspace_id: null,
};

export async function readAccountSettings(): Promise<AccountSettings> {
  const { data } = await supabase.auth.getUser();
  const blob = (data?.user?.user_metadata as any)?.notter ?? {};
  return {
    ...DEFAULTS,
    ...blob,
    update_settings: { ...DEFAULTS.update_settings, ...(blob.update_settings ?? {}) },
  };
}

export async function writeAccountSettings(patch: Partial<AccountSettings>): Promise<void> {
  const current = await readAccountSettings();
  const merged: AccountSettings = {
    ...current,
    ...patch,
    update_settings: { ...current.update_settings, ...(patch.update_settings ?? {}) },
  };
  await supabase.auth.updateUser({ data: { notter: merged } });
}

const LEGACY_KEYS = {
  theme: 'notter-theme',
  language: 'notter-language',
  autoCheck: 'notter-update-auto-check',
  autoInstall: 'notter-update-auto-install',
};

export async function migrateFromLocalStorageOnce(): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const existing = (data?.user?.user_metadata as any)?.notter;
  if (existing && Object.keys(existing).length > 0) return; // already migrated

  const theme = localStorage.getItem(LEGACY_KEYS.theme) as AccountSettings['theme'] | null;
  const language = localStorage.getItem(LEGACY_KEYS.language) as AccountSettings['language'] | null;
  const autoCheck = localStorage.getItem(LEGACY_KEYS.autoCheck);
  const autoInstall = localStorage.getItem(LEGACY_KEYS.autoInstall);

  const patch: Partial<AccountSettings> = {};
  if (theme) patch.theme = theme;
  if (language) patch.language = language;
  if (autoCheck !== null || autoInstall !== null) {
    patch.update_settings = {
      auto_check: autoCheck === null ? DEFAULTS.update_settings.auto_check : autoCheck === 'true',
      auto_install: autoInstall === null ? DEFAULTS.update_settings.auto_install : autoInstall === 'true',
    };
  }

  await writeAccountSettings(patch);
  for (const k of Object.values(LEGACY_KEYS)) localStorage.removeItem(k);
}
