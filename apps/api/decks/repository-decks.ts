import * as db from '../db.ts';
import { sanitize } from '../sanitize.ts';
import type postgres from 'postgres';
import type { PublishDeckBody } from './domain.ts';
import { DeckDataInvariantError } from './errors.ts';

type Transaction = postgres.TransactionSql<Record<string, never>>;

export class DeckForbiddenError extends Error {
  readonly name = 'DeckForbiddenError';
  readonly deckId: string;

  constructor(deckId: string) {
    super(`deck ${deckId} is unavailable`);
    this.deckId = deckId;
  }
}

export class InvalidDeckContentError extends Error {
  readonly name = 'InvalidDeckContentError';
  readonly stableSlideId: string;

  constructor(stableSlideId: string) {
    super(`slide ${stableSlideId} is empty after sanitization`);
    this.stableSlideId = stableSlideId;
  }
}

type PublishingUser = {
  readonly id: string;
  readonly email: string;
};

export type PublishedDeck = {
  readonly deckId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
};

type SanitizedSlide = {
  readonly stableSlideId: string;
  readonly title: string | null;
  readonly html: string;
  readonly ordinal: number;
};

function sanitizedSlides(body: PublishDeckBody): readonly SanitizedSlide[] {
  return body.slides.map((slide, index) => {
    const html = sanitize(slide.html).output.trim();
    if (html.length === 0) throw new InvalidDeckContentError(slide.id);
    return {
      stableSlideId: slide.id,
      title: slide.title ?? null,
      html,
      ordinal: index + 1,
    };
  });
}

async function ensurePersonalWorkspace(tx: Transaction, user: PublishingUser): Promise<string> {
  const existing = await tx<{ id: string }[]>`
    select id from workspaces where personal_owner_id = ${user.id}
  `;
  const existingId = existing[0]?.id;
  if (existingId !== undefined) return existingId;
  const created = await tx<{ id: string }[]>`
    insert into workspaces (personal_owner_id, name)
    values (${user.id}, ${`${user.email}'s workspace`})
    on conflict (personal_owner_id) do update set updated_at = now()
    returning id
  `;
  const workspaceId = created[0]?.id;
  if (workspaceId === undefined) {
    throw new DeckDataInvariantError('workspace insert returned no id');
  }
  await tx`
    insert into workspace_members (workspace_id, user_id, role, status)
    values (${workspaceId}, ${user.id}, 'owner', 'active')
    on conflict (workspace_id, user_id) do update set role = 'owner', status = 'active'
  `;
  return workspaceId;
}

export async function publishDeck(
  user: PublishingUser,
  body: PublishDeckBody,
): Promise<PublishedDeck> {
  const slides = sanitizedSlides(body);
  return db.database().begin(async (tx) => {
    const workspaceId = await ensurePersonalWorkspace(tx, user);
    const requestedDeckId = body.update_deck_id;
    let deckId: string;
    if (requestedDeckId === undefined) {
      const created = await tx<{ id: string }[]>`
        insert into decks (workspace_id, owner_id, title, description, client_label)
        values (${workspaceId}, ${user.id}, ${body.title}, ${body.description ?? null}, ${body.client_label ?? null})
        returning id
      `;
      const createdId = created[0]?.id;
      if (createdId === undefined) {
        throw new DeckDataInvariantError('deck insert returned no id');
      }
      deckId = createdId;
    } else {
      const owned = await tx<{ id: string }[]>`
        update decks
        set title = ${body.title}, description = ${body.description ?? null},
            client_label = ${body.client_label ?? null}, updated_at = now()
        where id = ${requestedDeckId} and owner_id = ${user.id} and deleted_at is null
        returning id
      `;
      if (owned.length === 0) throw new DeckForbiddenError(requestedDeckId);
      deckId = requestedDeckId;
    }
    const counters = await tx<{ latest_revision_number: number }[]>`
      update decks
      set latest_revision_number = latest_revision_number + 1, updated_at = now()
      where id = ${deckId}
      returning latest_revision_number
    `;
    const revisionNumber = counters[0]?.latest_revision_number;
    if (revisionNumber === undefined) {
      throw new DeckDataInvariantError('revision counter returned no value');
    }
    const revisions = await tx<{ id: string }[]>`
      insert into deck_revisions (deck_id, revision_number, created_by)
      values (${deckId}, ${revisionNumber}, ${user.id})
      returning id
    `;
    const revisionId = revisions[0]?.id;
    if (revisionId === undefined) {
      throw new DeckDataInvariantError('revision insert returned no id');
    }
    for (const slide of slides) {
      await tx`
        insert into deck_slides (revision_id, stable_slide_id, ordinal, title, html)
        values (${revisionId}, ${slide.stableSlideId}, ${slide.ordinal}, ${slide.title}, ${slide.html})
      `;
    }
    await tx`
      insert into audit_log (workspace_id, deck_id, actor_user_id, action, details)
      values (
        ${workspaceId}, ${deckId}, ${user.id}, 'deck.published',
        ${JSON.stringify({ revisionNumber, slideCount: slides.length })}::jsonb
      )
    `;
    return { deckId, revisionId, revisionNumber };
  });
}

export type DeckPreview = {
  readonly deckId: string;
  readonly title: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly slides: readonly {
    readonly id: string;
    readonly stableSlideId: string;
    readonly ordinal: number;
    readonly title: string | null;
    readonly html: string;
  }[];
};

export async function getDeckPreview(userId: string, deckId: string): Promise<DeckPreview> {
  const database = db.database();
  const revisions = await database<
    {
      deck_id: string;
      deck_title: string;
      revision_id: string;
      revision_number: number;
    }[]
  >`
    select d.id as deck_id, d.title as deck_title, r.id as revision_id, r.revision_number
    from decks d
    join deck_revisions r
      on r.deck_id = d.id and r.revision_number = d.latest_revision_number
    where d.id = ${deckId} and d.deleted_at is null
      and (
        d.owner_id = ${userId}
        or exists (
          select 1 from deck_collaborators dc
          join workspace_members wm
            on wm.workspace_id = d.workspace_id and wm.user_id = dc.user_id
          where dc.deck_id = d.id and dc.user_id = ${userId}
            and dc.can_view_content = true and wm.status = 'active'
        )
      )
  `;
  const revision = revisions[0];
  if (revision === undefined) throw new DeckForbiddenError(deckId);
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
    from deck_slides where revision_id = ${revision.revision_id} order by ordinal
  `;
  return {
    deckId: revision.deck_id,
    title: revision.deck_title,
    revisionId: revision.revision_id,
    revisionNumber: revision.revision_number,
    slides: slides.map((slide) => ({
      id: slide.id,
      stableSlideId: slide.stable_slide_id,
      ordinal: slide.ordinal,
      title: slide.title,
      html: slide.html,
    })),
  };
}

export { listDecks } from './repository-deck-list.ts';
export { getDeckDetail } from './repository-deck-detail.ts';
export { deleteDeck, setDeckStatus, updateDeckTitle } from './repository-deck-lifecycle.ts';
