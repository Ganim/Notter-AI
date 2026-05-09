import { invoke } from '@tauri-apps/api/core';

export async function secureSet(key: string, value: string): Promise<void> {
  await invoke('secure_set', { key, value });
}

export async function secureGet(key: string): Promise<string | null> {
  const res = await invoke<{ key: string; value: string | null }>('secure_get', { key });
  return res.value;
}

export async function secureDelete(key: string): Promise<void> {
  await invoke('secure_delete', { key });
}

export async function secureRegisterKnownKeys(keys: string[]): Promise<void> {
  await invoke('secure_register_known_keys', { keys });
}

export const accountKeys = {
  refreshToken: (accountId: string) => `notter:account:${accountId}:refresh_token`,
  mcpToken:     (accountId: string) => `notter:account:${accountId}:mcp_token`,
};
