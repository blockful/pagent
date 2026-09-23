import { z } from 'zod';
import { HTML_MAX_BYTES } from '../limits.ts';

const stableSlideIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const deckIdSchema = z.string().uuid().brand('DeckId');
export type DeckId = z.infer<typeof deckIdSchema>;

export const shareLinkIdSchema = z.string().uuid().brand('ShareLinkId');
export type ShareLinkId = z.infer<typeof shareLinkIdSchema>;

export const identityConfidenceSchema = z.enum(['anonymous', 'unverified', 'authenticated']);
export type IdentityConfidence = z.infer<typeof identityConfidenceSchema>;

export const analyticsVisibilitySchema = z.enum(['private', 'selected', 'team', 'workspace']);
export type AnalyticsVisibility = z.infer<typeof analyticsVisibilitySchema>;

const deckMetadataSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).optional(),
  client_label: z.string().trim().max(160).optional(),
  update_deck_id: deckIdSchema.optional(),
});

export const htmlPublishDeckBodySchema = deckMetadataSchema
  .extend({
    html: z
      .string()
      .min(1)
      .refine((html) => Buffer.byteLength(html, 'utf8') <= HTML_MAX_BYTES, {
        message: `HTML must not exceed ${HTML_MAX_BYTES} UTF-8 bytes`,
      })
      .refine((html) => !html.includes('\u0000'), { message: 'HTML cannot contain NUL bytes' }),
  })
  .strict();

const slidesPublishDeckBodySchema = deckMetadataSchema
  .extend({
    slides: z
      .array(
        z
          .object({
            id: stableSlideIdSchema,
            title: z.string().trim().max(200).optional(),
            html: z.string().min(1).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(500)
      .refine((slides) => new Set(slides.map((slide) => slide.id)).size === slides.length, {
        message: 'slide ids must be unique within a revision',
      }),
  })
  .strict();
export const publishDeckBodySchema = z.union([
  htmlPublishDeckBodySchema,
  slidesPublishDeckBodySchema,
]);
export type PublishDeckBody = z.infer<typeof publishDeckBodySchema>;
export type SlidesPublishDeckBody = z.infer<typeof slidesPublishDeckBodySchema>;

const shareLinkBaseSchema = z.object({
  name: z.string().trim().min(1).max(160),
  expires_at: z.string().datetime().optional(),
});

const publicShareLinkSchema = shareLinkBaseSchema
  .extend({
    access_mode: z.literal('anyone'),
    allowed_emails: z.array(z.string().email()).max(500).optional().default([]),
    allowed_domains: z.array(z.string().min(1).max(255)).max(100).optional().default([]),
  })
  .strict();

const restrictedShareLinkSchema = shareLinkBaseSchema
  .extend({
    access_mode: z.enum(['allowed_email', 'authenticated']),
    allowed_emails: z.array(z.string().email()).max(500).optional().default([]),
    allowed_domains: z.array(z.string().min(1).max(255)).max(100).optional().default([]),
  })
  .strict()
  .refine((value) => value.allowed_emails.length + value.allowed_domains.length > 0, {
    message: 'specific-audience links require at least one email or domain',
  });

export const createShareLinkBodySchema = z.union([
  publicShareLinkSchema,
  restrictedShareLinkSchema,
]);
export type CreateShareLinkBody = z.infer<typeof createShareLinkBodySchema>;

export const deckListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  scope: z.enum(['mine', 'shared', 'team']).optional().default('mine'),
  status: z.enum(['active', 'archived', 'expired', 'revoked']).optional(),
  owner: z.string().uuid().optional(),
  sender: z.string().uuid().optional(),
});

const analyticsFilterInputSchema = z
  .object({
    link_id: z.string().uuid().optional(),
    viewer: z.string().trim().max(320).optional(),
    sender: z.string().uuid().optional(),
    revision: z.coerce.number().int().positive().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

function mapAnalyticsFilters(value: z.infer<typeof analyticsFilterInputSchema>) {
  return {
    linkId: value.link_id,
    viewer: value.viewer,
    sender: value.sender,
    revision: value.revision,
    from: value.from,
    to: value.to,
  };
}

export const analyticsQuerySchema = analyticsFilterInputSchema.transform(mapAnalyticsFilters);
export const analyticsUrlQuerySchema = analyticsFilterInputSchema
  .omit({ viewer: true })
  .transform(mapAnalyticsFilters);

export type AllowedAudience = {
  readonly emails: readonly string[];
  readonly domains: readonly string[];
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeAudience(audience: AllowedAudience): AllowedAudience {
  return {
    emails: [...new Set(audience.emails.map(normalizeEmail))].sort(),
    domains: [
      ...new Set(audience.domains.map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))),
    ].sort(),
  };
}

export function matchesAudience(email: string, audience: AllowedAudience): boolean {
  const normalized = normalizeEmail(email);
  const separator = normalized.lastIndexOf('@');
  const domain = separator >= 0 ? normalized.slice(separator + 1) : '';
  return audience.emails.includes(normalized) || audience.domains.includes(domain);
}
