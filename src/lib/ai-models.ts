export type ModelCapability =
  | 'vision'
  | 'code'
  | 'reasoning'
  | 'long-context'
  | 'fast'
  | 'general';

export interface BuiltinModel {
  id: string;
  tag: string;
  name: string;
  description: string;
  bestFor: string;
  capabilities: ModelCapability[];
  sizeGb: number;
  recommended?: boolean;
}

export const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: 'qwen3-vl-4b',
    tag: 'qwen3-vl:4b',
    name: 'Qwen3-VL 4B',
    description: 'Compact vision-language model with 256K context window. Fits in 6GB VRAM.',
    bestFor: 'Image analysis + code generation. Best fit for laptops/mid-range GPUs.',
    capabilities: ['vision', 'code', 'long-context', 'fast'],
    sizeGb: 3.3,
    recommended: true,
  },
  {
    id: 'qwen3-vl-8b',
    tag: 'qwen3-vl:8b',
    name: 'Qwen3-VL 8B',
    description: 'Higher quality variant with stronger reasoning. Needs ~10GB VRAM.',
    bestFor: 'Complex visual reasoning + heavier code refactors. Recommended for desktop GPUs.',
    capabilities: ['vision', 'code', 'reasoning', 'long-context'],
    sizeGb: 6.1,
  },
  {
    id: 'llama3.2-vision-11b',
    tag: 'llama3.2-vision:11b',
    name: 'Llama 3.2 Vision 11B',
    description: 'Meta vision model focused on image understanding and OCR.',
    bestFor: 'Document parsing, chart reading, screenshot analysis.',
    capabilities: ['vision', 'general'],
    sizeGb: 7.0,
  },
];

export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  vision: 'Análise de Imagens',
  code: 'Programação',
  reasoning: 'Raciocínio',
  'long-context': 'Contexto Longo',
  fast: 'Rápido',
  general: 'Uso Geral',
};

export const CAPABILITY_COLORS: Record<ModelCapability, string> = {
  vision: 'bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30',
  code: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30',
  reasoning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  'long-context': 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  fast: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
  general: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30',
};

export function findModelByTag(tag: string): BuiltinModel | undefined {
  return BUILTIN_MODELS.find((m) => m.tag === tag);
}
