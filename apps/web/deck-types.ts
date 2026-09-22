import { z } from 'zod';

const dateSchema = z.string().datetime();
const nullableDateSchema = dateSchema.nullable();
export const authUserSchema = z.object({
  id: z.string().uuid(),
  handle: z.string().nullable(),
  email: z.string().email(),
  name: z.string().nullable(),
  avatar_url: z.string().url().nullable(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const deckListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  ownerId: z.string().uuid(),
  ownerEmail: z.string().email(),
  latestSenderId: z.string().uuid().nullable(),
  latestSenderEmail: z.string().email().nullable(),
  status: z.enum(['active', 'archived']),
  accessMode: z.enum(['anyone', 'allowed_email', 'authenticated']).nullable(),
  linkCount: z.number().int(),
  uniqueViewers: z.number().int().nullable(),
  lastViewed: nullableDateSchema,
  updatedAt: dateSchema,
});
export const deckListSchema = z.object({ decks: z.array(deckListItemSchema) });
export type DeckListItem = z.infer<typeof deckListItemSchema>;

export const slideSchema = z.object({
  id: z.string().uuid(),
  stableSlideId: z.string(),
  ordinal: z.number().int().positive(),
  title: z.string().nullable(),
  html: z.string(),
});
export const deckPreviewSchema = z.object({
  deckId: z.string().uuid(),
  title: z.string(),
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  slides: z.array(slideSchema),
});
export type DeckPreview = z.infer<typeof deckPreviewSchema>;

export const deckDetailSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  clientLabel: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  ownerId: z.string().uuid(),
  ownerEmail: z.string().email(),
  analyticsVisibility: z.enum(['private', 'selected', 'team', 'workspace']),
  latestRevisionNumber: z.number().int(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  lastPublishedAt: dateSchema,
  revisions: z.array(
    z.object({
      id: z.string().uuid(),
      revisionNumber: z.number().int(),
      slideCount: z.number().int(),
      createdByEmail: z.string().email(),
      createdAt: dateSchema,
    }),
  ),
  recentActivity: z.array(
    z.object({
      id: z.string().uuid(),
      action: z.string(),
      actorEmail: z.string().email().nullable(),
      createdAt: dateSchema,
    }),
  ),
});
export type DeckDetail = z.infer<typeof deckDetailSchema>;

export const shareLinkSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  creatorId: z.string().uuid(),
  creatorEmail: z.string().email(),
  accessMode: z.enum(['anyone', 'allowed_email', 'authenticated']),
  allowedEmails: z.array(z.string()),
  allowedDomains: z.array(z.string()),
  expiresAt: nullableDateSchema,
  revokedAt: nullableDateSchema,
  visitCount: z.number().int(),
  createdAt: dateSchema,
});
export const shareLinksSchema = z.object({ links: z.array(shareLinkSchema) });
export type ShareLink = z.infer<typeof shareLinkSchema>;
export const createdShareLinkSchema = z.object({
  id: z.string().uuid(),
  token: z.string(),
  accessMode: z.enum(['anyone', 'allowed_email', 'authenticated']),
  expiresAt: nullableDateSchema,
});
export const accessRequestsSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string().uuid(),
      requestedEmail: z.string().email(),
      status: z.enum(['pending', 'approved', 'denied']),
      createdAt: dateSchema,
    }),
  ),
});
export type AccessRequest = z.infer<typeof accessRequestsSchema>['requests'][number];

const audienceMemberSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  handle: z.string().nullable(),
});
export const accessSettingsSchema = z.object({
  analyticsVisibility: z.enum(['private', 'selected', 'team', 'workspace']),
  analyticsConsentRequired: z.boolean(),
  analyticsRetentionDays: z.number().int(),
  members: z.array(
    audienceMemberSchema.extend({
      role: z.enum(['owner', 'admin', 'member']),
      status: z.enum(['active', 'suspended', 'left']),
      canViewContent: z.boolean(),
      selectedForAnalytics: z.boolean(),
    }),
  ),
  teams: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      selectedForAnalytics: z.boolean(),
      memberIds: z.array(z.string().uuid()),
    }),
  ),
});
export type AccessSettings = z.infer<typeof accessSettingsSchema>;
export const analyticsAudienceSchema = z.object({
  scope: z.enum(['private', 'selected', 'team', 'workspace']),
  audience: z.array(audienceMemberSchema),
});
export type AnalyticsAudience = z.infer<typeof analyticsAudienceSchema>;
export const auditLogSchema = z.object({
  events: z.array(
    z.object({
      id: z.string().uuid(),
      action: z.string(),
      actorEmail: z.string().email().nullable(),
      details: z.unknown(),
      createdAt: dateSchema,
    }),
  ),
});
export type AuditEvent = z.infer<typeof auditLogSchema>['events'][number];

const identitySchema = z.enum(['anonymous', 'unverified', 'authenticated']);
const slideRollupSchema = z.object({
  slideId: z.string().uuid(),
  stableSlideId: z.string(),
  revisionNumber: z.number().int(),
  ordinal: z.number().int(),
  title: z.string().nullable(),
  uniqueViewers: z.number().int(),
  viewRate: z.number(),
  averageActiveTimeMs: z.number(),
  totalActiveTimeMs: z.number(),
  exits: z.number().int(),
});
export const analyticsSchema = z.object({
  owner: z.object({ id: z.string().uuid(), email: z.string().email() }),
  overview: z.object({
    totalVisits: z.number().int(),
    uniqueViewers: z.number().int(),
    lastViewed: nullableDateSchema,
    averageActiveTimeMs: z.number(),
    averageCompletion: z.number(),
    topSlide: slideRollupSchema.nullable(),
  }),
  visitors: z.array(
    z.object({
      viewer: z.string(),
      identityConfidence: identitySchema,
      firstVisit: dateSchema,
      lastVisit: dateSchema,
      visits: z.number().int(),
      totalActiveTimeMs: z.number(),
      maximumCompletion: z.number(),
    }),
  ),
  slides: z.array(slideRollupSchema),
  visits: z.array(
    z.object({
      id: z.string().uuid(),
      viewer: z.string(),
      identityConfidence: identitySchema,
      startedAt: dateSchema,
      lastActivityAt: dateSchema,
      linkId: z.string().uuid(),
      linkName: z.string(),
      senderId: z.string().uuid(),
      senderEmail: z.string().email(),
      revisionNumber: z.number().int(),
      totalActiveTimeMs: z.number(),
      viewedSlides: z.number().int(),
      completion: z.number(),
      furthestSlide: z.number().int().nullable(),
      lastSlide: z.number().int().nullable(),
      sequenceComplete: z.boolean().optional(),
      slideSequence: z.array(
        z.object({
          slideId: z.string().uuid(),
          ordinal: z.number().int(),
          title: z.string().nullable(),
          activeDurationMs: z.number(),
          viewCount: z.number().int(),
        }),
      ),
    }),
  ),
});
export type DeckAnalytics = z.infer<typeof analyticsSchema>;
