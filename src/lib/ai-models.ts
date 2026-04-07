export interface BuiltinModel {
  id: string;
  tag: string;
  name: string;
  description: string;
  sizeGb: number;
  recommended?: boolean;
}

export const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: 'qwen3-vl-4b',
    tag: 'qwen3-vl:4b',
    name: 'Qwen3-VL 4B',
    description: 'Multimodal vision + code, 256K context, fits 6GB VRAM',
    sizeGb: 3.3,
    recommended: true,
  },
  {
    id: 'qwen3-vl-8b',
    tag: 'qwen3-vl:8b',
    name: 'Qwen3-VL 8B',
    description: 'Higher quality variant, needs ~10GB VRAM',
    sizeGb: 6.1,
  },
  {
    id: 'llama3.2-vision-11b',
    tag: 'llama3.2-vision:11b',
    name: 'Llama 3.2 Vision 11B',
    description: 'Meta vision model, strong image understanding',
    sizeGb: 7.0,
  },
];

export function findModelByTag(tag: string): BuiltinModel | undefined {
  return BUILTIN_MODELS.find((m) => m.tag === tag);
}
