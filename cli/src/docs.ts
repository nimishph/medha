import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as http from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import type { LifecycleStatus } from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';

export interface DocsServerOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
  readonly port?: string | number | undefined;
  readonly host?: string | undefined;
  readonly open?: boolean | undefined;
}

export interface DocsServerHandle {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  readonly close: () => Promise<void>;
}

export interface DocGuide {
  readonly slug: string;
  readonly title: string;
  readonly category: 'Guides' | 'Reference' | 'Specification';
  readonly summary: string;
  readonly content: string;
}

const BUNDLED_DOCS: readonly DocGuide[] = [
  {
    slug: 'overview',
    title: 'Overview & Architecture',
    category: 'Guides',
    summary: 'The evidential-memory mental model, dual-loop architecture, and trust mathematics.',
    content: `# Medha: Evidential Memory for AI Agents

Medha turns agent memories into verifiable, mathematically sound evidential claims. Unlike raw vector databases or unbounded scratchpads, Medha evaluates empirical success, test guard outcomes, usage recency, and environment durability.

## Dual-Loop Architecture

Medha decouples fast inner-loop hint packing from slow outer-loop evidential verification:

1. **Inner Loop (Zero-Latency Prompt Packing)**:
   - When an agent starts a task or asks for guidance, Medha selects relevant, high-trust rules within a strict token budget.
   - Probation rules are sampled with Wilson uncertainty exploration to prevent stagnation.
   - Quarantined or failing rules are filtered out by the negative-evidence radar.

2. **Outer Loop (Verified Evidential Feedback)**:
   - Test outcomes, linter assertions, and human reviews are recorded into an append-only transaction log.
   - Multi-agent convergence gates ensure claims are corroborated across distinct roles (e.g. coder, tester, reviewer).
   - Downward drift or failing oracle guards instantly trigger quarantine.

## Five Mathematical Factors

Medha scores every entity using five decoupled mathematical components:

$$T = L \\times G \\times R \\times D$$

- **$L$ (Lower Bound)**: Wilson score 95% confidence lower bound over trial outcomes $(k, n)$.
- **$G$ (Guard Multiplier)**: Verification state factor (1.0 for passed oracles, 0.0 for failing oracles).
- **$R$ (Recency Decay)**: Exponential half-life decay preserving recently validated knowledge.
- **$D$ (Durability Factor)**: Cross-environment anchor verification across commits, weeks, and branches.
- **$\\text{EMA}$ (Weight Drift)**: Exponential moving average detecting silent performance regressions.
`,
  },
  {
    slug: 'getting-started',
    title: 'Getting Started',
    category: 'Guides',
    summary: 'Initialize Medha in a repository, record signals, and pack context for agents.',
    content: `# Getting Started with Medha

Install Medha globally or run it directly with your favorite runner:

\`\`\`bash
# Run directly via bun or npx
bunx @cntxt-labs/medha init
# Or install globally
npm install -g @cntxt-labs/medha
\`\`\`

## 1. Initialize Engine Home

Scaffold the local evidential engine home (\`.medha/config.json\` and database):

\`\`\`bash
medha init
\`\`\`

## 2. Propose a Candidate Rule

Propose a candidate rule or best practice on probation:

\`\`\`bash
medha propose --id no-direct-eval --description "Never use direct eval() in untrusted input parsers"
\`\`\`

## 3. Record Successful Applications

As agents or developer workflows verify the rule in practice, record empirical signals:

\`\`\`bash
medha record --kind rule --id no-direct-eval --signal APPLY --author "tester:ci-bot"
\`\`\`

## 4. Run Oracles & Guards

Assert automated verification guards:

\`\`\`bash
medha guard --kind rule --id no-direct-eval --guard ast-lint --ok true --note "Green AST parse"
\`\`\`

## 5. Pack Context for AI Agents

Pack top-performing trusted rules within a strict token budget:

\`\`\`bash
medha pack --budget 500 --format markdown
\`\`\`
`,
  },
  {
    slug: 'cli',
    title: 'CLI Reference',
    category: 'Reference',
    summary: 'Complete command-line interface documentation for all commands and options.',
    content: `# Medha CLI Reference

## Top-Level Commands

- **\`medha init\`**: Scaffold the engine home (\`.medha/config.json\` + store).
- **\`medha primer\`**: Paginated, token-frugal primer on Medha concepts.
- **\`medha record\`**: Record evidence signals (\`APPLY\`, \`REJECT_RULE\`, \`SKIP\`).
- **\`medha guard\`**: Record guard reports from automated oracles or test harnesses.
- **\`medha pack\`**: Knapsack-pack active and exploration rules into a token budget.
- **\`medha distill\`**: Retrospectively mine incident trajectories into candidate rules.
- **\`medha ui\`**: Launch the interactive evidential memory web dashboard.
- **\`medha docs\`**: Launch the zero-dependency offline local documentation reader.
- **\`medha mcp serve\`**: Start the stdio Model Context Protocol (MCP) server for agents.
- **\`medha maintain\`**: Store maintenance, compaction, and diagnostics.
`,
  },
  {
    slug: 'agent-skill',
    title: 'Agent Skill & MCP Server',
    category: 'Reference',
    summary: 'Model Context Protocol (MCP) tools, Claude Code plugin, and agent integration.',
    content: `# Agent Skill & Model Context Protocol (MCP)

Medha exposes its full read and write planes over standard Model Context Protocol (MCP) on \`stdio\`.

## Configuring Claude Code / Cursor / Windsurf

Add Medha to your MCP configuration:

\`\`\`json
{
  "mcpServers": {
    "medha": {
      "command": "medha",
      "args": ["mcp", "serve"]
    }
  }
}
\`\`\`

## Key MCP Tools

- **\`hints_for_context\`**: Selectively packs active rules matching specific file paths, languages, or task keywords.
- **\`verify_guard\`**: Runs a shell command or asserts a boolean oracle, updating guard states in evidential memory.
- **\`detect_pitfalls\`**: Alerts agents to high-risk failing rules, quarantined traps, or recurrent antipatterns.
- **\`distill_trajectory\`**: Retrospectively analyzes session steps and commits to extract candidate rules.
- **\`pack_context\`**: Budget-capped evidential knapsack packing for LLM context windows.
- **\`record_signal\`**: Logs positive or negative outcomes with role attribution.
`,
  },
  {
    slug: 'trust-formula',
    title: 'Trust Formula & Statistical Foundation',
    category: 'Specification',
    summary: 'Wilson score confidence intervals, EMA drift detection, and status transitions.',
    content: `# Trust Formula & Statistical Foundation

## 1. Wilson Score Lower Bound ($L$)

Given $k$ successes out of $n$ trials with continuity-corrected Wilson parameter $z = 1.96$:

$$L = \\frac{k + \\frac{z^2}{2} - z \\sqrt{\\frac{k(n-k)}{n} + \\frac{z^2}{4}}}{n + z^2}$$

## 2. Guard Multiplier ($G$)

- $G = 1.0$: Passing oracle (\`lastOk === true\`).
- $G = 0.8$: Guard declared but unverified.
- $G = 0.5$: Unguarded entity.
- $G = 0.0$: Failing guard (\`lastOk === false\`) $\\rightarrow$ triggers Quarantine.

## 3. Recency Factor ($R$)

Exponential half-life decay based on elapsed time $\\Delta t$:

$$R = \\text{floor} + (1 - \\text{floor}) \\times 2^{-\\frac{\\Delta t}{\\tau}}$$

## 4. Durability Factor ($D$)

Measures survival across distinct host environments (calendar weeks, git commits, branches):

$$D = \\min\\left(1.0, 0.70 + 0.10 \\times (h - 1)\\right)$$
`,
  },
];

/** Scan local repository directory for markdown files in docs/ or site/ when available. */
function discoverLocalDocs(dir: string): DocGuide[] {
  const discovered: DocGuide[] = [];
  const searchDirs = [join(dir, 'docs'), join(dir, 'site')];

  for (const searchDir of searchDirs) {
    if (!existsSync(searchDir)) continue;
    try {
      const scan = (current: string) => {
        const entries = readdirSync(current);
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === '.vitepress' || entry.startsWith('.')) continue;
          const full = join(current, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            scan(full);
          } else if (entry.endsWith('.md')) {
            try {
              const text = readFileSync(full, 'utf8');
              const base = entry.replace(/\.md$/, '');
              const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
              const firstHeading = text.match(/^#\s+(.+)$/m)?.[1] ?? base;
              const summary =
                text
                  .split('\n')
                  .find((line) => line.trim().length > 0 && !line.startsWith('#'))
                  ?.replace(/[#*`_]/g, '')
                  .trim() ?? 'Local documentation guide';
              discovered.push({
                slug,
                title: firstHeading,
                category: searchDir.endsWith('docs') ? 'Specification' : 'Guides',
                summary,
                content: text,
              });
            } catch (err) {
              void err;
            }
          }
        }
      };
      scan(searchDir);
    } catch (err) {
      void err;
    }
  }

  return discovered;
}

/** Generate client-side responsive SPA HTML with real-time search, offline fallback, and local store telemetry. */
export function generateDocsHtml(
  guides: readonly DocGuide[],
  storeInfo: {
    readonly home: string;
    readonly totalEntities: number;
    readonly statusCounts: Record<LifecycleStatus, number>;
  },
): string {
  const jsonDocs = JSON.stringify(guides);
  const jsonStore = JSON.stringify(storeInfo);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Medha Documentation Reader</title>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-card: #334155;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.2);
      --border: #334155;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background: var(--bg-primary);
      color: var(--text-primary);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    #sidebar {
      width: 320px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .header {
      padding: 1.25rem;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 700;
      font-size: 1.15rem;
      color: var(--text-primary);
      margin-bottom: 0.75rem;
    }
    .brand svg {
      width: 28px;
      height: 28px;
      fill: var(--accent);
    }
    .store-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      padding: 0.25rem 0.6rem;
      border-radius: 9999px;
      background: rgba(56, 189, 248, 0.1);
      color: var(--accent);
      border: 1px solid var(--accent-glow);
      font-family: var(--font-mono);
    }
    .pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 8px #22c55e;
    }
    .search-box {
      padding: 0.75rem 1.25rem;
      border-bottom: 1px solid var(--border);
    }
    .search-input {
      width: 100%;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-size: 0.875rem;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-glow);
    }
    .nav-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem;
    }
    .category-title {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      padding: 0.5rem 0.5rem 0.25rem;
      font-weight: 600;
    }
    .doc-item {
      padding: 0.6rem 0.75rem;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      transition: background 0.15s, color 0.15s;
      margin-bottom: 0.25rem;
    }
    .doc-item:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .doc-item.active {
      background: var(--accent-glow);
      border-left: 3px solid var(--accent);
    }
    .doc-title {
      font-size: 0.875rem;
      font-weight: 500;
    }
    .doc-summary {
      font-size: 0.75rem;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #content-pane {
      flex: 1;
      overflow-y: auto;
      padding: 2.5rem 3.5rem;
      max-width: 960px;
    }
    .markdown-body h1 {
      font-size: 2rem;
      margin-bottom: 1rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    }
    .markdown-body h2 {
      font-size: 1.4rem;
      margin-top: 1.75rem;
      margin-bottom: 0.75rem;
      color: var(--accent);
    }
    .markdown-body h3 {
      font-size: 1.15rem;
      margin-top: 1.25rem;
      margin-bottom: 0.5rem;
    }
    .markdown-body p {
      margin-bottom: 1rem;
      line-height: 1.65;
      color: #cbd5e1;
    }
    .markdown-body ul, .markdown-body ol {
      margin-left: 1.5rem;
      margin-bottom: 1rem;
      line-height: 1.6;
    }
    .markdown-body li {
      margin-bottom: 0.35rem;
    }
    .markdown-body pre {
      background: #020617;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      overflow-x: auto;
      margin-bottom: 1.25rem;
      font-family: var(--font-mono);
      font-size: 0.85rem;
    }
    .markdown-body code {
      font-family: var(--font-mono);
      background: rgba(255, 255, 255, 0.1);
      padding: 0.15rem 0.35rem;
      border-radius: 4px;
      font-size: 0.875em;
    }
    .markdown-body pre code {
      background: transparent;
      padding: 0;
    }
    .markdown-body blockquote {
      border-left: 4px solid var(--accent);
      padding-left: 1rem;
      color: var(--text-secondary);
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div id="sidebar">
    <div class="header">
      <div class="brand">
        <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        <span>Medha Docs</span>
      </div>
      <div class="store-badge" id="telemetry-badge">
        <div class="pulse"></div>
        <span id="telemetry-text">Loading store...</span>
      </div>
    </div>
    <div class="search-box">
      <input type="text" class="search-input" id="search" placeholder="Search guides and docs (/) ..." />
    </div>
    <div class="nav-list" id="nav-list"></div>
  </div>
  <div id="content-pane">
    <div class="markdown-body" id="article"></div>
  </div>

  <script>
    const docs = ${jsonDocs};
    const storeInfo = ${jsonStore};
    let activeSlug = docs[0]?.slug ?? '';

    // Initialize telemetry badge
    const badgeText = document.getElementById('telemetry-text');
    if (storeInfo.totalEntities > 0) {
      badgeText.textContent = \`\${storeInfo.totalEntities} entities in local memory\`;
    } else {
      badgeText.textContent = 'Local store connected (0 entities)';
    }

    function renderNav(filterQuery = '') {
      const q = filterQuery.toLowerCase().trim();
      const nav = document.getElementById('nav-list');
      nav.innerHTML = '';

      const filtered = docs.filter(d => 
        !q || d.title.toLowerCase().includes(q) || d.summary.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)
      );

      const categories = ['Guides', 'Reference', 'Specification'];
      for (const cat of categories) {
        const items = filtered.filter(d => d.category === cat);
        if (items.length === 0) continue;

        const catEl = document.createElement('div');
        catEl.className = 'category-title';
        catEl.textContent = cat;
        nav.appendChild(catEl);

        for (const item of items) {
          const itemEl = document.createElement('div');
          itemEl.className = 'doc-item' + (item.slug === activeSlug ? ' active' : '');
          itemEl.innerHTML = \`<div class="doc-title">\${item.title}</div><div class="doc-summary">\${item.summary}</div>\`;
          itemEl.onclick = () => {
            activeSlug = item.slug;
            renderNav(filterQuery);
            renderDoc(item);
          };
          nav.appendChild(itemEl);
        }
      }
    }

    // Clean, robust markdown-to-HTML parser for browser
    function renderMarkdown(md) {
      const lines = md.split('\n');
      let html = '';
      let inCode = false;
      const tripleBacktick = String.fromCharCode(96, 96, 96);
      for (const line of lines) {
        if (line.startsWith(tripleBacktick)) {
          inCode = !inCode;
          html += inCode ? '<pre><code>' : '</code></pre>';
          continue;
        }
        if (inCode) {
          html += line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '\n';
          continue;
        }
        const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (esc.startsWith('# ')) html += '<h1>' + esc.slice(2) + '</h1>';
        else if (esc.startsWith('## ')) html += '<h2>' + esc.slice(3) + '</h2>';
        else if (esc.startsWith('### ')) html += '<h3>' + esc.slice(4) + '</h3>';
        else if (esc.startsWith('> ')) html += '<blockquote>' + esc.slice(2) + '</blockquote>';
        else if (esc.startsWith('- ')) html += '<li>' + esc.slice(2) + '</li>';
        else if (esc.trim() === '') html += '<br/>';
        else html += '<p>' + esc + '</p>';
      }
      return html;
    }

    function renderDoc(doc) {
      const article = document.getElementById('article');
      article.innerHTML = renderMarkdown(doc.content);
      window.scrollTo(0, 0);
    }

    document.getElementById('search').addEventListener('input', (e) => {
      renderNav(e.target.value);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== document.getElementById('search')) {
        e.preventDefault();
        document.getElementById('search').focus();
      }
    });

    // Initial render
    renderNav();
    if (docs.length > 0) {
      renderDoc(docs[0]);
    }
  </script>
</body>
</html>`;
}

/** Start zero-dependency localhost documentation server. */
export async function startDocsServer(
  options: DocsServerOptions = {},
  environment: Environment,
): Promise<DocsServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort =
    options.port !== undefined && options.port !== '' ? Number(options.port) : 8449;

  const targetDir = options.dir ?? environment.cwd;
  const projectDir = isAbsolute(targetDir) ? targetDir : resolve(environment.cwd, targetDir);

  // Discover local markdown files in repo or fall back to bundled guides
  const localGuides = discoverLocalDocs(projectDir);
  const guides: DocGuide[] = localGuides.length > 0 ? localGuides : [...BUNDLED_DOCS];

  // Attempt to open local store for live telemetry
  let totalEntities = 0;
  const statusCounts: Record<LifecycleStatus, number> = {
    probation: 0,
    active: 0,
    trusted: 0,
    quarantined: 0,
    retired: 0,
  };
  let homePath = '';

  try {
    const opened = openHome(projectDir, options.home);
    homePath = opened.home;
    await opened.store.open();
    const list = await opened.store.list();
    totalEntities = list.length;
    for (const item of list) {
      statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
    }
    await opened.store.close();
  } catch (err) {
    void err;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${requestedPort}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 1. Root / UI SPA
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = generateDocsHtml(guides, {
          home: homePath,
          totalEntities,
          statusCounts,
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 2. API: Catalog of all documents
      if (url.pathname === '/api/docs') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ guides, total: guides.length }));
        return;
      }

      // 3. API: Specific document by slug
      if (url.pathname.startsWith('/api/docs/')) {
        const slug = url.pathname.slice('/api/docs/'.length);
        const guide = guides.find((g) => g.slug === slug);
        if (!guide) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Guide '${slug}' not found` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(guide));
        return;
      }

      // 4. API: Local store telemetry
      if (url.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            home: homePath,
            totalEntities,
            statusCounts,
            activeDocs: guides.length,
          }),
        );
        return;
      }

      // 5. Health check
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  const actualPort = await new Promise<number>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolvePromise(addr.port);
      } else {
        resolvePromise(requestedPort);
      }
    });
  });

  const url = `http://${host}:${actualPort}`;

  return {
    url,
    port: actualPort,
    host,
    close: async () => {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    },
  };
}
