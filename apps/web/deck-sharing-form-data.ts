type ShareLinkAccessMode = 'anyone' | 'allowed_email' | 'authenticated';

export type ShareLinkFormBody = {
  readonly name: string;
  readonly access_mode: ShareLinkAccessMode;
  readonly allowed_emails: readonly string[];
  readonly allowed_domains: readonly string[];
  readonly expires_at?: string;
};

export function parseShareLinkFormData(data: FormData): ShareLinkFormBody {
  const audience = formValue(data, 'audience');
  const accessMode: ShareLinkAccessMode =
    audience === 'anyone'
      ? 'anyone'
      : data.get('require_auth') === 'on'
        ? 'authenticated'
        : 'allowed_email';
  const allowed = formValue(data, 'allowed')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const expiry = formValue(data, 'expires_at');

  return {
    name: formValue(data, 'name'),
    access_mode: accessMode,
    allowed_emails: accessMode === 'anyone' ? [] : allowed.filter(isAllowedEmail),
    allowed_domains: accessMode === 'anyone' ? [] : allowed.filter(isAllowedDomain),
    ...(expiry ? { expires_at: new Date(expiry).toISOString() } : {}),
  };
}

function formValue(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function isAllowedEmail(value: string): boolean {
  return value.includes('@') && !value.startsWith('@');
}

function isAllowedDomain(value: string): boolean {
  return !value.includes('@') || value.startsWith('@');
}
