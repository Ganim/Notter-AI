// src/lib/mcp/providers/paths.ts
//
// Resolves per-OS config paths for AI-client MCP installers.
import { homeDir, appDataDir } from '@tauri-apps/api/path';
import { platform } from '@tauri-apps/plugin-os';

export type OS = 'windows' | 'macos' | 'linux';

export async function detectOs(): Promise<OS> {
  const p = await platform();
  if (p === 'windows') return 'windows';
  if (p === 'macos') return 'macos';
  return 'linux';
}

export async function claudeDesktopConfigPath(): Promise<string> {
  const os = await detectOs();
  const home = await homeDir();
  if (os === 'windows') {
    // appDataDir is %APPDATA%\com.guilh.notterai (Tauri-scoped). Step up
    // to the Roaming root, then \Claude\claude_desktop_config.json.
    const appData = await appDataDir();
    const roaming = appData.replace(/[\\/](com\.guilh\.notterai|agenttrack)[\\/]?$/i, '');
    return `${roaming}\\Claude\\claude_desktop_config.json`;
  }
  if (os === 'macos') {
    return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
  }
  return `${home}/.config/Claude/claude_desktop_config.json`;
}

export async function codexConfigPath(): Promise<string> {
  const home = await homeDir();
  const os = await detectOs();
  // On Windows ~ resolves via homeDir() so it's still %USERPROFILE%\.codex
  if (os === 'windows') return `${home}\\.codex\\config.toml`;
  return `${home}/.codex/config.toml`;
}

export async function cursorConfigPath(): Promise<string> {
  const home = await homeDir();
  const os = await detectOs();
  if (os === 'windows') return `${home}\\.cursor\\mcp.json`;
  return `${home}/.cursor/mcp.json`;
}
