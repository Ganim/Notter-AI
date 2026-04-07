import { generate as generateOllama } from '@/lib/ollama';
import { generateCloud, type ProviderId, type CloudProviderId } from '@/lib/ai-providers';

export interface GenerateOptions {
  providerId: ProviderId;
  model: string;
  apiKey?: string;
  prompt: string;
}

export async function generateText(opts: GenerateOptions): Promise<string> {
  if (opts.providerId === 'ollama') {
    return await generateOllama(opts.model, opts.prompt);
  }
  return await generateCloud(
    opts.providerId as CloudProviderId,
    opts.model,
    opts.apiKey ?? '',
    opts.prompt,
  );
}
