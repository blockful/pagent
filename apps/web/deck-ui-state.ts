type DeckListFilters = {
  readonly scope: 'mine' | 'shared' | 'team';
  readonly query: string;
  readonly status: '' | 'active' | 'archived' | 'expired' | 'revoked';
  readonly ownerId: string;
  readonly senderId: string;
};

export function buildDeckListQuery(filters: DeckListFilters): URLSearchParams {
  const params = new URLSearchParams({ scope: filters.scope });
  if (filters.query.trim()) params.set('q', filters.query.trim());
  if (filters.status) params.set('status', filters.status);
  if (filters.ownerId) params.set('owner', filters.ownerId);
  if (filters.senderId) params.set('sender', filters.senderId);
  return params;
}

type PreviewIndexInput = {
  readonly current: number;
  readonly delta: number;
  readonly slideCount: number;
};

export function nextPreviewIndex(input: PreviewIndexInput): number {
  const lastIndex = Math.max(0, input.slideCount - 1);
  return Math.min(lastIndex, Math.max(0, input.current + input.delta));
}

export function nextRovingTab<T extends string>(
  tabs: readonly T[],
  current: T,
  key: string,
): T | null {
  const index = tabs.indexOf(current);
  if (index < 0 || tabs.length === 0) return null;
  if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length] ?? null;
  if (key === 'ArrowLeft') return tabs[(index - 1 + tabs.length) % tabs.length] ?? null;
  if (key === 'Home') return tabs[0] ?? null;
  if (key === 'End') return tabs.at(-1) ?? null;
  return null;
}
