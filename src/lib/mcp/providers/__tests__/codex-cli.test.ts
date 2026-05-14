import { describe, it, expect, vi, beforeEach } from 'vitest';

const fs = vi.hoisted(() => ({
  exists: vi.fn(), readTextFile: vi.fn(), writeTextFile: vi.fn(), mkdir: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('../paths', () => ({ codexConfigPath: async () => '/tmp/codex.toml' }));
vi.mock('@tauri-apps/api/path', () => ({
  dirname: async (p: string) => p.substring(0, p.lastIndexOf('/')),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: () => ({ execute: async () => ({ code: 1, stdout: '', stderr: '' }) }) },
}));

import { codexCliProvider } from '../codex-cli';
import { entryKey } from '..';

describe('codexCliProvider', () => {
  beforeEach(() => {
    fs.exists.mockReset(); fs.readTextFile.mockReset();
    fs.writeTextFile.mockReset(); fs.mkdir.mockReset();
  });

  it('install writes mcp_servers section with http transport', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue('[other]\nkey = "val"\n');
    await codexCliProvider.install('g', 'http://x/mcp');
    const written = fs.writeTextFile.mock.calls[0][1] as string;
    expect(written).toContain('[other]');
    // @iarna/toml outputs bare keys for hyphens (valid TOML); match either form
    expect(written).toMatch(new RegExp(`\\[mcp_servers\\.("?)${entryKey('g')}\\1\\]`));
    expect(written).toContain('transport = "http"');
    expect(written).toContain('url = "http://x/mcp"');
  });

  it('uninstall removes the section', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(
      `[mcp_servers.${entryKey('g')}]\ntransport = "http"\nurl = "x"\n[other]\nkey = "v"\n`
    );
    await codexCliProvider.uninstall('g');
    const written = fs.writeTextFile.mock.calls[0][1] as string;
    expect(written).not.toContain(entryKey('g'));
    expect(written).toContain('[other]');
  });
});
