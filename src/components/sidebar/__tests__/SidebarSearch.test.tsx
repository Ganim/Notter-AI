import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarSearch } from '@/components/sidebar/SidebarSearch';
import { usePlannerStore } from '@/stores/planner-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';

// --- Module mocks (must come before any imports that trigger side effects) ---

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppLocalData: 'AppLocalData' },
  readDir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue(''),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(true),
  remove: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/sync', () => ({
  pushProjects: vi.fn().mockResolvedValue(undefined),
  pushSubject: vi.fn().mockResolvedValue(undefined),
  deleteRemoteSubject: vi.fn().mockResolvedValue(undefined),
  deleteRemoteSubjectsByProject: vi.fn().mockResolvedValue(undefined),
  renameRemoteSubjectsProject: vi.fn().mockResolvedValue(undefined),
  updateProjectWorkspace: vi.fn().mockResolvedValue(undefined),
  commitSubjectVersion: vi.fn().mockResolvedValue('v-new'),
  renameSubjectInPlace: vi.fn().mockResolvedValue({ ok: true }),
  fetchSubjectVersions: vi.fn().mockResolvedValue([]),
  archiveProject: vi.fn().mockResolvedValue({ ok: true }),
  unarchiveProject: vi.fn().mockResolvedValue({ ok: true }),
  updateProjectTag: vi.fn().mockResolvedValue({ ok: true }),
  pushPreferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/synced-store', () => ({
  deleteUserRow: vi.fn().mockResolvedValue(undefined),
  makeDebouncedSync: vi.fn(() => ({
    schedule: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
  syncOnLogin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/subject-versions-store', () => ({
  useSubjectVersionsStore: {
    getState: () => ({
      loadForSubject: vi.fn(),
      clearSubject: vi.fn(),
    }),
  },
}));

vi.mock('@/lib/accounts/store-registry', () => ({
  registerResettableStore: vi.fn(),
}));

vi.mock('@/lib/accounts/account-paths', () => ({
  accountScopedPath: vi.fn((p: string) => p),
  tryAccountScopedPath: vi.fn((p: string) => p),
}));

vi.mock('@/lib/accounts/safe-fs-name', () => ({
  safeFsName: vi.fn((s: string) => s),
  unsafeFsName: vi.fn((s: string) => s),
}));

// --- Test data ---

const ws = '00000000-0000-0000-0000-0000000000ws';

beforeEach(() => {
  useWorkspacesStore.setState({
    currentWorkspaceId: ws,
    workspaces: [{ id: ws, name: 'Test', isDefault: true, currentRole: 'owner', memberCount: 1 } as any],
  } as any);
  usePlannerStore.setState({
    allProjects: [{ name: 'flow', path: '/f', workspaceId: ws, tag: 'flow', nextSubjectSeq: 4, archivedAt: null }],
    subjectRows: [
      { id: 'a', projectName: 'flow', fileName: 'login.md', content: '', currentVersionId: null, seq: 1, archivedAt: null },
      { id: 'b', projectName: 'flow', fileName: 'reset.md', content: '', currentVersionId: null, seq: 3, archivedAt: null },
    ],
    searchQuery: '',
    searchMode: 'active',
  } as any);
});

describe('SidebarSearch', () => {
  it('typing filters subject hits by file name', () => {
    const onJump = vi.fn();
    render(<SidebarSearch onJumpSubject={onJump} />);
    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'login' } });
    expect(screen.getByText('login.md')).toBeInTheDocument();
  });

  it('clicking a hit fires onJumpSubject and clears the query', () => {
    const onJump = vi.fn();
    render(<SidebarSearch onJumpSubject={onJump} />);
    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'login' } });
    fireEvent.click(screen.getByText('login.md'));
    expect(onJump).toHaveBeenCalledWith('flow', 'login.md');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('shows "open flow-3 →" CTA on exact identifier match', () => {
    render(<SidebarSearch onJumpSubject={() => {}} />);
    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'flow-3' } });
    // The CTA renders the i18n key with the id interpolation
    expect(screen.getByText(/search\.open_identifier.*flow-3/)).toBeInTheDocument();
  });

  it('shows "not found" CTA when identifier shape matches but no subject exists', () => {
    render(<SidebarSearch onJumpSubject={() => {}} />);
    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'flow-99' } });
    expect(screen.getByText(/search\.identifier_not_found.*flow-99/)).toBeInTheDocument();
  });

  it('Enter on exact match fires onJumpSubject', () => {
    const onJump = vi.fn();
    render(<SidebarSearch onJumpSubject={onJump} />);
    const input = screen.getByPlaceholderText('search.placeholder');
    fireEvent.change(input, { target: { value: 'flow-3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onJump).toHaveBeenCalledWith('flow', 'reset.md');
  });
});
