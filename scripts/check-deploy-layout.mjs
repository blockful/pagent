import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const [railwayConfig, packageManifest] = await Promise.all([
  readFile(resolve(root, 'railway.json'), 'utf8').then(JSON.parse),
  readFile(resolve(root, 'package.json'), 'utf8').then(JSON.parse),
]);

if (railwayConfig.build?.buildCommand !== 'npm run check:deploy') {
  throw new Error('Railway must validate the root deployment layout after installing dependencies');
}
if (railwayConfig.deploy?.startCommand !== 'NODE_ENV=production npm -w @pagent/api run start') {
  throw new Error('Railway must start the API in production mode through the root workspace');
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
