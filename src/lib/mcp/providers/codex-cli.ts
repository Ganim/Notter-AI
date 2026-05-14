import { exists, readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { dirname } from '@tauri-apps/api/path';
import { parse, stringify } from '@iarna/toml';
import { codexConfigPath } from './paths';
import { Command } from '@tauri-apps/plugin-shell';
import { entryKey, type McpInstallProvider } from '.';

async function readConfig(path: string): Promise<Record<string, any>> {
  if (await exists(path)) {
    try { return parse(await readTextFile(path)) as Record<string, any>; }
    catch { return {}; }
  }
  return {};
}

async function writeConfig(path: string, obj: Record<string, any>): Promise<void> {
  const dir = await dirname(path);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await writeTextFile(path, stringify(obj as any));
}

export const codexCliProvider: McpInstallProvider = {
  id: 'codex-cli',
  label: 'Codex CLI',

  async detect() {
    try {
      const res = await Command.create('codex', ['--version']).execute();
      return res.code === 0 ? 'installed' : 'missing';
    } catch { return 'missing'; }
  },

  async install(slug, mcpUrl) {
    const path = await codexConfigPath();
    const cfg = await readConfig(path);
    cfg.mcp_servers = cfg.mcp_servers || {};
    cfg.mcp_servers[entryKey(slug)] = { transport: 'http', url: mcpUrl };
    await writeConfig(path, cfg);
  },

  async uninstall(slug) {
    const path = await codexConfigPath();
    if (!(await exists(path))) return;
    const cfg = await readConfig(path);
    if (cfg.mcp_servers) delete cfg.mcp_servers[entryKey(slug)];
    await writeConfig(path, cfg);
  },

  async isLinked(slug) {
    const path = await codexConfigPath();
    if (!(await exists(path))) return false;
    const cfg = await readConfig(path);
    return !!(cfg.mcp_servers && cfg.mcp_servers[entryKey(slug)]);
  },

  async configPath() { return codexConfigPath(); },
};
