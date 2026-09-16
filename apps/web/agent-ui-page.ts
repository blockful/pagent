export type PageFormat = 'a2ui' | 'html';
export type PageState = 'open' | 'submitted' | 'received';

export type PageResponse = {
  readonly spec: unknown;
  readonly format?: PageFormat;
  readonly state: PageState;
  readonly result: unknown | null;
  readonly expires_at: number | string;
};
