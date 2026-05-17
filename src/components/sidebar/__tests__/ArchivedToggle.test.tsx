import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArchivedToggle } from '@/components/sidebar/ArchivedToggle';
import { usePlannerStore } from '@/stores/planner-store';
import { useWorkspacesStore } from '@/stores/workspaces-store';

// --- Module mocks (must come before any imports that trigger side effects) ---

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
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
  genUniqueTag: vi.fn().mockResolvedValue('tag'),
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
});

describe('ArchivedToggle', () => {
  it('renders nothing in active mode with no archived projects', () => {
    usePlannerStore.setState({
      allProjects: [{ name: 'flow', path: '/', workspaceId: ws, tag: 'flow', nextSubjectSeq: 1, archivedAt: null }],
      searchMode: 'active',
    } as any);
    const { container } = render(<ArchivedToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders footer with count in active mode when archived projects exist', () => {
    usePlannerStore.setState({
      allProjects: [
        { name: 'flow', path: '/', workspaceId: ws, tag: 'flow', nextSubjectSeq: 1, archivedAt: null },
        { name: 'old', path: '/', workspaceId: ws, tag: 'old', nextSubjectSeq: 1, archivedAt: '2026-05-01' },
      ],
      searchMode: 'active',
    } as any);
    render(<ArchivedToggle />);
    expect(screen.getByText(/archive\.footer_label.*"count":1/)).toBeInTheDocument();
  });

  it('renders back button in archived mode', () => {
    usePlannerStore.setState({
      allProjects: [],
      searchMode: 'archived',
    } as any);
    render(<ArchivedToggle />);
    expect(screen.getByText('archive.header_back')).toBeInTheDocument();
  });

  it('clicking back in archived mode switches to active', () => {
    usePlannerStore.setState({
      allProjects: [],
      searchMode: 'archived',
    } as any);
    render(<ArchivedToggle />);
    fireEvent.click(screen.getByText('archive.header_back'));
    expect(usePlannerStore.getState().searchMode).toBe('active');
  });
});
