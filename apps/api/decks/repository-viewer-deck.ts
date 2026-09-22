import * as db from '../db.ts';
import type { IdentityConfidence } from './domain.ts';
import type { UnavailableState } from './errors.ts';
import { hashOpaqueToken } from './tokens.ts';

export type ViewerDeck = {
  readonly deckId: string;
  readonly deckTitle: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly html: string | null;
  readonly shareLinkId: string;
  readonly viewerSessionId: string;
  readonly identityConfidence: IdentityConfidence;
  readonly preview: boolean;
  readonly slides: readonly {
    readonly id: string;
    readonly stableSlideId: string;
    readonly ordinal: number;
    readonly title: string | null;
    readonly html: string;
  }[];
};

export class ViewerSessionUnavailableError extends Error {
  readonly name = 'ViewerSessionUnavailableError';
  readonly state: UnavailableState;

  constructor(state: UnavailableState) {
    super(`viewer session is ${state}`);
    this.state = state;
  }
}

export async function getViewerDeck(sessionToken: string): Promise<ViewerDeck> {
  const database = db.database();
  const rows = await database<
    {
      session_id: string;
      share_link_id: string;
      session_expires_at: Date;
      session_revoked_at: Date | null;
      link_expires_at: Date | null;
      link_revoked_at: Date | null;
      deck_id: string;
      deck_title: string;
      deleted_at: Date | null;
      revision_id: string;
      revision_number: number;
      html: string | null;
      identity_confidence: IdentityConfidence;
      preview: boolean;
    }[]
  >`
    select vs.id as session_id, sl.id as share_link_id,
      vs.expires_at as session_expires_at, vs.revoked_at as session_revoked_at,
      sl.expires_at as link_expires_at, sl.revoked_at as link_revoked_at,
      d.id as deck_id, d.title as deck_title, d.deleted_at,
      r.id as revision_id, r.revision_number, r.html, vs.identity_confidence, vs.preview
    from viewer_sessions vs
    join share_links sl on sl.id = vs.share_link_id
    join decks d on d.id = sl.deck_id
    join deck_revisions r
      on r.deck_id = d.id and r.revision_number = d.latest_revision_number
    where vs.token_hash = ${hashOpaqueToken(sessionToken)}
  `;
  const row = rows[0];
  if (row === undefined) throw new ViewerSessionUnavailableError('not_found');
  if (row.deleted_at !== null) throw new ViewerSessionUnavailableError('deleted');
  if (row.session_revoked_at !== null || row.link_revoked_at !== null) {
    throw new ViewerSessionUnavailableError('revoked');
  }
  if (
    row.session_expires_at.getTime() <= Date.now() ||
    (row.link_expires_at !== null && row.link_expires_at.getTime() <= Date.now())
  ) {
    throw new ViewerSessionUnavailableError('expired');
  }
  const slides = await database<
    {
      id: string;
      stable_slide_id: string;
      ordinal: number;
      title: string | null;
      html: string;
    }[]
  >`
    select id, stable_slide_id, ordinal, title, html
    from deck_slides where revision_id = ${row.revision_id} order by ordinal
  `;
  return {
    deckId: row.deck_id,
    deckTitle: row.deck_title,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    html: row.html,
    shareLinkId: row.share_link_id,
    viewerSessionId: row.session_id,
    identityConfidence: row.identity_confidence,
    preview: row.preview,
    slides: slides.map((slide) => ({
      id: slide.id,
      stableSlideId: slide.stable_slide_id,
      ordinal: slide.ordinal,
      title: slide.title,
      html: slide.html,
    })),
  };
}
