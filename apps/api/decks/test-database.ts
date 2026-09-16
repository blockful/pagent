export function integrationDatabaseUrl(databaseName: string): string | undefined {
  const source = process.env.PAGENT_TEST_DATABASE_URL;
  if (source === undefined) return undefined;
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}
