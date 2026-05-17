# 03 -- Metrics and environment config

## Description

Add webhook-specific OTel metrics to the metrics module and the
`WEBHOOK_ALLOW_PRIVATE_IPS` env var to the env schema. These are
imported by the webhook delivery engine (task 02) and the submit
handler (task 04).

## Files to create/modify

- `apps/api/metrics.ts` -- modify
- `apps/api/schemas.ts` -- modify
- `apps/api/metrics.test.ts` -- modify (if it asserts metric names)

## Changes

### `apps/api/metrics.ts`

Add three new instruments to the `metrics` object on the existing
`pagent-api` meter:

```ts
webhookDeliveries: meter.createCounter('pagent.webhook.deliveries', {
  description: 'Webhook delivery outcomes by status (success/rejected/failed/ssrf_blocked)',
}),
webhookDeliveryDuration: meter.createHistogram('pagent.webhook.delivery.duration', {
  description: 'Time from submission to final webhook delivery outcome',
  unit: 's',
}),
webhookDeliveryAttempts: meter.createHistogram('pagent.webhook.delivery.attempts', {
  description: 'Number of attempts per webhook delivery (1-3)',
}),
```

Labels on `webhookDeliveries`: `status` =
`success` | `rejected` | `failed` | `ssrf_blocked`.

### `apps/api/schemas.ts`

Add `WEBHOOK_ALLOW_PRIVATE_IPS` to `envSchema`:

```ts
WEBHOOK_ALLOW_PRIVATE_IPS: z
  .enum(['true', 'false'])
  .optional()
  .default('false')
  .transform((v) => v === 'true'),
```

### `apps/api/metrics.test.ts`

If the test file asserts the set of metric names, add the three new
instruments.

## Acceptance criteria

- [ ] `metrics.webhookDeliveries` is a counter on the `pagent-api` meter.
- [ ] `metrics.webhookDeliveryDuration` is a histogram (unit: `s`).
- [ ] `metrics.webhookDeliveryAttempts` is a histogram.
- [ ] `env.WEBHOOK_ALLOW_PRIVATE_IPS` is parsed as a boolean, defaults
      to `false`.
- [ ] Existing metrics tests remain green.

## Dependencies

- **01** (db schema) -- no direct code dependency, but should land in
  the same PR so the delivery engine can import both.

## Relevant spec sections

- Section 8: Observability (OTel metrics)
- Section 10: Environment variables
