import { z } from 'zod';
import { slideSchema } from './deck-types.ts';

const dateSchema = z.string().datetime();
const identitySchema = z.enum(['anonymous', 'unverified', 'authenticated']);

export const shareMetadataSchema = z.object({
  linkId: z.string().uuid(),
  linkName: z.string(),
  deckTitle: z.string(),
  senderEmail: z.string().email(),
  accessMode: z.enum(['anyone', 'allowed_email', 'authenticated']),
  state: z.enum(['active', 'expired', 'revoked', 'deleted']),
  analyticsConsentRequired: z.boolean(),
});
export type ShareMetadata = z.infer<typeof shareMetadataSchema>;

export const viewerAccessSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('granted'),
    sessionToken: z.string(),
    identityConfidence: identitySchema,
    expiresAt: dateSchema,
  }),
  z.object({ kind: z.literal('email_required') }),
  z.object({ kind: z.literal('authentication_required') }),
  z.object({ kind: z.literal('unavailable'), canRequest: z.literal(true) }),
]);

export const requestedAccessSchema = z.object({ requestId: z.string().uuid() });
export const requestStatusSchema = z.object({ status: z.enum(['pending', 'approved', 'denied']) });
export const viewerDeckSchema = z.object({
  deckId: z.string().uuid(),
  deckTitle: z.string(),
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int(),
  shareLinkId: z.string().uuid(),
  viewerSessionId: z.string().uuid(),
  identityConfidence: identitySchema,
  preview: z.boolean(),
  slides: z.array(slideSchema),
});
export type ViewerDeck = z.infer<typeof viewerDeckSchema>;

export function confidenceLabel(value: ViewerDeck['identityConfidence'] | undefined): string {
  return value === 'unverified'
    ? 'Unverified'
    : value === 'authenticated'
      ? 'Authenticated'
      : 'Anonymous';
}
