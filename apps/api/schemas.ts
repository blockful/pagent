import { z } from 'zod';

// --- Page ID -----------------------------------------------------------------

export const pageIdSchema = z.string().regex(/^[a-f0-9]{32}$/, 'invalid page id');

// --- Request bodies ----------------------------------------------------------

// spec is opaque (PRD §spec): only presence is enforced, never contents.
export const newPageBodySchema = z
  .object({ spec: z.unknown() })
  .refine((b) => 'spec' in b, { message: "missing 'spec'" });

// A2UI client action — passthrough so future fields don't 400 us.
export const resultBodySchema = z
  .object({
    name: z.string().min(1),
    surfaceId: z.string().min(1),
    sourceComponentId: z.string().optional(),
    context: z.record(z.unknown()).optional().default({}),
    timestamp: z.string().datetime().optional(),
  })
  .passthrough();

// --- Environment -------------------------------------------------------------

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().optional().default(8787),
  PUBLIC_URL: z.string().url().optional(),
  PAGE_TTL_MS: z.coerce.number().optional().default(1_800_000),
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
  RAILWAY_ENVIRONMENT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let env: Env;
try {
  env = envSchema.parse(process.env);
} catch (e) {
  console.error('Invalid environment:', e);
  process.exit(1);
}

export { env };
