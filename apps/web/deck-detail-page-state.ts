import type { AuthUser, DeckAnalytics, DeckDetail, DeckPreview } from './deck-types.ts';

export type DetailTab = 'preview' | 'overview' | 'visitors' | 'slides' | 'links' | 'access';
export type DeckMutation = 'rename' | 'archive' | 'delete';

export type DeckDetailPageState = {
  readonly user: AuthUser | null;
  readonly detail: DeckDetail | null;
  readonly preview: DeckPreview | null;
  readonly analytics: DeckAnalytics | null;
  readonly activeTab: DetailTab;
  readonly loading: boolean;
  readonly unauthorized: boolean;
  readonly error: string | null;
  readonly analyticsDenied: boolean;
  readonly analyticsError: string | null;
  readonly previewIndex: number;
  readonly mutation: DeckMutation | null;
  readonly mutationError: string | null;
};

const detailTabs: readonly DetailTab[] = [
  'preview',
  'overview',
  'visitors',
  'slides',
  'links',
  'access',
];

export const deckDetailPageProperties = {
  deckId: { type: String },
  user: { state: true },
  detail: { state: true },
  preview: { state: true },
  analytics: { state: true },
  activeTab: { state: true },
  loading: { state: true },
  unauthorized: { state: true },
  error: { state: true },
  analyticsDenied: { state: true },
  analyticsError: { state: true },
  previewIndex: { state: true },
  mutation: { state: true },
  mutationError: { state: true },
};

export function createDeckDetailPageState(hash: string): DeckDetailPageState {
  return {
    user: null,
    detail: null,
    preview: null,
    analytics: null,
    activeTab: tabFromHash(hash),
    loading: true,
    unauthorized: false,
    error: null,
    analyticsDenied: false,
    analyticsError: null,
    previewIndex: 0,
    mutation: null,
    mutationError: null,
  };
}

export function tabFromHash(hash: string): DetailTab {
  const value = hash.replace('#', '');
  return detailTabs.find((tab) => tab === value) ?? 'preview';
}

export function availableDeckDetailTabs(
  hasAnalytics: boolean,
  canManage: boolean,
): readonly DetailTab[] {
  const analyticsTabs: readonly DetailTab[] = hasAnalytics
    ? ['overview', 'visitors', 'slides']
    : [];
  const managementTabs: readonly DetailTab[] = canManage ? ['links', 'access'] : [];
  return ['preview', ...analyticsTabs, ...managementTabs];
}

export function canManageDeck(user: AuthUser | null, detail: DeckDetail | null): boolean {
  return user !== null && detail !== null && user.id === detail.ownerId;
}
