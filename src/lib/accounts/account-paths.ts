import { getAccountManager } from './account-manager';

export function accountScopedPath(rel: string): string {
  const id = getAccountManager().activeAccountId;
  if (!id) throw new Error('accountScopedPath: no active account');
  const trimmed = rel.replace(/^[\\/]+/, '');
  return `notter-ai/${id}/${trimmed}`;
}

export function tryAccountScopedPath(rel: string): string | null {
  const id = getAccountManager().activeAccountId;
  if (!id) return null;
  const trimmed = rel.replace(/^[\\/]+/, '');
  return `notter-ai/${id}/${trimmed}`;
}
