export type OAuthConsentClient = {
  readonly id: string;
  readonly name: string;
  readonly redirectUri: string;
  readonly scope: string;
};

export type ConsentPageParams = {
  readonly signedState: string;
  readonly client: OAuthConsentClient;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

export function renderConsentPage({ signedState, client }: ConsentPageParams): string {
  const scopes = client.scope
    .split(/[ \t\r\n\f]+/)
    .filter(Boolean)
    .map((scope) => `        <li><code>${escapeHtml(scope)}</code></li>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Authorize access to Pagent</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 520px;
      margin: 0 auto;
      padding: 48px 24px;
      color: #1a1a1a;
      background: #fafafa;
    }
    h1 { font-size: 24px; font-weight: 600; margin: 0 0 12px; }
    p { font-size: 15px; line-height: 1.5; margin: 0 0 16px; }
    .unverified {
      display: inline-block;
      margin-bottom: 16px;
      padding: 4px 8px;
      border: 1px solid #f59e0b;
      border-radius: 999px;
      color: #92400e;
      background: #fffbeb;
      font-size: 12px;
      font-weight: 600;
    }
    .details {
      margin: 20px 0;
      padding: 16px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: white;
    }
    .field { margin-bottom: 14px; }
    .field:last-child { margin-bottom: 0; }
    .label { display: block; margin-bottom: 4px; color: #6b7280; font-size: 12px; }
    .value, code { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    ul { margin: 6px 0 0; padding-left: 20px; }
    li { margin: 4px 0; }
    .warning { color: #4b5563; font-size: 13px; }
    .actions { display: flex; gap: 12px; margin-top: 24px; }
    button {
      flex: 1;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid #d1d5db;
      background: white;
      color: #1a1a1a;
      font: inherit;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
    }
    button[value="allow"] { border-color: #1a1a1a; background: #1a1a1a; color: white; }
    button:hover { filter: brightness(0.96); }
    button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <span class="unverified">Unverified OAuth client</span>
    <h1>${escapeHtml(client.name)} is requesting access</h1>
    <p>Review the client identity, return destination, and requested permissions before continuing.</p>
    <section class="details" aria-label="OAuth client request details">
      <div class="field"><span class="label">Client ID</span><span class="value">${escapeHtml(client.id)}</span></div>
      <div class="field"><span class="label">Exact return destination</span><span class="value">${escapeHtml(client.redirectUri)}</span></div>
      <div class="field"><span class="label">Requested scopes</span><ul>
${scopes}
      </ul></div>
    </section>
    <p class="warning">Only allow access if you recognize this request and trust the exact return destination above.</p>
    <form method="POST" action="/oauth/authorize/consent">
      <input type="hidden" name="state" value="${escapeHtml(signedState)}">
      <div class="actions">
        <button type="submit" name="decision" value="cancel">Cancel</button>
        <button type="submit" name="decision" value="allow">Allow</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}
