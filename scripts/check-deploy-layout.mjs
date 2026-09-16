import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const [railwayConfig, packageManifest] = await Promise.all([
  readFile(resolve(root, 'railway.json'), 'utf8').then(JSON.parse),
  readFile(resolve(root, 'package.json'), 'utf8').then(JSON.parse),
]);

if (railwayConfig.build?.buildCommand !== 'npm ci') {
  throw new Error('Railway must install the root lockfile with npm ci');
}
if (railwayConfig.deploy?.startCommand !== 'npm -w @pagent/api run start') {
  throw new Error('Railway must start the API through the root workspace');
}
if (!packageManifest.workspaces?.includes('apps/api')) {
  throw new Error('The root package manifest must include the API workspace');
}

await Promise.all([
  access(resolve(root, 'package-lock.json')),
  access(resolve(root, 'apps/api/package.json')),
  access(resolve(root, 'docs/openapi.yaml')),
]);

console.log('Railway deploy layout is self-contained at the repository root');
