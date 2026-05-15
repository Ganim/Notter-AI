import { describe, it, expect, vi, beforeEach } from 'vitest';

const { commandMock } = vi.hoisted(() => ({
  commandMock: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: commandMock },
}));

import { claudeCodeProvider } from '../claude-code';
import { entryKey } from '..';

describe('claudeCodeProvider', () => {
  beforeEach(() => commandMock.mockReset());

  it('detect returns installed when `claude --version` succeeds', async () => {
    commandMock.mockReturnValue({ execute: async () => ({ code: 0, stdout: 'claude 0.5.0', stderr: '' }) });
    const status = await claudeCodeProvider.detect();
    expect(status).toBe('installed');
    expect(commandMock).toHaveBeenCalledWith('claude', ['--version']);
  });

  it('detect returns missing when exit code is non-zero', async () => {
    commandMock.mockReturnValue({ execute: async () => ({ code: 127, stdout: '', stderr: 'not found' }) });
    expect(await claudeCodeProvider.detect()).toBe('missing');
  });

  it('install runs claude mcp add with --scope user + computed entry name + URL', async () => {
    const execMock = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    commandMock.mockReturnValue({ execute: execMock });
    await claudeCodeProvider.install('guilherme', 'http://127.0.0.1:54781/mcp');
    expect(commandMock).toHaveBeenCalledWith('claude', [
      'mcp', 'add', '--scope', 'user', '--transport', 'http',
      entryKey('guilherme'),
      'http://127.0.0.1:54781/mcp',
    ]);
  });

  it('uninstall runs claude mcp remove with --scope user + entry name', async () => {
    const execMock = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    commandMock.mockReturnValue({ execute: execMock });
    await claudeCodeProvider.uninstall('guilherme');
    expect(commandMock).toHaveBeenCalledWith('claude', ['mcp','remove','--scope','user', entryKey('guilherme')]);
  });
});
