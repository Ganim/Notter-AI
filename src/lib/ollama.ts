const OLLAMA_BASE = 'http://localhost:11434';

export interface PullProgressEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent: number;
}

export async function listInstalledModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function deleteModel(tag: string): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tag }),
  });
  if (!res.ok) {
    throw new Error(`delete failed: HTTP ${res.status}`);
  }
}

export async function generate(model: string, prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) {
    throw new Error(`generate failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { response: string };
  return json.response;
}

export async function pullModel(
  tag: string,
  onProgress: (event: PullProgressEvent) => void,
): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: tag, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`pull failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const total = typeof parsed.total === 'number' ? parsed.total : 0;
      const completed = typeof parsed.completed === 'number' ? parsed.completed : 0;
      const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
      const event: PullProgressEvent = {
        status: typeof parsed.status === 'string' ? parsed.status : '',
        digest: typeof parsed.digest === 'string' ? parsed.digest : undefined,
        total: total || undefined,
        completed: completed || undefined,
        percent,
      };
      onProgress(event);
      if (parsed.error) {
        throw new Error(String(parsed.error));
      }
    }
  }
}
