import * as db from '../db.ts';
import { DeckForbiddenError } from './repository-decks.ts';

export async function updateDeckTitle(
  userId: string,
  deckId: string,
  title: string,
): Promise<void> {
  const database = db.database();
  const rows = await database<{ id: string }[]>`
    update decks set title = ${title}, updated_at = now()
    where id = ${deckId} and owner_id = ${userId} and deleted_at is null
    returning id
  `;
  if (rows.length === 0) throw new DeckForbiddenError(deckId);
}

export async function setDeckStatus(
  userId: string,
  deckId: string,
  status: 'active' | 'archived',
): Promise<void> {
  const database = db.database();
  const rows = await database<{ id: string }[]>`
    update decks set status = ${status}, updated_at = now()
    where id = ${deckId} and owner_id = ${userId} and deleted_at is null
    returning id
  `;
  if (rows.length === 0) throw new DeckForbiddenError(deckId);
}

export async function deleteDeck(userId: string, deckId: string): Promise<void> {
  await db.database().begin(async (tx) => {
    const rows = await tx<{ workspace_id: string }[]>`
      update decks set deleted_at = now(), updated_at = now()
      where id = ${deckId} and owner_id = ${userId} and deleted_at is null
      returning workspace_id
    `;
    const workspaceId = rows[0]?.workspace_id;
    if (workspaceId === undefined) throw new DeckForbiddenError(deckId);
    await tx`update share_links set revoked_at = now(), updated_at = now() where deck_id = ${deckId}`;
    await tx`
      update viewer_sessions set revoked_at = now()
      where share_link_id in (select id from share_links where deck_id = ${deckId})
    `;
    await tx`
      insert into audit_log (workspace_id, deck_id, actor_user_id, action)
      values (${workspaceId}, ${deckId}, ${userId}, 'deck.deleted')
    `;
  });
}
