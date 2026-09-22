import { html, nothing } from 'lit';
import { loginUrl } from './deck-api.ts';

export const MCP_URL = 'https://api.pagent.link/mcp';

export const AGENT_PROMPT = `Add this MCP and install the Skill at the user level so it auto-loads in every session.

MCP:    ${MCP_URL}
Skill:  download https://pagent.link/SKILL.md using curl and write it to ~/.claude/skills/pagent/SKILL.md`;

export const renderHomeContent = (
  copied: boolean,
  onCopy: () => Promise<void>,
  copyError: string | null = null,
) => html`
  <main class="page">
    <div class="container">
      <nav class="nav">
        <span class="badge"><span class="dot"></span>Pagent</span>
        <span><a class="nav-link" href="/demo">Live demo</a> &nbsp;/&nbsp; read + write</span>
      </nav>

      <header class="hero">
        <p class="eyebrow">Two tools · every AI agent</p>
        <h1>Give your agent a page. <br /><em>Keep it when it matters.</em></h1>
        <p class="lede">
          Pagent gives agents two tools: <strong>write pages</strong> and
          <strong>read pages</strong>. A page can be interactive or view-only. Interactive and
          document pages are temporary and free with no signup.
        </p>
        <p class="lede lede-followup">
          <strong
            >A presentation is your HTML file, with its own layout and interactions, secure sharing,
            and engagement analytics. It lives in your signed-in workspace.</strong
          >
        </p>

        <div class="hero-actions" role="group" aria-label="Get started">
          <a class="workspace-cta" href="/pages">Open workspace <span class="arrow">→</span></a>
          <a class="demo-cta" href="/demo">Try a temporary page — no signup</a>
          <a class="sign-in-cta" href=${loginUrl('/pages')}>Sign in</a>
        </div>

        <div class="install" id="install" aria-labelledby="install-label">
          <div class="install-head">
            <span class="install-label" id="install-label">Install · paste into any agent</span>
            <button
              type="button"
              class="copy-btn ${copied ? 'is-copied' : ''}"
              @click=${() => onCopy()}
              aria-label=${copied
                ? 'Install prompt copied to clipboard'
                : 'Copy install prompt to clipboard'}
              aria-live=${copied ? 'polite' : 'off'}
            >
              ${copied ? 'Copied ✓' : 'Copy prompt'}
            </button>
            ${copyError ? html`<span role="alert">${copyError}</span>` : nothing}
          </div>
          <pre class="install-body is-prompt"><code>${AGENT_PROMPT}</code></pre>
        </div>

        <div class="install" aria-labelledby="install-direct-label">
          <div class="install-head">
            <span class="install-label" id="install-direct-label">Install · directly</span>
          </div>
          <pre
            class="install-body"
          ><code><span class="kw">claude</span> mcp add --transport http pagent ${MCP_URL}

<span class="cmt"># or the Claude Code plugin:</span>
/plugin marketplace add blockful/pagent
/plugin install pagent@pagent</code></pre>
          <div class="install-foot">
            <div>
              Cursor · Cline — <code>mcp.json</code>: <code>{ "url": "${MCP_URL}" }</code> under
              <code>mcpServers.pagent</code>
            </div>
            <div>
              Codex — <code>config.toml</code>: <code>[mcp_servers.pagent]</code>
              <code>url = "${MCP_URL}"</code>
            </div>
            <div>
              OpenCode — <code>opencode.json</code>:
              <code>{ "type": "remote", "url": "${MCP_URL}" }</code> under
              <code>mcp.pagent</code>
            </div>
          </div>
        </div>

        <div class="terminal" aria-hidden="true">
          <div>
            <span class="prompt">›</span
            ><span class="dim">"ask me my favorite color on a temporary page"</span>
          </div>
          <div>
            <span class="prompt">↳</span><span class="url">https://pagent.link/4f2a…b13c</span>
          </div>
          <div class="rule"></div>
          <div>
            <span class="prompt">›</span
            ><span class="dim">"turn these results into a presentation page"</span>
          </div>
          <div>
            <span class="prompt">↳</span><span class="url">https://pagent.link/9c1d…7e2a</span
            ><span class="caret"></span>
          </div>
        </div>
      </header>

      <h2 class="section-label"><span>One page model</span><span>two tools</span></h2>

      <section class="steps">
        <article class="step">
          <div class="step-num">i.</div>
          <h3>Connect once</h3>
          <p>
            Copy the prompt from the <a href="#install" class="step-link">panel above</a> into any
            agent chat. Pagent gives it exactly two MCP tools: <code>write</code> and
            <code>read</code>.
          </p>
        </article>
        <article class="step">
          <div class="step-num">ii.</div>
          <h3>Write the right page</h3>
          <p>
            Quick pages expire. Sign in when a page should stay in your workspace, become a
            presentation, or be shared securely. Either kind can be interactive or view-only.
          </p>
        </article>
        <article class="step">
          <div class="step-num">iii.</div>
          <h3>Read what happened</h3>
          <p>
            <code>read</code> returns page state and submitted answers. Durable presentation pages
            also surface visits, viewers, and active reading time in your workspace.
          </p>
        </article>
      </section>

      <div class="footer">
        <span>Hono · Vite · A2UI · Supabase</span>
        <a href="https://github.com/blockful/pagent" target="_blank" rel="noopener noreferrer">
          View on GitHub <span class="arrow">↗</span>
        </a>
      </div>
    </div>
  </main>
`;
