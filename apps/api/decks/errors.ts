export type UnavailableState = 'not_found' | 'expired' | 'revoked' | 'deleted';

export class DeckDataInvariantError extends Error {
  readonly name = 'DeckDataInvariantError';

  constructor(message: string) {
    super(message);
  }
}

export class ShareUnavailableError extends Error {
  readonly name = 'ShareUnavailableError';
  readonly state: UnavailableState;

  constructor(state: UnavailableState) {
    super(`share is ${state}`);
    this.state = state;
  }
}
