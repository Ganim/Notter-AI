// src/lib/mcp/providers/claude-code.ts
import { Command } from '@tauri-apps/plugin-shell';
import { entryKey, type McpInstallProvider } from '.';

/** Returns true only when the process exited with code 0 (not signaled). */
const ok = (res: { code: number | null }): boolean => res.code === 0;

async function runClaude(args: string[]) {
  const cmd = Command.create('claude', args);
  return await cmd.execute();
}

export const claudeCodeProvider: McpInstallProvider = {
  id: 'claude-code',
  label: 'Claude Code (CLI)',

  async detect() {
    try {
      const res = await runClaude(['--version']);
      return ok(res) ? 'installed' : 'missing';
    } catch {
      return 'missing';
    }
  },

  async install(slug, mcpUrl) {
    const res = await runClaude(['mcp', 'add', entryKey(slug), mcpUrl, '--transport', 'http']);
    if (!ok(res)) {
      throw new Error(`claude mcp add failed: ${res.stderr || res.stdout}`);
    }
  },

  async uninstall(slug) {
    const res = await runClaude(['mcp', 'remove', entryKey(slug)]);
    if (!ok(res)) {
      throw new Error(`claude mcp remove failed: ${res.stderr || res.stdout}`);
    }
  },

  async isLinked(slug) {
    try {
      const res = await runClaude(['mcp', 'list']);
      return ok(res) && res.stdout.includes(entryKey(slug));
    } catch {
      return false;
    }
  },

  async configPath() {
    return '(Claude CLI internal config)';
  },
};
