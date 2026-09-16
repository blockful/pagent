import { client, withRetry } from './connection.ts';

// ---------------------------------------------------------------------------
// OAuth clients (RFC 7591 dynamic registration)
// ---------------------------------------------------------------------------
// Backs apps/api/auth/clients-store.ts. The store module owns validation and
// mapping to/from the MCP SDK's OAuthClientInformationFull shape; this layer
// owns SQL — same split as insertPage / store.createPage. See spec §2.3 for
// the column layout.

export type OAuthClientRow = {
  client_id: string;
  client_secret: string | null;
  client_secret_expires_at: Date | null;
  client_id_issued_at: Date;
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string | null;
  token_endpoint_auth_method: string;
};

/**
 * Columns provided to INSERT. `created_at` and `client_id_issued_at` have DB
 * defaults so we omit them; the row returned by `returning *` carries the
 * server-assigned timestamps back. Nullable optional metadata uses `null`
 * (not undefined) so postgres-js binds it as SQL NULL rather than the
 * literal 'undefined' string.
 */
export type OAuthClientInsert = {
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string | null;
  token_endpoint_auth_method: string;
};

/**
 * Insert a new OAuth client. Returns the inserted row with server-defaulted
 * timestamps so the caller can derive `client_id_issued_at` in Unix seconds.
 * Wrapped in withRetry — registration is idempotent at the application layer
 * (UUID PK collisions are vanishingly unlikely) so retrying a transient DB
 * error is safe.
 */
export async function insertOAuthClient(input: OAuthClientInsert): Promise<OAuthClientRow> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<OAuthClientRow[]>`
      insert into oauth_clients (
        client_id,
        client_name,
        client_uri,
        logo_uri,
        redirect_uris,
        grant_types,
        response_types,
        scope,
        token_endpoint_auth_method
      ) values (
        ${input.client_id},
        ${input.client_name},
        ${input.client_uri},
        ${input.logo_uri},
        ${input.redirect_uris},
        ${input.grant_types},
        ${input.response_types},
        ${input.scope},
        ${input.token_endpoint_auth_method}
      )
      returning
        client_id, client_secret, client_secret_expires_at, client_id_issued_at,
        client_name, client_uri, logo_uri, redirect_uris, grant_types,
        response_types, scope, token_endpoint_auth_method
    `;
    return rows[0]!;
  });
}

/**
 * Look up a registered OAuth client by `client_id`. Returns null if no row
 * exists. The clients-store wraps this to surface `undefined` per the MCP
 * SDK's `OAuthRegisteredClientsStore` contract.
 */
export async function getOAuthClientById(clientId: string): Promise<OAuthClientRow | null> {
  return withRetry(async () => {
    const c = client();
    const rows = await c<OAuthClientRow[]>`
      select
        client_id, client_secret, client_secret_expires_at, client_id_issued_at,
        client_name, client_uri, logo_uri, redirect_uris, grant_types,
        response_types, scope, token_endpoint_auth_method
      from oauth_clients
      where client_id = ${clientId}
    `;
    return rows[0] ?? null;
  });
}
