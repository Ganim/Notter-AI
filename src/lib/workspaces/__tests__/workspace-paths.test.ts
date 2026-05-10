// src/lib/workspaces/__tests__/workspace-paths.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock both managers — workspace-paths reads the active account from
// account-manager and the active workspace from workspace-manager.
vi.mock('@/lib/accounts/account-manager', () => ({
  getAccountManager: () => ({ activeAccountId: 'acc-1' }),
}));

vi.mock('@/lib/workspaces/workspace-manager', () => ({
  getWorkspaceManager: () => ({ currentWorkspaceId: 'ws-1' }),
}));

import { workspaceScopedPath, tryWorkspaceScopedPath } from '../workspace-paths';

describe('workspace-paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('joins account/workspace/rel', () => {
    expect(workspaceScopedPath('cache/plans.json')).toBe('notter-ai/acc-1/ws-1/cache/plans.json');
  });

  it('strips leading slashes', () => {
    expect(workspaceScopedPath('/cache/x')).toBe('notter-ai/acc-1/ws-1/cache/x');
    expect(workspaceScopedPath('\\cache\\x')).toBe('notter-ai/acc-1/ws-1/cache\\x');
  });

  it('tryWorkspaceScopedPath returns the same as workspaceScopedPath when active', () => {
    expect(tryWorkspaceScopedPath('exports/x.md')).toBe('notter-ai/acc-1/ws-1/exports/x.md');
  });
});
