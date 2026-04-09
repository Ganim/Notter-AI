import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  exists: vi.fn(async () => true),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn(async () => 'C:/appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

import {
  buildMcpConfigJson,
  writeMcpConfigFile,
} from '@/lib/executor/mcp-config';

describe('buildMcpConfigJson', () => {
  it('returns the expected mcpServers shape', () => {
    const json = buildMcpConfigJson({
      serverAbsolutePath: 'D:/repo/notter-mcp-server/dist/server.js',
      actionId: 'act-1',
      stateDir: 'C:/appdata/exec-state',
    });
    expect(json).toEqual({
      mcpServers: {
        notter: {
          command: 'node',
          args: [
            'D:/repo/notter-mcp-server/dist/server.js',
            '--action-id',
            'act-1',
            '--state-dir',
            'C:/appdata/exec-state',
          ],
          env: {},
        },
      },
    });
  });
});

describe('writeMcpConfigFile', () => {
  it('resolves a path under $APPLOCALDATA/exec-state/', async () => {
    const p = await writeMcpConfigFile({
      actionId: 'act-2',
      serverAbsolutePath: 'D:/repo/notter-mcp-server/dist/server.js',
      stateDir: 'C:/appdata/exec-state',
    });
    expect(p).toMatch(/mcp-config-act-2\.json$/);
  });
});
