import type { RateLimiter } from './rate-limit.ts';

export type McpHttpConfig = {
  readonly publicUrl: string;
  readonly apiPublicUrl: string;
  readonly pageTtlMs: number;
  readonly maxBodyBytes?: number;
  readonly rateLimiter?: RateLimiter;
};
