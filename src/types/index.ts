export type AIProvider = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface AgentProfile {
  id: string;
  name: string;
  provider: AIProvider;
  model: string;
  apiKey: string;
  systemPrompt: string;
  autonomous: boolean;
}

export interface Project {
  name: string;
  path: string;
  workspaceId: string;
}

export type ShellType = 'powershell' | 'bash' | 'cmd';

export interface ConsoleInstance {
  id: string;
  name: string;
  cwd?: string;
  shell?: ShellType;
}

export interface EditorTheme {
  name: string;
  value: string;
  light: { hex: string; base: 'vs' | 'vs-dark' };
  dark: { hex: string; base: 'vs' | 'vs-dark' };
}

export type TaskStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | 'stuck';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface TaskMessage {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  type: 'comment' | 'action' | 'status_change';
}

