interface ModelConfig {
  supportsImages: boolean;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'claude-sonnet-4-6': { supportsImages: true },
  'claude-opus-4-6': { supportsImages: true },
  'claude-haiku-4-5-20251001': { supportsImages: true },
  'glm-5.1': { supportsImages: false },
  'glm-5': { supportsImages: false },
  'glm-4.7': { supportsImages: false },
  'glm-5-turbo': { supportsImages: false },
  'google/gemma-4-31b-it:free': { supportsImages: true },
};

export function modelSupportsImages(modelId: string): boolean {
  const config = MODEL_CONFIGS[modelId];
  return config ? config.supportsImages : true;
}

export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  'glm5.1': 'glm-5.1',
  glm5: 'glm-5',
  'glm4.7': 'glm-4.7',
  glm5turbo: 'glm-5-turbo',
  gemma: 'google/gemma-4-31b-it:free',
};
