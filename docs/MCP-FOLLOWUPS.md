# MCP follow-up issues

Tracking issues discovered in the multi-agent code review for the MCP
package (`apps/mcp/`) and its associated artefacts. **Not yet fixed** —
another agent is working on this surface and will pick these up.

If you're starting that work, this file is your punch list. Each item
cites the exact file and line. Verify the line number before fixing —
the file may have shifted since this was written.

Organized P0 (bugs) → P1 (meaningful) → P2 (polish).

---

## P0 — bugs

### 1. `bin` field points at `server.ts`

**Location:** `apps/mcp/package.json:8`

**Issue:** The `bin.pagent-mcp` entry is `"server.ts"`. When the package
is installed globally (or linked) and a consumer runs `pagent-mcp`,
Node resolves that to the `.ts` source file and fails immediately —
stock Node will not execute TypeScript without `--experimental-strip-types`.
Even though the MCP plugin distributes `server.bundle.js` directly via
`.mcp.json`, the published `bin` field is broken for any out-of-monorepo
consumer. The `package.json` is currently `"private": true`, so the
immediate blast radius is limited, but a future un-private or `npm link`
scenario breaks silently.

**Fix:** Change `bin.pagent-mcp` to `"server.bundle.js"`, or remove the
`bin` field entirely if it is not advertised (the plugin already references
the bundle directly via `.mcp.json`, not via the binary). The `scripts.start`
entry correctly passes `--experimental-strip-types`, so that line is fine.

**Source:** code-review (Wave 5 review)

---

### 2. Boot guard is broken on Windows

**Location:** `apps/mcp/server.ts:139`

**Issue:** The boot guard reads:

```ts
if (import.meta.url === new URL(process.argv[1], import.meta.url).href) {
```

On Unix, `process.argv[1]` is an absolute POSIX path (`/path/to/server.ts`)
and `new URL('/path/to/server.ts', 'file:///path/to/server.ts')` correctly
yields `file:///path/to/server.ts`, which matches `import.meta.url`. On
Windows, `process.argv[1]` is a backslash path like `C:\path\to\server.ts`.
Passing that to `new URL()` with a `file://` base does not produce a valid
`file:///C:/path/to/server.ts` URL — it produces the literal string
`c:\path\to\server.ts` (confirmed by manual test). The comparison is always
`false`, so `server.connect()` is never called and the server silently does
nothing when run directly on Windows.

**Fix:** Replace the guard with `pathToFileURL`-based normalisation, which
handles both platforms:

```ts
import { pathToFileURL } from 'node:url';

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  await server.connect(new StdioServerTransport());
}
```

`pathToFileURL` on Windows correctly converts `C:\path\to\server.ts` to
`file:///C:/path/to/server.ts`, making the comparison reliable.

**Source:** code-review (Wave 5 review)

---

## P1 — meaningful

### 3. `spec: z.any()` gives the LLM no structural hint

**Location:** `apps/mcp/server.ts:45`

**Issue:** The `show_ui` tool declares `spec: z.any()`. The MCP SDK derives
JSON Schema from the Zod shape and hands it to the calling LLM as the tool's
input schema. `z.any()` emits a schema that places no constraint on the value,
so the model gets no structured signal that `spec` should be an array of
objects — it only has the description text to go on. The description text says
"an array of A2UI v0.9 messages", but that information is invisible in the
machine-readable schema. A model that skips description text (or truncates it)
may pass a plain object, a string, or null.

**Fix:** Tighten to `z.array(z.record(z.unknown()))`. This keeps the spec
opaque at the leaf level (we don't want to enforce the full A2UI shape here),
but communicates "array of objects" in the JSON Schema. The description text
can stay as-is for the detailed human-readable explanation.

**Source:** code-review (Wave 5 review)

---

### 4. `show_ui` text response omits `expires_at`

**Location:** `apps/mcp/server.ts:72-74`

**Issue:** The `content[0].text` response reads:

```
UI ready. Share this URL with the user:\n${created.url}\n\npage_id: ${created.id}
```

`expires_at` is present in `structuredContent` (line 79) but absent from the
human-readable text. The skill document (`skills/pagent/SKILL.md`) instructs
agents to cap their polling at the page TTL using `expires_at`. Agents (or
debug pipes) that consume only `content[0].text` — because they are text-only
or because the MCP host does not surface `structuredContent` — never see the
TTL and have no way to implement the cap. This leads to agents polling
indefinitely past the 30-minute expiry, receiving repeated "Page not found"
errors they weren't told to expect.

**Fix:** Append `expires_at` to the text response:

```ts
text: `UI ready. Share this URL with the user:\n${created.url}\n\npage_id: ${created.id}\nexpires_at: ${created.expires_at}`,
```

**Source:** code-review (Wave 5 review)

---

### 5. `apps/mcp` workspace is excluded from CI typecheck

**Location:** `package.json:25` (root `typecheck` script)

**Issue:** The root `typecheck` script is:

```json
"typecheck": "tsc --noEmit -p apps/api && tsc --noEmit -p apps/web"
```

`apps/mcp` is entirely absent. There is also no `apps/mcp/tsconfig.json` for
`tsc` to reference. The `build:mcp` script uses esbuild (line 18), which does
type-stripping but not full type checking. Type errors in `apps/mcp/server.ts`
(wrong return shapes, import-type mismatches, etc.) are invisible to CI until
a runtime failure surfaces them.

**Fix:** Create `apps/mcp/tsconfig.json` (extending the root `tsconfig.json`
or equivalent) and add `&& tsc --noEmit -p apps/mcp` to the `typecheck`
script. The vitest test suite already imports `server.ts`, but that does not
substitute for a dedicated type-checking pass.

**Source:** code-review (Wave 5 review)

---

## P2 — polish

### 6. Importing `server.ts` in tests triggers module-load side effects

**Location:** `apps/mcp/server.test.ts:7`, `apps/mcp/server.ts:30,35`

**Issue:** The test file imports `./server.ts`, which at module load runs
`new McpServer(...)` (line 30) and `server.registerTool(...)` (line 35).
The boot guard (line 139) correctly prevents `connect()` from being called,
but the SDK constructor and tool registration still execute on every test
import. Future tests that want to test registration logic, or that mock the
SDK, will have no clean surface to patch against. The test is currently
importing the whole server just to reach `formatRetryHint`.

**Fix:** Extract `formatRetryHint` (and any future pure helpers) to a
separate `apps/mcp/lib.ts` module. Import `./lib.ts` from both `server.ts`
and `server.test.ts`. The test then has zero server-side effects on import.

**Source:** code-review (Wave 5 review)

---

### 7. Unnecessary optional chains on already-initialised objects

**Location:** `apps/mcp/server.ts:64,103`

**Issue:** Both error-handling blocks use `body?.message` after `body` has
been assigned via `await res.json().catch(() => ({}))`. The fallback `{}`
guarantees `body` is always a non-null object; the `?.` optional chain is
dead code. It adds noise for readers who may wonder whether `body` can
actually be `undefined` at that point.

**Fix:** Remove the optional chains: `body.message` instead of `body?.message`
on line 64 and line 103. The TypeScript type already declares `body` as a
non-optional object, so this is also a type-consistency improvement.

**Source:** code-review (Wave 5 review)

---

### 8. Duplicate and inconsistent backoff description in smoke script

**Location:** `apps/mcp/smoke.mjs:100,102`

**Issue:** Line 100 prints `up to 8 attempts, 2→4→8→16→30s backoff` in the
log output. Line 102 has a code comment describing the same sequence as
`2→4→8→16→30→30→30→30 seconds`. The two descriptions are inconsistent: the
log says the backoff stops at 30s without clarifying it holds there, while the
comment correctly shows four 30s repetitions for a total of 8 rounds. A reader
relying on the log message alone gets a misleading picture of the total wait
time.

**Fix:** Consolidate to one accurate description. Update the `console.log`
string on line 100 to match the comment: `2→4→8→16→30→30→30→30s backoff`. Or
remove the comment on line 102 since the log line is the user-facing version.

**Source:** code-review (Wave 5 review)

---

### 9. Opaque ESLint-disable comment masks a simple `if/else`

**Location:** `apps/mcp/smoke.mjs:35-36`

**Issue:** The JSON-RPC dispatch uses a void ternary:

```js
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- ternary calls one of two promise callbacks; both sides are side-effects
msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
```

The comment correctly explains what the ternary does, but the explanation
exists precisely because the construct is non-idiomatic. A plain `if/else`
is equally compact, needs no disable comment, and is immediately clear.

**Fix:** Replace with an `if/else` block and remove the `eslint-disable`
comment:

```js
if (msg.error) {
  reject(new Error(msg.error.message));
} else {
  resolve(msg.result);
}
```

**Source:** code-review (Wave 5 review)

---

### 10. `SERVICE_URL` read once at startup with no explanatory comment

**Location:** `apps/mcp/server.ts:11`

**Issue:** `process.env.PAGENT_URL` is read and frozen into `SERVICE_URL`
at module load. This is intentional and correct for a short-lived stdio
process (the process exits after the session ends), but a future maintainer
adding hot-reload or long-lived server mode might not realise the read-once
behaviour and wonder why env changes mid-session have no effect.

**Fix:** Add a one-line comment clarifying the intent — do not change the
runtime behaviour:

```ts
// Read once at startup; fine for a short-lived stdio process.
const SERVICE_URL = ...
```

**Source:** code-review (Wave 5 review)

---

### 11. `SKILL.md` — inconsistent description of expired-page signal

**Location:** `skills/pagent/SKILL.md:10`

**Issue:** The introductory paragraph on line 10 says: "If `check_result`
returns 404 / 'Page not found', the page expired." The Polling cadence
section (line 84) correctly says: "When `check_result` throws 'Page not
found'...". The MCP server actually `throw`s a JavaScript `Error` (see
`apps/mcp/server.ts:104`) — it does not return a 404; the 404 is the HTTP
status the server receives internally and converts into a thrown error
before the tool returns. The word "returns" in the intro paragraph may lead
an agent to expect a structured `{ status: 404 }` value rather than a
thrown exception, and handle it incorrectly.

**Fix:** Update the first paragraph to say "throws" instead of "returns 404
/ 'Page not found'":

```
If `check_result` throws "Page not found", the page expired ...
```

**Source:** code-review (Wave 5 review)

---

### 12. Six version locations but `RELEASING.md` documents only five

**Location:** `docs/RELEASING.md:44-52`, `docs/openapi.yaml:4`

**Issue:** `docs/RELEASING.md` lists five files to bump on every release:
`package.json`, `apps/api/package.json`, `apps/web/package.json`,
`apps/mcp/package.json`, and `.claude-plugin/plugin.json`. However,
`docs/openapi.yaml` also carries a `version` field (`info.version`, line 4)
which is currently `0.1.0` — already drifted from the `0.0.1` in the other
five files. This creates a sixth bump target that is undocumented and easy
to forget, leading to API documentation that misrepresents the running
version.

**Fix:** Either (a) add `docs/openapi.yaml` to the `RELEASING.md` checklist
and the `sed` one-liner, or (b) make the openapi `info.version` derive from a
single source of truth (e.g. a build-time injection step). At minimum, align
`openapi.yaml` to `0.0.1` to close the existing drift before the next
release.

**Source:** code-review (Wave 5 review)

---

## Once these are done

Delete this file in the same commit that closes the last item, or shrink it
to just the items that remain open.
