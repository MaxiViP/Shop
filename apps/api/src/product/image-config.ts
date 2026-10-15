export const IMAGE_OPTIONS = Symbol('PRODUCT_IMAGE_OPTIONS');

export interface ImageRegistryOptions {
  enabled: boolean;
  sourceRoot?: string;
  publicRoot?: string;
  stateRoot?: string;
  cache?: {
    maxEntries?: number;
    maxBytes?: number;
    positiveTtlMs?: number;
    negativeTtlMs?: number;
  };
  now?: () => number;
}

export function imageOptions(
  sourceRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ImageRegistryOptions {
  if (env.PRODUCT_IMAGE_VARIANTS_ENABLED !== 'true') return { enabled: false };
  return {
    enabled: true,
    sourceRoot,
    publicRoot: env.PRODUCT_IMAGE_VARIANTS_DIR || sourceRoot,
    stateRoot: env.PRODUCT_IMAGE_STATE_DIR,
  };
}
