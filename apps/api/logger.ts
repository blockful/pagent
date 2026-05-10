import pino from 'pino';
import { env } from './schemas.ts';

export const logger = pino({
  level: env.LOG_LEVEL ?? 'info',
  // pino-pretty is a devDep; only require it in dev.
  ...(env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    },
  }),
});
