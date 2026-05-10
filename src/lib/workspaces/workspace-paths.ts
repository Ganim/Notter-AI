// src/lib/workspaces/workspace-paths.ts
//
// One-level-deeper analogue of accountScopedPath / tryAccountScopedPath.
// Throwing form is used when an active workspace is required; the try-form
// returns null when either the account or workspace context is missing
// (e.g. during the brief window between sign-out and the next bootstrap).
//
// The leading-separator strip handles both POSIX (`/foo`) and Windows
// (`\foo`) prefixes — mirrors the regex in account-paths.ts so callers can
// hand us paths from any source without worrying about platform.

import { getAccountManager } from '@/lib/accounts/account-manager';
import { getWorkspaceManager } from './workspace-manager';

export function workspaceScopedPath(rel: string): string {
  const accountId = getAccountManager().activeAccountId;
  if (!accountId) throw new Error('workspaceScopedPath: no active account');
  const workspaceId = getWorkspaceManager().currentWorkspaceId;
  if (!workspaceId) throw new Error('workspaceScopedPath: no active workspace');
  const trimmed = rel.replace(/^[\\/]+/, '');
  return `notter-ai/${accountId}/${workspaceId}/${trimmed}`;
}

export function tryWorkspaceScopedPath(rel: string): string | null {
  const accountId = getAccountManager().activeAccountId;
  if (!accountId) return null;
  const workspaceId = getWorkspaceManager().currentWorkspaceId;
  if (!workspaceId) return null;
  const trimmed = rel.replace(/^[\\/]+/, '');
  return `notter-ai/${accountId}/${workspaceId}/${trimmed}`;
}
