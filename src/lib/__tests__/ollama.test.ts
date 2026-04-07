import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ollama from '@/lib/ollama';

describe('ollama http client', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  describe('listInstalledModels', () => {
    it('returns model tags from /api/tags', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: 'qwen3-vl:4b' }, { name: 'mistral:7b' }],
          }),
          { status: 200 },
        ),
      );
      const tags = await ollama.listInstalledModels();
      expect(tags).toEqual(['qwen3-vl:4b', 'mistral:7b']);
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
    });

    it('returns empty array on connection refused', async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('fetch failed'));
      const tags = await ollama.listInstalledModels();
      expect(tags).toEqual([]);
    });

    it('returns empty array on non-200 response', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response('', { status: 500 }));
      const tags = await ollama.listInstalledModels();
      expect(tags).toEqual([]);
    });
  });

  describe('deleteModel', () => {
    it('sends DELETE /api/delete with tag', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response('', { status: 200 }));
      await ollama.deleteModel('qwen3-vl:4b');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/delete',
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ name: 'qwen3-vl:4b' }),
        }),
      );
    });

    it('throws on non-200 response', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response('not found', { status: 404 }));
      await expect(ollama.deleteModel('missing')).rejects.toThrow();
    });
  });

  describe('generate', () => {
    it('returns the response field from JSON', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ response: 'Hello there', done: true }), { status: 200 }),
      );
      const out = await ollama.generate('qwen3-vl:4b', 'hi');
      expect(out).toBe('Hello there');
    });

    it('sends prompt and model in body', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ response: 'ok' }), { status: 200 }),
      );
      await ollama.generate('m1', 'p1');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ model: 'm1', prompt: 'p1', stream: false }),
        }),
      );
    });

    it('throws on HTTP error', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }));
      await expect(ollama.generate('m', 'p')).rejects.toThrow();
    });
  });

  describe('pullModel', () => {
    it('parses NDJSON stream and calls onProgress for each event', async () => {
      const ndjson =
        '{"status":"pulling manifest"}\n' +
        '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":500}\n' +
        '{"status":"success"}\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson));
          controller.close();
        },
      });
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }));

      const events: ollama.PullProgressEvent[] = [];
      await ollama.pullModel('qwen3-vl:4b', (e) => events.push(e));

      expect(events).toHaveLength(3);
      expect(events[0].status).toBe('pulling manifest');
      expect(events[1].status).toBe('downloading');
      expect(events[1].percent).toBe(50);
      expect(events[2].status).toBe('success');
    });

    it('handles split chunks across NDJSON line boundaries', async () => {
      const part1 = '{"status":"pull';
      const part2 = 'ing manifest"}\n{"status":"success"}\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(part1));
          controller.enqueue(encoder.encode(part2));
          controller.close();
        },
      });
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }));

      const events: ollama.PullProgressEvent[] = [];
      await ollama.pullModel('m', (e) => events.push(e));

      expect(events).toHaveLength(2);
      expect(events[0].status).toBe('pulling manifest');
    });

    it('throws on HTTP error', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response('', { status: 500 }));
      await expect(ollama.pullModel('m', () => {})).rejects.toThrow();
    });

    it('throws when stream contains an error event', async () => {
      const ndjson = '{"error":"model not found"}\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson));
          controller.close();
        },
      });
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }));
      await expect(ollama.pullModel('m', () => {})).rejects.toThrow('model not found');
    });
  });
});
