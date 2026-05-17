export interface Project {
  name: string;
  path: string;
  workspaceId: string;
  tag: string;
  nextSubjectSeq: number;
  archivedAt: string | null;
}

export interface EditorTheme {
  name: string;
  value: string;
  light: { hex: string; base: 'vs' | 'vs-dark' };
  dark: { hex: string; base: 'vs' | 'vs-dark' };
}
