import { html } from 'lit';

export const MCP_URL = 'https://api.pagent.link/mcp';

export const AGENT_PROMPT = `Add this MCP and install the Skill at the user level so it auto-loads in every session.

MCP:    ${MCP_URL}
Skill:  download https://pagent.link/SKILL.md using curl and write it to ~/.claude/skills/pagent/SKILL.md`;

export const renderHomeContent = (copied: boolean, onCopy: () => Promise<void>) => html`
  <div class="page">
    <div class="container">
      <nav class="nav">
        <span class="badge"><span class="dot"></span>Pagent</span>
        <span><a class="nav-link" href="/demo">Live demo</a> &nbsp;/&nbsp; v0.9 A2UI</span>
      </nav>

      <header class="hero">
        <p class="eyebrow">Generative UI · for any AI agent</p>
        <h1>Your AI agent can't show you a UI.<br /><em>Now it can.</em></h1>
        <p class="lede">
          Pagent lets any terminal agent render real browser UI — interactive
          <strong>forms</strong> it reads your answer back from, and rich
          <strong>dashboards</strong> you just look at. Your agent posts a spec, prints a short
          link, and waits. You open it, do the thing, and the conversation keeps going.
          <strong
            >Works in Claude Code, Cursor, Codex, Cline — any MCP client. Free, no signup.</strong
          >
        </p>

        <a class="demo-cta" href="/demo"
          >Try the live demo — no install <span class="arrow">→</span></a
        >

        <div class="install" id="install" aria-labelledby="install-label">
          <div class="install-head">
            <span class="install-label" id="install-label">Install · paste into any agent</span>
            <button
              type="button"
              class="copy-btn ${copied ? 'is-copied' : ''}"
              @click=${() => onCopy()}
              aria-label="Copy install prompt to clipboard"
              aria-live="polite"
            >
              ${copied ? 'Copied ✓' : 'Copy prompt'}
            </button>
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
            ><span class="dim">"ask me my favorite color via a UI"</span>
          </div>
          <div>
            <span class="prompt">↳</span><span class="url">https://pagent.link/4f2a…b13c</span>
          </div>
          <div class="rule"></div>
          <div>
            <span class="prompt">›</span
            ><span class="dim">"show me a dashboard of the test results"</span>
          </div>
          <div>
            <span class="prompt">↳</span><span class="url">https://pagent.link/9c1d…7e2a</span
            ><span class="caret"></span>
          </div>
        </div>
      </header>

      <p class="section-label"><span>How it works</span><span>three steps</span></p>

      <section class="steps">
        <article class="step">
          <div class="step-num">i.</div>
          <h3>Install in your agent</h3>
          <p>
            Copy the prompt from the <a href="#install" class="step-link">panel above</a> into any
            agent chat. The agent installs the MCP (<code>show_ui</code>, <code>check_result</code>)
            and reads the skill that teaches it when to reach for a form.
          </p>
        </article>
        <article class="step">
          <div class="step-num">ii.</div>
          <h3>Ask your agent</h3>
          <p>
            Try:
            <code>"Use the pagent skill to ask me my favorite color via a UI form."</code> The skill
            teaches the agent the polling pattern; the MCP gives it the tools.
          </p>
        </article>
        <article class="step">
          <div class="step-num">iii.</div>
          <h3>Open. Submit. Continue.</h3>
          <p>
            The agent prints a URL. You open it, fill the form, submit.
            <code>check_result</code> hands the answer back and the conversation keeps going.
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
  </div>
`;
