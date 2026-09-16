import { z } from 'zod';

export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

const errorSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

export class ApiError extends Error {
  readonly name = 'ApiError';
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await apiFetch(path, init);
  return schema.parse(await response.json());
}

export async function apiEmpty(path: string, init?: RequestInit): Promise<void> {
  await apiFetch(path, init);
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  });
  if (response.ok) return response;
  const parsed = errorSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
  const code = parsed.success ? parsed.data.error : undefined;
  const message = parsed.success ? parsed.data.message : undefined;
  throw new ApiError(response.status, code, message ?? `Request failed (${response.status})`);
}

export function loginUrl(returnPath: string): string {
  const returnTo = new URL(returnPath, location.origin).toString();
  return `${API_BASE}/oauth/authorize?${new URLSearchParams({
    browser_session: '1',
    return_to: returnTo,
  }).toString()}`;
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'method'> {
  return { method: 'POST', body: JSON.stringify(value) };
}
