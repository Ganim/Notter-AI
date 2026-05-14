import { exists, readTextFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { dirname } from '@tauri-apps/api/path';
import { cursorConfigPath } from './paths';
import { entryKey, type McpInstallProvider } from '.';

async function readConfig(path: string): Promise<Record<string, any>> {
  if (await exists(path)) {
    try { return JSON.parse(await readTextFile(path)) || {}; }
    catch { return {}; }
  }
  return {};
}

async function writeConfig(path: string, obj: Record<string, any>): Promise<void> {
  const dir = await dirname(path);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await writeTextFile(path, JSON.stringify(obj, null, 2));
}

export const cursorProvider: McpInstallProvider = {
  id: 'cursor',
  label: 'Cursor',

  async detect() {
    const path = await cursorConfigPath();
    return (await exists(path)) ? 'installed' : 'missing';
  },

  async install(slug, mcpUrl) {
    const path = await cursorConfigPath();
    const cfg = await readConfig(path);
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers[entryKey(slug)] = { url: mcpUrl };
    await writeConfig(path, cfg);
  },

  async uninstall(slug) {
    const path = await cursorConfigPath();
    if (!(await exists(path))) return;
    const cfg = await readConfig(path);
    if (cfg.mcpServers) {
      delete cfg.mcpServers[entryKey(slug)];
    }
    await writeConfig(path, cfg);
  },

  async isLinked(slug) {
    const path = await cursorConfigPath();
    if (!(await exists(path))) return false;
    const cfg = await readConfig(path);
    return !!(cfg.mcpServers && cfg.mcpServers[entryKey(slug)]);
  },

  async configPath() { return cursorConfigPath(); },
};
