import { Hono } from 'hono';
import type { AuthVariables } from './middleware.ts';
import { registerDiscoveryRoutes } from './route-discovery.ts';
import { registerConsentRoutes } from './route-consent.ts';
import { registerLoginRoutes } from './route-login.ts';
import { registerMagicRoutes } from './route-magic.ts';
import { registerSessionRoutes } from './route-session.ts';
import { registerTokenRoutes } from './route-token.ts';

export { magicSendLimiter } from './route-magic.ts';

export const authRoutes = new Hono<{ Variables: AuthVariables }>();

registerDiscoveryRoutes(authRoutes);
registerLoginRoutes(authRoutes);
registerConsentRoutes(authRoutes);
registerMagicRoutes(authRoutes);
registerTokenRoutes(authRoutes);
registerSessionRoutes(authRoutes);
