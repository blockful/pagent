import { z } from 'zod';
import { HTML_MAX_BYTES } from './limits.ts';

// --- Page ID -----------------------------------------------------------------

export const pageIdSchema = z.string().regex(/^[a-f0-9]{32}$/, 'invalid page id');

// --- Request bodies ----------------------------------------------------------

// spec contents are opaque per format:
//   a2ui — unknown JSON (passed through to the renderer; PRD §spec)
//   html — UTF-8 string with a 1 MB cap
// The default for `format` keeps every pre-discriminator client working
// without changes (they POST `{ spec }` and land on the a2ui branch).
// The a2ui branch enforces presence of the `spec` key (allows null but not
// missing) so a stray `{}` still gets a 400 — matches pre-discriminator behavior.
export const newPageBodySchema = z.union([
  z
    .object({
      format: z.literal('a2ui').optional().default('a2ui'),
      spec: z.unknown(),
    })
    .refine((b) => 'spec' in b, { message: "missing 'spec'" }),
  z.object({
    format: z.literal('html'),
    spec: z.string().min(1).max(HTML_MAX_BYTES),
  }),
]);

export type NewPageBody = z.infer<typeof newPageBodySchema>;

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

// Railway, Nixpacks, and various CI runners set unset vars as empty strings
// rather than leaving them undefined. Treat "" as "not set" so .optional()
// behaves how callers expect (otherwise enum/url/coerce.number all reject "").
const stripEmptyStrings = (raw: unknown): unknown => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = v === '' ? undefined : v;
  }
  return out;
};

// Crypto/SMTP env vars that must be present when REQUIRE_AUTH=true. The auth
// implementation depends on every one of these; missing any would only crash
// later at request time. Validate up front so boot fails loudly instead.
const AUTH_REQUIRED_VARS = [
  'JWT_SIGNING_KEY',
  'JWT_PUBLIC_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MAGIC_LINK_SECRET',
  'AUTH_STATE_SECRET',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
] as const;

export const envSchema = z.preprocess(
  stripEmptyStrings,
  z
    .object({
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
      OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
      OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
      OTEL_SERVICE_NAME: z.string().optional(),
      NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
      LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
      RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
      RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

      // --- Auth ---------------------------------------------------------------
      // Boots without these during the grace period; auth endpoints return 503
      // until configured. When REQUIRE_AUTH=true the superRefine below enforces
      // every crypto/SMTP var (see AUTH_REQUIRED_VARS).
      REQUIRE_AUTH: z.coerce.boolean().optional().default(false),
      JWT_SIGNING_KEY: z.string().optional(),
      JWT_PUBLIC_KEY: z.string().optional(),
      GOOGLE_CLIENT_ID: z.string().optional(),
      GOOGLE_CLIENT_SECRET: z.string().optional(),
      GOOGLE_REDIRECT_URI: z.string().url().optional(),
      MAGIC_LINK_SECRET: z.string().optional(),
      AUTH_STATE_SECRET: z.string().optional(),
      SESSION_MAX_AGE_DAYS: z.coerce.number().int().positive().optional().default(30),
      REFRESH_TOKEN_MAX_DAYS: z.coerce.number().int().positive().optional().default(90),
      ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().optional().default(3600),
      SMTP_HOST: z.string().optional(),
      SMTP_PORT: z.coerce.number().int().optional().default(587),
      SMTP_USER: z.string().optional(),
      SMTP_PASS: z.string().optional(),
      SMTP_FROM: z.string().email().optional().default('noreply@pagent.link'),
    })
    .superRefine((cfg, ctx) => {
      if (
        cfg.NODE_ENV === 'production' &&
        (!cfg.ALLOWED_ORIGINS || cfg.ALLOWED_ORIGINS.length === 0)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['ALLOWED_ORIGINS'],
          message:
            'ALLOWED_ORIGINS is required in production. Set it to a comma-separated list of origins permitted to call the API (e.g. https://pagent.link).',
        });
      }
      if (cfg.NODE_ENV === 'production' && !cfg.PUBLIC_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_URL'],
          message:
            'PUBLIC_URL is required in production. Set it to the renderer URL (e.g. https://pagent.link).',
        });
      }
      if (cfg.REQUIRE_AUTH) {
        for (const key of AUTH_REQUIRED_VARS) {
          if (!cfg[key]) {
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: `${key} is required when REQUIRE_AUTH=true. See docs/superpowers/specs/2026-05-17-auth-design.md §9.`,
            });
          }
        }
      }
    }),
);

export type Env = z.infer<typeof envSchema>;

let env: Env;
try {
  env = envSchema.parse(process.env);
} catch (e) {
  console.error('Invalid environment:', e);
  process.exit(1);
}

export { env };
