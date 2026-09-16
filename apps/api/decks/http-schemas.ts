import { z } from 'zod';

export const viewerAccessBodySchema = z
  .object({ email: z.string().trim().email().optional() })
  .strict();

export const accessRequestBodySchema = z.object({ email: z.string().trim().email() }).strict();

export const accessDecisionBodySchema = z
  .object({ decision: z.enum(['approved', 'denied']) })
  .strict();

export const startVisitBodySchema = z
  .object({
    visible: z.boolean(),
    interacted: z.boolean(),
    analyticsConsent: z.boolean(),
    deviceClass: z.enum(['mobile', 'tablet', 'desktop', 'unknown']),
    browserFamily: z.string().trim().min(1).max(80),
    countryCode: z.string().length(2).toUpperCase().nullable(),
  })
  .strict();

export const engagementBodySchema = z
  .object({
    events: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            eventType: z.enum(['start', 'heartbeat', 'slide_view', 'close']),
            slideId: z.string().uuid().optional(),
            eventAt: z
              .string()
              .datetime()
              .transform((value) => new Date(value)),
            sequence: z.number().int().nonnegative(),
            visibleRatio: z.number().min(0).max(1),
            visibleDurationMs: z.number().int().min(0).max(60_000),
            tabVisible: z.boolean(),
            recentlyActive: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
