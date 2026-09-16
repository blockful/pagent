import * as db from '../db.ts';
import type { AnalyticsFilters } from './repository-analytics.ts';
import { getDeckAnalytics } from './repository-analytics.ts';

function cell(value: string | number | Date | null): string {
  if (value === null) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportDeckAnalyticsCsv(
  userId: string,
  deckId: string,
  filters: AnalyticsFilters,
): Promise<string> {
  const analytics = await getDeckAnalytics(userId, deckId, filters);
  const rows = [
    [
      'visit_id',
      'viewer',
      'identity_confidence',
      'sender',
      'link',
      'revision',
      'started_at',
      'last_activity_at',
      'active_time_ms',
      'completion',
      'furthest_slide',
      'last_slide',
    ],
    ...analytics.visits.map((visit) => [
      visit.id,
      visit.viewer,
      visit.identityConfidence,
      visit.senderEmail,
      visit.linkName,
      visit.revisionNumber,
      visit.startedAt,
      visit.lastActivityAt,
      visit.totalActiveTimeMs,
      visit.completion,
      visit.furthestSlide,
      visit.lastSlide,
    ]),
  ];
  const csv = rows.map((row) => row.map(cell).join(',')).join('\n');
  await db.database()`
    insert into audit_log (workspace_id, deck_id, actor_user_id, action, details)
    select d.workspace_id, d.id, ${userId}, 'analytics.exported',
      ${JSON.stringify({
        linkId: filters.linkId,
        sender: filters.sender,
        revision: filters.revision,
        from: filters.from,
        to: filters.to,
      })}::jsonb
    from decks d where d.id = ${deckId} and d.deleted_at is null
  `;
  return `${csv}\n`;
}
