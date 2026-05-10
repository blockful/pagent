// Smoke test: boot the MCP server, run show_ui then poll check_result, print results.
// Run from repo root:  node mcp/smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'server.ts');

const child = spawn('node', ['--experimental-strip-types', SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env },
});

let buf = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('non-JSON:', line);
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- ternary calls one of two promise callbacks; both sides are side-effects
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  }
});

let nextId = 1;
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE = [
  {
    createSurface: {
      surfaceId: 'main',
      catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
    },
  },
  {
    updateComponents: {
      surfaceId: 'main',
      components: [
        { id: 'root', component: 'Column', children: ['title', 'btn'] },
        { id: 'title', component: 'Text', text: 'Smoke test surface' },
        { id: 'btn-text', component: 'Text', text: 'Send event' },
        {
          id: 'btn',
          component: 'Button',
          child: 'btn-text',
          variant: 'primary',
          action: { event: { name: 'smoke_done' } },
        },
      ],
    },
  },
];

try {
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  notify('notifications/initialized');

  console.log('--- calling show_ui');
  const show = await call('tools/call', {
    name: 'show_ui',
    arguments: { spec: SAMPLE },
  });
  console.log(JSON.stringify(show, null, 2));
  const pageId = show.structuredContent.page_id;

  console.log(
    `\nOpen this URL in a browser and click the button:\n  ${show.structuredContent.url}`,
  );
  console.log('\n--- polling check_result (up to 30 attempts, 1s apart)');

  let done = false;
  for (let attempt = 1; attempt <= 30; attempt++) {
    const result = await call('tools/call', {
      name: 'check_result',
      arguments: { page_id: pageId },
    });
    const state = result.structuredContent?.state;
    console.log(`attempt ${attempt}: state=${state}`);
    if (state === 'submitted' || state === 'received') {
      console.log(JSON.stringify(result, null, 2));
      done = true;
      break;
    }
    await sleep(1000);
  }
  if (!done) {
    console.log('Gave up waiting');
  }
} catch (err) {
  console.error('smoke failed:', err);
  process.exitCode = 1;
} finally {
  child.kill();
}
