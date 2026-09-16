import * as db from '../db.ts';
import { deriveAcceptedInterval } from './analytics.ts';
import type { IdentityConfidence } from './domain.ts';
import { DeckDataInvariantError } from './errors.ts';
import { hashOpaqueToken } from './tokens.ts';

export type StartVisitInput = {
  readonly visible: boolean;
  readonly interacted: boolean;
  readonly analyticsConsent: boolean;
  readonly deviceClass: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  readonly browserFamily: string;
  readonly countryCode: string | null;
};

export type StartVisitResult =
  | { readonly kind: 'started'; readonly visitId: string }
  | { readonly kind: 'excluded' }
  | { readonly kind: 'tracking_disabled' };

export class EngagementForbiddenError extends Error {
  readonly name = 'EngagementForbiddenError';
  constructor() {
    super('engagement session is unavailable');
  }
}

export async function startVisit(
  sessionToken: string,
  input: StartVisitInput,
): Promise<StartVisitResult> {
  const database = db.database();
  const rows = await database<
    {
      session_id: string;
      share_link_id: string;
      revision_id: string;
      identity_confidence: IdentityConfidence;
      viewer_email: string | null;
      preview: boolean;
      consent_required: boolean;
      workspace_id: string;
      deck_id: string;
    }[]
  >`
    select vs.id as session_id, sl.id as share_link_id, r.id as revision_id,
      vs.identity_confidence, vs.viewer_email, vs.preview,
      w.analytics_consent_required as consent_required, d.workspace_id, d.id as deck_id
    from viewer_sessions vs
    join share_links sl on sl.id = vs.share_link_id
    join decks d on d.id = sl.deck_id
    join workspaces w on w.id = d.workspace_id
    join deck_revisions r
      on r.deck_id = d.id and r.revision_number = d.latest_revision_number
    where vs.token_hash = ${hashOpaqueToken(sessionToken)}
      and vs.revoked_at is null and vs.expires_at > now()
      and sl.revoked_at is null and (sl.expires_at is null or sl.expires_at > now())
      and d.deleted_at is null
  `;
  const session = rows[0];
  if (session === undefined) throw new EngagementForbiddenError();
  if (session.preview || !input.visible || !input.interacted) return { kind: 'excluded' };
  if (session.consent_required && !input.analyticsConsent) {
    await database`
      insert into audit_log (
        workspace_id, deck_id, share_link_id, actor_viewer_session_id, action
      ) values (
        ${session.workspace_id}, ${session.deck_id}, ${session.share_link_id},
        ${session.session_id}, 'viewer.analytics_declined'
      )
    `;
    return { kind: 'tracking_disabled' };
  }
  return database.begin(async (tx) => {
    await tx`
      update visits set ended_at = last_activity_at + interval '30 minutes'
      where viewer_session_id = ${session.session_id} and ended_at is null
        and last_activity_at <= now() - interval '30 minutes'
    `;
    const existing = await tx<{ id: string }[]>`
      select id from visits
      where viewer_session_id = ${session.session_id} and share_link_id = ${session.share_link_id}
        and ended_at is null and last_activity_at > now() - interval '30 minutes'
      order by started_at desc limit 1
    `;
    const existingId = existing[0]?.id;
    if (existingId !== undefined) return { kind: 'started', visitId: existingId };
    const visits = await tx<{ id: string }[]>`
      insert into visits (
        share_link_id, revision_id, viewer_session_id, identity_confidence,
        viewer_email, device_class, browser_family, country_code, analytics_consent
      ) values (
        ${session.share_link_id}, ${session.revision_id}, ${session.session_id},
        ${session.identity_confidence}, ${session.viewer_email}, ${input.deviceClass},
        ${input.browserFamily}, ${input.countryCode}, ${input.analyticsConsent}
      ) returning id
    `;
    const visitId = visits[0]?.id;
    if (visitId === undefined) {
      throw new DeckDataInvariantError('visit insert returned no id');
    }
    await tx`
      insert into audit_log (
        workspace_id, deck_id, share_link_id, actor_viewer_session_id, action
      ) values (
        ${session.workspace_id}, ${session.deck_id}, ${session.share_link_id},
        ${session.session_id}, 'visit.started'
      )
    `;
    return { kind: 'started', visitId };
  });
}

export type EngagementEvent = {
  readonly id: string;
  readonly eventType: 'start' | 'heartbeat' | 'slide_view' | 'close';
  readonly slideId?: string;
  readonly eventAt: Date;
  readonly sequence: number;
  readonly visibleRatio: number;
  readonly visibleDurationMs: number;
  readonly tabVisible: boolean;
  readonly recentlyActive: boolean;
};

export async function ingestEngagement(
  sessionToken: string,
  visitId: string,
  inputEvents: readonly EngagementEvent[],
): Promise<void> {
  const events = [...inputEvents].sort(
    (left, right) => left.eventAt.getTime() - right.eventAt.getTime(),
  );
  await db.database().begin(async (tx) => {
    const visits = await tx<
      {
        revision_id: string;
        last_activity_at: Date;
      }[]
    >`
      select v.revision_id, v.last_activity_at
      from visits v
      join viewer_sessions vs on vs.id = v.viewer_session_id
      join share_links sl on sl.id = v.share_link_id
      join decks d on d.id = sl.deck_id
      where v.id = ${visitId} and vs.token_hash = ${hashOpaqueToken(sessionToken)}
        and vs.revoked_at is null and vs.expires_at > now()
        and sl.revoked_at is null and (sl.expires_at is null or sl.expires_at > now())
        and d.deleted_at is null
      for update of v
    `;
    const visit = visits[0];
    if (visit === undefined) throw new EngagementForbiddenError();
    const slideRows = await tx<{ id: string }[]>`
      select id from deck_slides where revision_id = ${visit.revision_id}
    `;
    const slideIds = new Set(slideRows.map((slide) => slide.id));
    let lastActivity = visit.last_activity_at;
    const serverReceivedAt = new Date();
    for (const event of events) {
      const slideId =
        event.slideId !== undefined && slideIds.has(event.slideId) ? event.slideId : null;
      const acceptedDurationMs = deriveAcceptedInterval({
        previousAcceptedAt: lastActivity,
        eventAt: event.eventAt,
        serverReceivedAt,
        visibleRatio: event.visibleRatio,
        tabVisible: event.tabVisible,
        recentlyActive: event.recentlyActive,
      });
      const inserted = await tx<{ idempotency_key: string }[]>`
        insert into engagement_events (
          idempotency_key, visit_id, event_type, slide_id, event_at, sequence,
          visible_ratio, tab_visible, recently_active, accepted_duration_ms
        ) values (
          ${event.id}, ${visitId}, ${event.eventType}, ${slideId}, ${event.eventAt},
          ${event.sequence}, ${event.visibleRatio}, ${event.tabVisible},
          ${event.recentlyActive}, ${acceptedDurationMs}
        ) on conflict (idempotency_key) do nothing
        returning idempotency_key
      `;
      if (inserted.length === 0) continue;
      const qualifies =
        event.eventType === 'slide_view' &&
        slideId !== null &&
        event.visibleRatio >= 0.5 &&
        event.visibleDurationMs >= 1_000 &&
        event.tabVisible &&
        event.recentlyActive;
      if (slideId !== null) {
        await tx`
          insert into slide_engagement (
            visit_id, slide_id, first_seen_at, last_seen_at, active_duration_ms,
            view_count, first_sequence, last_sequence, qualified
          ) values (
            ${visitId}, ${slideId}, ${event.eventAt}, ${event.eventAt},
            ${acceptedDurationMs}, ${qualifies ? 1 : 0}, ${event.sequence},
            ${event.sequence}, ${qualifies}
          ) on conflict (visit_id, slide_id) do update set
            last_seen_at = greatest(slide_engagement.last_seen_at, excluded.last_seen_at),
            active_duration_ms = slide_engagement.active_duration_ms + excluded.active_duration_ms,
            view_count = slide_engagement.view_count + excluded.view_count,
            first_sequence = least(slide_engagement.first_sequence, excluded.first_sequence),
            last_sequence = greatest(slide_engagement.last_sequence, excluded.last_sequence),
            qualified = slide_engagement.qualified or excluded.qualified
        `;
      }
      const advancesActivity =
        event.recentlyActive &&
        event.tabVisible &&
        event.eventAt.getTime() > lastActivity.getTime();
      if (advancesActivity) lastActivity = event.eventAt;
      if (event.eventType === 'close') {
        await tx`update visits set ended_at = now() where id = ${visitId}`;
      }
    }
    await tx`
      update visits set last_activity_at = greatest(last_activity_at, ${lastActivity})
      where id = ${visitId}
    `;
  });
}
