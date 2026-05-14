// src/lib/mcp/providers/index.ts
import { claudeCodeProvider } from './claude-code';
import { claudeDesktopProvider } from './claude-desktop';
import { codexCliProvider } from './codex-cli';
import { cursorProvider } from './cursor';

export type ProviderId = 'claude-code' | 'claude-desktop' | 'codex-cli' | 'cursor';
export type DetectStatus = 'installed' | 'missing' | 'unknown';

export interface McpInstallProvider {
  id: ProviderId;
  label: string;
  detect(): Promise<DetectStatus>;
  install(accountSlug: string, mcpUrl: string): Promise<void>;
  uninstall(accountSlug: string): Promise<void>;
  isLinked(accountSlug: string): Promise<boolean>;
  configPath(): Promise<string>;
}

export const PROVIDERS: McpInstallProvider[] = [
  claudeCodeProvider,
  claudeDesktopProvider,
  codexCliProvider,
  cursorProvider,
];

export function entryKey(accountSlug: string): string {
  return `notter-${accountSlug}`;
}

export function accountSlug(email: string): string {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
  return base.slice(0, 24);
}
