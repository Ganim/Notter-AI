// src/lib/accounts/account-storage.ts
import {
  BaseDirectory, readTextFile, writeTextFile, exists, mkdir, rename,
} from '@tauri-apps/plugin-fs';
import type { AccountIndex, ActiveAccountPointer } from './types';

const ROOT = 'notter-ai';
const INDEX_PATH = `${ROOT}/accounts/index.json`;
const ACTIVE_PATH = `${ROOT}/accounts/active.json`;

async function ensureAccountsDir(): Promise<void> {
  if (!(await exists(`${ROOT}/accounts`, { baseDir: BaseDirectory.AppLocalData }))) {
    await mkdir(`${ROOT}/accounts`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await ensureAccountsDir();
  const tmp = `${path}.tmp`;
  await writeTextFile(tmp, content, { baseDir: BaseDirectory.AppLocalData });
  try {
    await rename(tmp, path, {
      oldPathBaseDir: BaseDirectory.AppLocalData,
      newPathBaseDir: BaseDirectory.AppLocalData,
    });
  } catch {
    // Windows occasionally refuses cross-handle rename; fall back to direct write.
    await writeTextFile(path, content, { baseDir: BaseDirectory.AppLocalData });
  }
}

export async function readAccountIndex(): Promise<AccountIndex> {
  if (!(await exists(INDEX_PATH, { baseDir: BaseDirectory.AppLocalData }))) {
    return { accounts: [] };
  }
  try {
    const raw = await readTextFile(INDEX_PATH, { baseDir: BaseDirectory.AppLocalData });
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.accounts)) return { accounts: [] };
    return parsed as AccountIndex;
  } catch (e) {
    console.error('[account-storage] failed to read index:', e);
    return { accounts: [] };
  }
}

export async function writeAccountIndex(idx: AccountIndex): Promise<void> {
  await atomicWrite(INDEX_PATH, JSON.stringify(idx, null, 2));
}

export async function readActiveAccount(): Promise<ActiveAccountPointer> {
  if (!(await exists(ACTIVE_PATH, { baseDir: BaseDirectory.AppLocalData }))) {
    return { accountId: null };
  }
  try {
    const raw = await readTextFile(ACTIVE_PATH, { baseDir: BaseDirectory.AppLocalData });
    const parsed = JSON.parse(raw);
    if (typeof parsed?.accountId !== 'string' && parsed?.accountId !== null) {
      return { accountId: null };
    }
    return parsed as ActiveAccountPointer;
  } catch (e) {
    console.error('[account-storage] failed to read active pointer:', e);
    return { accountId: null };
  }
}

export async function writeActiveAccount(p: ActiveAccountPointer): Promise<void> {
  await atomicWrite(ACTIVE_PATH, JSON.stringify(p, null, 2));
}
