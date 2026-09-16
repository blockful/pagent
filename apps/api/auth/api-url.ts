import { env } from '../schemas.ts';

export function getApiPublicUrl(): string {
  const configured = env.API_PUBLIC_URL;
  return configured ? new URL(configured).origin : `http://localhost:${env.PORT}`;
}
