/**
 * OAuth dynamic client registration store (RFC 7591).
 *
 * Implements the MCP SDK's `OAuthRegisteredClientsStore` interface — the same
 * contract `mcpAuthRouter` consumes. Pagent's MCP clients are public (no
 * client_secret), so registration only writes metadata + a fresh UUID client
 * ID. Validation enforces RFC 7591 §2's required `redirect_uris` field; everything
 * else gets sensible OAuth 2.1 defaults (S256 / code / authorization_code).
 *
 * Spec: docs/superpowers/specs/2026-05-17-auth-design.md §3.3, §10 (MCP SDK
 * mapping table).
 */
import { randomUUID } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import * as db from '../db.ts';

// --- Defaults ---------------------------------------------------------------
// OAuth 2.1 / RFC 7591 defaults that match the AS metadata advertised at
// /.well-known/oauth-authorization-server. If those advertised values change,
// keep them in sync here — the AS metadata is the source of truth.

const DEFAULT_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const DEFAULT_RESPONSE_TYPES = ['code'] as const;
// MCP clients are public — they cannot keep a secret. `none` opts them out of
// client authentication entirely; PKCE substitutes for the missing secret.
const DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD = 'none';

// --- Errors -----------------------------------------------------------------

/**
 * Thrown when the client metadata fails RFC 7591 validation. The route layer
 * catches this and returns 400 `invalid_client_metadata` with the description
 * surfaced to the client.
 */
export class InvalidClientMetadataError extends Error {
  constructor(public readonly description: string) {
    super(description);
    this.name = 'InvalidClientMetadataError';
  }
}

// --- Helpers ----------------------------------------------------------------

/**
 * Validates a redirect URI per RFC 7591 §2: each MUST be a valid URI. We use
 * the URL constructor for parsing — it accepts any absolute URI with a
 * scheme, including custom schemes (e.g. `myapp://callback`) which native
 * MCP clients commonly use. URIs without a scheme (relative paths, bare
 * identifiers) are rejected.
 */
function isValidRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length === 0) return false;
  try {
    // `new URL(uri)` throws on relative URIs (no scheme) and on syntactically
    // malformed values. That's exactly the discriminator RFC 7591 calls for.
    new URL(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates `redirect_uris` and returns the canonical array. Per RFC 7591
 * §2 this field is required for clients using the `authorization_code` or
 * `implicit` grants — which is every client we accept. We additionally
 * enforce non-empty (RFC 7591 leaves array semantics implementation-defined,
 * but a zero-element array is meaningless for the authorization code flow).
 */
function validateRedirectUris(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new InvalidClientMetadataError(
      "'redirect_uris' is required and must be an array of URIs",
    );
  }
  if (input.length === 0) {
    throw new InvalidClientMetadataError("'redirect_uris' must be a non-empty array");
  }
  for (const uri of input) {
    if (!isValidRedirectUri(uri)) {
      throw new InvalidClientMetadataError(
        `'redirect_uris' contains an invalid URI: ${typeof uri === 'string' ? uri : typeof uri}`,
      );
    }
  }
  return input as string[];
}

/**
 * Optional string-array fields (`grant_types`, `response_types`). Falls back
 * to the provided default if absent. Rejects non-arrays so callers can't
 * sneak in malformed values that would later confuse the token endpoint.
 */
function validateOptionalStringArray(
  input: unknown,
  field: string,
  fallback: readonly string[],
): string[] {
  if (input === undefined || input === null) return [...fallback];
  if (!Array.isArray(input)) {
    throw new InvalidClientMetadataError(`'${field}' must be an array of strings`);
  }
  for (const v of input) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new InvalidClientMetadataError(`'${field}' must be an array of non-empty strings`);
    }
  }
  return input as string[];
}

/**
 * Optional string fields (`client_name`, `client_uri`, `logo_uri`, `scope`,
 * `token_endpoint_auth_method`). Returns null on absent/blank input so
 * postgres-js binds SQL NULL rather than the literal "".
 */
function optionalString(input: unknown, field: string): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new InvalidClientMetadataError(`'${field}' must be a string`);
  }
  return input.length === 0 ? null : input;
}

/**
 * Map a DB row back to the SDK's `OAuthClientInformationFull` shape.
 *
 * Postgres returns timestamptz as a JS Date; the wire format expects
 * `client_id_issued_at` as Unix *seconds* (RFC 7591 §3.2.1, §3). Drops NULL
 * scalar fields so the JSON serialization omits them (matches RFC 7591
 * example payloads, which only include explicitly set metadata).
 */
function rowToClientInformation(row: db.OAuthClientRow): OAuthClientInformationFull {
  const out: OAuthClientInformationFull = {
    client_id: row.client_id,
    client_id_issued_at: Math.floor(row.client_id_issued_at.getTime() / 1000),
    redirect_uris: row.redirect_uris,
    grant_types: row.grant_types,
    response_types: row.response_types,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
  };
  if (row.client_secret !== null) {
    out.client_secret = row.client_secret;
    if (row.client_secret_expires_at !== null) {
      out.client_secret_expires_at = Math.floor(row.client_secret_expires_at.getTime() / 1000);
    }
  }
  if (row.client_name !== null) out.client_name = row.client_name;
  if (row.client_uri !== null) out.client_uri = row.client_uri;
  if (row.logo_uri !== null) out.logo_uri = row.logo_uri;
  if (row.scope !== null) out.scope = row.scope;
  return out;
}

// --- Public API -------------------------------------------------------------

/**
 * Register a new OAuth client per RFC 7591. The MCP SDK's interface signature
 * takes `Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>`,
 * but real-world callers (including the dynamic-registration endpoint) pass
 * arbitrary JSON. We accept `unknown` here and do the validation in-house;
 * the route layer is responsible for the 400 response shape.
 *
 * Returns the canonical `OAuthClientInformationFull` echo per RFC 7591 §3.2.
 */
export async function registerClient(metadata: unknown): Promise<OAuthClientInformationFull> {
  if (typeof metadata !== 'object' || metadata === null) {
    throw new InvalidClientMetadataError('request body must be a JSON object');
  }
  const m = metadata as Record<string, unknown>;

  // RFC 7591 §2 — redirect_uris is required for our grants. The other fields
  // are optional with sensible defaults applied below.
  const redirect_uris = validateRedirectUris(m.redirect_uris);
  const grant_types = validateOptionalStringArray(
    m.grant_types,
    'grant_types',
    DEFAULT_GRANT_TYPES,
  );
  const response_types = validateOptionalStringArray(
    m.response_types,
    'response_types',
    DEFAULT_RESPONSE_TYPES,
  );

  const token_endpoint_auth_method =
    optionalString(m.token_endpoint_auth_method, 'token_endpoint_auth_method') ??
    DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD;

  const client_name = optionalString(m.client_name, 'client_name');
  const client_uri = optionalString(m.client_uri, 'client_uri');
  const logo_uri = optionalString(m.logo_uri, 'logo_uri');
  const scope = optionalString(m.scope, 'scope');

  // Use crypto.randomUUID — 122 bits of entropy is plenty for a public
  // identifier and matches the format spec'd in §3.3 ("a1b2c3d4-e5f6-...").
  const client_id = randomUUID();

  const row = await db.insertOAuthClient({
    client_id,
    client_name,
    client_uri,
    logo_uri,
    redirect_uris,
    grant_types,
    response_types,
    scope,
    token_endpoint_auth_method,
  });
  return rowToClientInformation(row);
}

/**
 * Fetch a registered client by ID. Returns `undefined` (not `null`) when
 * absent — that's the contract `OAuthRegisteredClientsStore.getClient`
 * expects, and `mcpAuthRouter` treats undefined as "unknown client" → 401.
 */
export async function getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const row = await db.getOAuthClientById(clientId);
  if (!row) return undefined;
  return rowToClientInformation(row);
}
