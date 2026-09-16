import { ApiError, apiJson } from './deck-api.ts';
import { requestStatusSchema } from './viewer-types.ts';
import type { ViewerState } from './viewer-gate.ts';

export function viewerSessionKey(shareToken: string): string {
  return `pagent-viewer-session:${shareToken}`;
}

export function accessRequestKey(shareToken: string): string {
  return `pagent-access-request:${shareToken}`;
}

export async function getAccessRequestStatus(
  shareToken: string,
  requestId: string,
): Promise<'pending' | 'approved' | 'denied'> {
  return (
    await apiJson(`/v1/share/request/${requestId}`, requestStatusSchema, {
      headers: { 'x-share-token': shareToken },
    })
  ).status;
}

export function viewerFailure(error: unknown): {
  readonly state: ViewerState;
  readonly message: string | null;
} {
  if (
    error instanceof ApiError &&
    (error.code === 'expired' || error.code === 'revoked' || error.code === 'deleted')
  ) {
    return { state: error.code, message: null };
  }
  return { state: 'error', message: error instanceof Error ? error.message : 'Viewer unavailable' };
}
