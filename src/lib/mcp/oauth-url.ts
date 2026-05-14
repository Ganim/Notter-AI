// src/lib/mcp/oauth-url.ts
// Reads endpoint.json to get the live MCP URL. Always returns the public
// /mcp URL — providers add /authorize themselves if needed.
import { readTextFile } from '@tauri-apps/plugin-fs';
import { join, appLocalDataDir } from '@tauri-apps/api/path';

export async function getMcpBaseUrl(): Promise<string | null> {
  try {
    const dir = await appLocalDataDir();
    const path = await join(dir, 'notter-ai', 'mcp', 'endpoint.json');
    const text = await readTextFile(path);
    const j = JSON.parse(text);
    return typeof j.url === 'string' ? j.url : null;
  } catch (e) {
    console.warn('[mcp] getMcpBaseUrl:', e);
    return null;
  }
}
