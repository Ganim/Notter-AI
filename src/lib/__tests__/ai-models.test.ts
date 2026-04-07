import { describe, it, expect } from 'vitest';
import { BUILTIN_MODELS, findModelByTag } from '@/lib/ai-models';

describe('ai-models registry', () => {
  it('exposes exactly 3 builtin models', () => {
    expect(BUILTIN_MODELS).toHaveLength(3);
  });

  it('marks Qwen3-VL 4B as recommended', () => {
    const recommended = BUILTIN_MODELS.filter((m) => m.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].tag).toBe('qwen3-vl:4b');
  });

  it('findModelByTag returns the right entry', () => {
    expect(findModelByTag('qwen3-vl:8b')?.id).toBe('qwen3-vl-8b');
    expect(findModelByTag('nonexistent')).toBeUndefined();
  });

  it('every model has required fields', () => {
    for (const m of BUILTIN_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.tag).toMatch(/:/); // ollama tag format
      expect(m.name).toBeTruthy();
      expect(m.sizeGb).toBeGreaterThan(0);
    }
  });
});
