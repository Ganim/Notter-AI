import { describe, it, expect, vi, beforeEach } from 'vitest';

const fs = vi.hoisted(() => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => fs);
vi.mock('../paths', () => ({
  cursorConfigPath: async () => '/tmp/cursor-mcp.json',
}));
vi.mock('@tauri-apps/api/path', () => ({
  dirname: async (p: string) => p.substring(0, p.lastIndexOf('/')),
}));

import { cursorProvider } from '../cursor';
import { entryKey } from '..';

describe('cursorProvider', () => {
  beforeEach(() => {
    fs.exists.mockReset(); fs.readTextFile.mockReset();
    fs.writeTextFile.mockReset(); fs.mkdir.mockReset();
  });

  it('detect returns installed when config file already exists', async () => {
    fs.exists.mockResolvedValue(true);
    expect(await cursorProvider.detect()).toBe('installed');
  });

  it('install creates mcpServers entry under existing config', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(JSON.stringify({ other: 1, mcpServers: { existing: {} } }, null, 2));
    await cursorProvider.install('g', 'http://x/mcp');
    expect(fs.writeTextFile).toHaveBeenCalled();
    const written = JSON.parse((fs.writeTextFile.mock.calls[0][1]) as string);
    expect(written.other).toBe(1);
    expect(written.mcpServers.existing).toEqual({});
    expect(written.mcpServers[entryKey('g')]).toEqual({ url: 'http://x/mcp' });
  });

  it('install creates fresh config when file missing', async () => {
    fs.exists.mockResolvedValueOnce(false); // first exists call: file missing
    fs.exists.mockResolvedValueOnce(false); // second: dir missing
    await cursorProvider.install('g', 'http://x/mcp');
    expect(fs.mkdir).toHaveBeenCalled();
    const written = JSON.parse((fs.writeTextFile.mock.calls[0][1]) as string);
    expect(written.mcpServers[entryKey('g')]).toEqual({ url: 'http://x/mcp' });
  });

  it('uninstall removes the entry but keeps siblings', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(JSON.stringify({
      mcpServers: { [entryKey('g')]: { url: 'x' }, other: {} }
    }));
    await cursorProvider.uninstall('g');
    const written = JSON.parse((fs.writeTextFile.mock.calls[0][1]) as string);
    expect(written.mcpServers[entryKey('g')]).toBeUndefined();
    expect(written.mcpServers.other).toEqual({});
  });

  it('isLinked returns true when our entry exists', async () => {
    fs.exists.mockResolvedValue(true);
    fs.readTextFile.mockResolvedValue(JSON.stringify({ mcpServers: { [entryKey('g')]: {} } }));
    expect(await cursorProvider.isLinked('g')).toBe(true);
  });
});
