import pino from 'pino';
import { env } from './schemas.ts';

// Pino transports: pretty in dev, raw stdout in prod, plus OTLP logs when
// OTEL_EXPORTER_OTLP_ENDPOINT is set. The OTel transport runs in a worker
// thread and reads endpoint/protocol from env vars (the OTel JS SDK
// convention), so we don't need to plumb the URL through options here.
const isProd = env.NODE_ENV === 'production';
const otelEnabled = !!env.OTEL_EXPORTER_OTLP_ENDPOINT;

type Target = { target: string; options?: Record<string, unknown>; level?: string };

const targets: Target[] = [
  isProd
    ? { target: 'pino/file', options: { destination: 1 } }
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } },
];

if (otelEnabled) {
  targets.push({
    target: 'pino-opentelemetry-transport',
    options: {
      resourceAttributes: {
        'service.name': env.OTEL_SERVICE_NAME ?? 'pagent-api',
      },
    },
  });
}

export const logger = pino({
  level: env.LOG_LEVEL ?? 'info',
  transport: { targets },
});
