import { spawn } from 'node:child_process';
import http from 'node:http';
import type { EntityKey, Episode, EvidentialHint } from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { type OpenedHome, openHome } from './open.ts';
import { LIFECYCLE_STATUSES, pageAll, paramsReport, type StatusReport } from './read.ts';
import { toJson } from './render.ts';
import { VERSION } from './version.ts';

export interface UiOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
  readonly port?: string | number | undefined;
  readonly host?: string | undefined;
  readonly open?: boolean | undefined;
}

export interface UiServerHandle {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  readonly close: () => Promise<void>;
}

export function openBrowser(url: string): boolean {
  const plat = process.platform;
  try {
    if (plat === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (plat === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (_err) {
    return false;
  }
}

export function generateDashboardHtml(data: {
  readonly status: StatusReport;
  readonly entities: readonly EvidentialHint[];
  readonly episodes: readonly Episode[];
  readonly version: string;
  readonly home: string;
}): string {
  const initialDataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Medha Evidential Memory Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Semantic Design Tokens: Primary, Secondary, Info, Danger, Success, Warning */
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --primary-glow: rgba(99, 102, 241, 0.25);
      --primary-subtle: rgba(99, 102, 241, 0.12);
      --primary-border: rgba(99, 102, 241, 0.3);
      --primary-fg: #ffffff;

      --secondary: #94a3b8;
      --secondary-hover: #cbd5e1;
      --secondary-glow: rgba(148, 163, 184, 0.2);
      --secondary-subtle: rgba(148, 163, 184, 0.1);
      --secondary-border: rgba(148, 163, 184, 0.25);
      --secondary-fg: #f8fafc;

      --info: #0ea5e9;
      --info-hover: #0284c7;
      --info-glow: rgba(14, 165, 233, 0.25);
      --info-subtle: rgba(14, 165, 233, 0.12);
      --info-border: rgba(14, 165, 233, 0.3);
      --info-fg: #ffffff;

      --danger: #f43f5e;
      --danger-hover: #e11d48;
      --danger-glow: rgba(244, 63, 94, 0.25);
      --danger-subtle: rgba(244, 63, 94, 0.12);
      --danger-border: rgba(244, 63, 94, 0.3);
      --danger-fg: #ffffff;

      --success: #10b981;
      --success-hover: #059669;
      --success-glow: rgba(16, 185, 129, 0.25);
      --success-subtle: rgba(16, 185, 129, 0.12);
      --success-border: rgba(16, 185, 129, 0.3);
      --success-fg: #ffffff;

      --warning: #f59e0b;
      --warning-hover: #d97706;
      --warning-glow: rgba(245, 158, 11, 0.25);
      --warning-subtle: rgba(245, 158, 11, 0.12);
      --warning-border: rgba(245, 158, 11, 0.3);
      --warning-fg: #ffffff;

      /* Base Layout & Surfaces */
      --bg-base: #090d16;
      --bg-surface: #111827;
      --bg-card: rgba(17, 24, 39, 0.7);
      --bg-glass: rgba(255, 255, 255, 0.04);
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-focus: var(--primary-border);
      --text-main: #f8fafc;
      --text-muted: var(--secondary);
      --text-faint: #64748b;

      /* Lifecycle mapped to Semantic Design Tokens */
      --trusted: var(--success);
      --trusted-glow: var(--success-glow);
      --active: var(--primary);
      --active-glow: var(--primary-glow);
      --probation: var(--warning);
      --probation-glow: var(--warning-glow);
      --quarantined: var(--danger);
      --quarantined-glow: var(--danger-glow);
      --retired: var(--secondary);

      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 18px;
      --font-sans: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    /* Semantic Utility Classes */
    .badge-primary { background: var(--primary-subtle); color: var(--primary); border: 1px solid var(--primary-border); }
    .badge-secondary { background: var(--secondary-subtle); color: var(--secondary); border: 1px solid var(--secondary-border); }
    .badge-info { background: var(--info-subtle); color: var(--info); border: 1px solid var(--info-border); }
    .badge-success { background: var(--success-subtle); color: var(--success); border: 1px solid var(--success-border); }
    .badge-warning { background: var(--warning-subtle); color: var(--warning); border: 1px solid var(--warning-border); }
    .badge-danger { background: var(--danger-subtle); color: var(--danger); border: 1px solid var(--danger-border); }

    .text-primary { color: var(--primary) !important; }
    .text-secondary { color: var(--secondary) !important; }
    .text-info { color: var(--info) !important; }
    .text-success { color: var(--success) !important; }
    .text-warning { color: var(--warning) !important; }
    .text-danger { color: var(--danger) !important; }

    .btn-secondary { background: var(--secondary-subtle); border-color: var(--secondary-border); color: var(--secondary-fg); }
    .btn-secondary:hover { background: rgba(148, 163, 184, 0.2); }
    .btn-info { background: var(--info); border-color: var(--info-border); color: var(--info-fg); box-shadow: 0 2px 10px var(--info-glow); }
    .btn-info:hover { background: var(--info-hover); }
    .btn-success { background: var(--success); border-color: var(--success-border); color: var(--success-fg); box-shadow: 0 2px 10px var(--success-glow); }
    .btn-success:hover { background: var(--success-hover); }
    .btn-warning { background: var(--warning); border-color: var(--warning-border); color: var(--warning-fg); box-shadow: 0 2px 10px var(--warning-glow); }
    .btn-warning:hover { background: var(--warning-hover); }
    .btn-danger { background: var(--danger); border-color: var(--danger-border); color: var(--danger-fg); box-shadow: 0 2px 10px var(--danger-glow); }
    .btn-danger:hover { background: var(--danger-hover); }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-base);
      color: var(--text-main);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      background-image: 
        radial-gradient(circle at 15% 15%, rgba(99, 102, 241, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 85% 20%, rgba(16, 185, 129, 0.06) 0%, transparent 40%),
        radial-gradient(circle at 50% 80%, rgba(244, 63, 94, 0.05) 0%, transparent 50%);
    }

    /* Header */
    header {
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(9, 13, 22, 0.85);
      backdrop-filter: blur(16px);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 0 2rem;
      height: 68px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-mark {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      background: linear-gradient(135deg, #6366f1, #10b981);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 19px;
      color: white;
      box-shadow: 0 0 16px rgba(99, 102, 241, 0.4);
    }
    .brand-name {
      font-weight: 800;
      font-size: 1.25rem;
      letter-spacing: -0.02em;
      background: linear-gradient(to right, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .badge {
      font-family: var(--font-mono);
      font-size: 0.72rem;
      padding: 3px 8px;
      border-radius: 6px;
      background: var(--bg-glass);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
    }
    .nav-tabs {
      display: flex;
      background: rgba(0, 0, 0, 0.3);
      padding: 4px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-subtle);
      gap: 4px;
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tab-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
    }
    .tab-btn.active {
      color: white;
      background: #1e293b;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn {
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border-subtle);
      background: var(--bg-glass);
      color: var(--text-main);
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
    }
    .btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .btn-primary {
      background: #4f46e5;
      border-color: #6366f1;
      color: white;
      box-shadow: 0 2px 10px rgba(79, 70, 229, 0.35);
    }
    .btn-primary:hover {
      background: #4338ca;
    }

    /* Container */
    main {
      flex: 1;
      max-width: 1440px;
      width: 100%;
      margin: 0 auto;
      padding: 2rem;
    }

    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px);
      border-radius: var(--radius-lg);
      padding: 1.4rem;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .card:hover {
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-2px);
    }
    .card-title {
      font-size: 0.78rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .card-metric {
      font-size: 2.1rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .card-subtext {
      font-size: 0.78rem;
      color: var(--text-faint);
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Status Pills & Indicators */
    .pill {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 3px 8px;
      border-radius: 20px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .pill::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .pill-trusted { color: var(--trusted); background: rgba(16, 185, 129, 0.12); }
    .pill-trusted::before { background: var(--trusted); box-shadow: 0 0 6px var(--trusted); }
    .pill-active { color: var(--active); background: rgba(99, 102, 241, 0.12); }
    .pill-active::before { background: var(--active); box-shadow: 0 0 6px var(--active); }
    .pill-probation { color: var(--probation); background: rgba(245, 158, 11, 0.12); }
    .pill-probation::before { background: var(--probation); box-shadow: 0 0 6px var(--probation); }
    .pill-quarantined { color: var(--quarantined); background: rgba(244, 63, 94, 0.12); }
    .pill-quarantined::before { background: var(--quarantined); box-shadow: 0 0 6px var(--quarantined); }
    .pill-retired { color: var(--retired); background: rgba(100, 116, 139, 0.12); }
    .pill-retired::before { background: var(--retired); }

    /* Progress bar */
    .dist-bar {
      display: flex;
      height: 10px;
      border-radius: 5px;
      overflow: hidden;
      margin: 1.5rem 0 2rem 0;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
    }
    .dist-seg {
      height: 100%;
      transition: width 0.3s ease;
    }

    /* Table Styles */
    .table-container {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px);
      border-radius: var(--radius-lg);
      overflow: hidden;
      margin-bottom: 2rem;
    }
    .table-toolbar {
      padding: 1rem 1.4rem;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .search-input {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 8px 14px;
      color: white;
      font-size: 0.85rem;
      min-width: 260px;
    }
    .search-input:focus {
      outline: none;
      border-color: var(--border-focus);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.86rem;
    }
    th {
      background: rgba(0, 0, 0, 0.2);
      color: var(--text-muted);
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 12px 1.4rem;
      border-bottom: 1px solid var(--border-subtle);
    }
    td {
      padding: 12px 1.4rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      color: var(--text-main);
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .entity-id {
      font-family: var(--font-mono);
      font-weight: 600;
      color: #93c5fd;
    }
    .trust-meter {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .trust-track {
      flex: 1;
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
      min-width: 80px;
    }
    .trust-fill {
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(to right, #6366f1, #10b981);
    }

    /* Views */
    .tab-view { display: none; }
    .tab-view.active { display: block; animation: fadeIn 0.25s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* Decomposer Layout */
    .decomposer-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
    }
    .factor-card {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 1rem;
      margin-top: 10px;
    }
    .factor-header {
      display: flex;
      justify-content: space-between;
      font-size: 0.82rem;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .factor-desc {
      font-size: 0.76rem;
      color: var(--text-muted);
    }

    /* Timeline */
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .timeline-item {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .timeline-item.retracted {
      opacity: 0.6;
      border-left: 3px solid var(--quarantined);
    }
    .timeline-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .note-box {
      background: rgba(99, 102, 241, 0.08);
      border-left: 3px solid #6366f1;
      padding: 8px 12px;
      border-radius: 0 6px 6px 0;
      font-size: 0.82rem;
      color: #e2e8f0;
      margin-top: 4px;
    }

    /* Packer Playground */
    .packer-layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 1.5rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    .form-group label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .slider {
      width: 100%;
      accent-color: #6366f1;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand-wrap">
      <div class="logo-mark">M</div>
      <span class="brand-name">Medha</span>
      <span class="badge badge-secondary" id="versionBadge">v${data.version}</span>
      <span class="badge badge-success">● Live</span>
    </div>

    <nav class="nav-tabs">
      <button class="tab-btn active" id="tabBtnFleet" onclick="switchTab('fleet')">Fleet Overview</button>
      <button class="tab-btn" id="tabBtnDecomposer" onclick="switchTab('decomposer')">Trust Decomposer</button>
      <button class="tab-btn" id="tabBtnPacker" onclick="switchTab('packer')">Context Packer</button>
      <button class="tab-btn" id="tabBtnTimeline" onclick="switchTab('timeline')">Audit Timeline</button>
    </nav>

    <div class="header-actions">
      <button class="btn btn-secondary" id="btnRefresh" onclick="refreshData()">↻ Refresh</button>
      <a class="btn btn-primary" id="btnExport" href="/report" target="_blank">Export HTML</a>
    </div>
  </header>

  <main>
    <!-- TAB 1: FLEET OVERVIEW -->
    <section id="viewFleet" class="tab-view active">
      <div class="metrics-grid">
        <div class="card" id="cardTotalEntities">
          <div class="card-title">Total Memory Entities</div>
          <div class="card-metric" id="metricTotalEntities">${data.entities.length}</div>
          <div class="card-subtext">Across registered kinds</div>
        </div>
        <div class="card" id="cardAvgTrust">
          <div class="card-title">Average Trust Score</div>
          <div class="card-metric" id="metricAvgTrust">0.000</div>
          <div class="card-subtext">Fleet weighted confidence</div>
        </div>
        <div class="card" id="cardDrifting">
          <div class="card-title">Drifting Entities</div>
          <div class="card-metric" id="metricDrifting" style="color: var(--probation)">${data.status.drifting}</div>
          <div class="card-subtext">Exceeding drift threshold</div>
        </div>
        <div class="card" id="cardEpisodes">
          <div class="card-title">Evidence Log Depth</div>
          <div class="card-metric" id="metricEpisodes">${data.episodes.length}</div>
          <div class="card-subtext">Total immutable episodes</div>
        </div>
      </div>

      <div class="dist-bar" id="distBar"></div>

      <div class="table-container">
        <div class="table-toolbar">
          <input type="text" id="filterSearch" class="search-input" placeholder="Filter by ID, namespace, or note..." oninput="renderEntitiesTable()">
          <div style="display: flex; gap: 8px;">
            <select id="filterStatus" class="search-input" style="min-width: 130px;" onchange="renderEntitiesTable()">
              <option value="">All Statuses</option>
              <option value="trusted">Trusted</option>
              <option value="active">Active</option>
              <option value="probation">Probation</option>
              <option value="quarantined">Quarantined</option>
              <option value="retired">Retired</option>
            </select>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Entity Key</th>
              <th>Trust Score</th>
              <th>Evidence (k/n)</th>
              <th>Drift Delta</th>
              <th>Last Note</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="entitiesTbody"></tbody>
        </table>
      </div>
    </section>

    <!-- TAB 2: TRUST DECOMPOSER -->
    <section id="viewDecomposer" class="tab-view">
      <div class="decomposer-grid">
        <div class="card">
          <h3 style="margin-bottom: 12px; font-weight: 700;">Mathematical Trust Decomposition</h3>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1rem;">
            Trust score is computed by decomposing statistical evidence, oracle guard verdicts, recency decay, and durability anchors:
            <code style="font-family: var(--font-mono); color: #818cf8; display: block; margin-top: 6px;">T = min(C, D * λ * G * W)</code>
          </p>

          <div style="margin-bottom: 1.5rem;">
            <label style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted);">Select Entity to Decompose:</label>
            <select id="decomposerSelect" class="search-input" style="width: 100%; margin-top: 6px;" onchange="updateDecomposer()"></select>
          </div>

          <div id="decomposerFactors"></div>
        </div>

        <div class="card">
          <h3 style="margin-bottom: 12px; font-weight: 700;">What-If Signal Simulation</h3>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1.5rem;">
            Test the exact mathematical delta a signal would produce on the selected entity without writing to the store:
          </p>

          <div class="form-group">
            <label>Signal to Simulate:</label>
            <select id="simulateSignal" class="search-input" style="width: 100%;">
              <option value="APPLY">APPLY (Successful execution: +1.0)</option>
              <option value="REJECT_RULE">REJECT_RULE (Rule violated: -1.0)</option>
              <option value="SKIP">SKIP (Neutral: delta 0.0)</option>
              <option value="CONTEXT_REJECT">CONTEXT_REJECT (Context unsuitable: 0.0)</option>
            </select>
          </div>

          <button class="btn btn-primary" style="width: 100%; justify-content: center; margin-bottom: 1.5rem;" onclick="runSimulation()">
            Run Simulation
          </button>

          <div id="simulationResult" style="display: none; background: rgba(0,0,0,0.25); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 1rem;"></div>
        </div>
      </div>
    </section>

    <!-- TAB 3: CONTEXT BUDGET PACKER -->
    <section id="viewPacker" class="tab-view">
      <div class="packer-layout">
        <div class="card">
          <h3 style="margin-bottom: 1.25rem; font-weight: 700;">Packer Parameters</h3>
          <div class="form-group">
            <label>Token Budget Cap: <span id="lblBudget" style="color: #818cf8; font-family: var(--font-mono);">1500</span> tokens</label>
            <input type="range" class="slider" id="rngBudget" min="200" max="8000" step="100" value="1500" oninput="updatePackerControls()">
          </div>
          <div class="form-group">
            <label>Exploration Ratio: <span id="lblExploration" style="color: var(--probation); font-family: var(--font-mono);">15%</span></label>
            <input type="range" class="slider" id="rngExploration" min="0" max="50" step="5" value="15" oninput="updatePackerControls()">
          </div>
          <div class="form-group">
            <label>Minimum Trust Filter: <span id="lblMinTrust" style="font-family: var(--font-mono);">0.00</span></label>
            <input type="range" class="slider" id="rngMinTrust" min="0" max="80" step="5" value="0" oninput="updatePackerControls()">
          </div>
          <button class="btn btn-primary" style="width: 100%; justify-content: center; margin-top: 10px;" onclick="runInteractivePack()">
            Re-Pack Context
          </button>
        </div>

        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
            <h3 style="font-weight: 700;">Packed Result Context</h3>
            <button class="btn" id="btnCopyPrompt" onclick="copyPromptContext()">📋 Copy Prompt Markdown</button>
          </div>
          <div id="packerStats" style="display: flex; gap: 16px; margin-bottom: 1.5rem; font-size: 0.85rem;"></div>
          <div id="packerSelectedList"></div>
        </div>
      </div>
    </section>

    <!-- TAB 4: AUDIT TIMELINE -->
    <section id="viewTimeline" class="tab-view">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
        <h3 style="font-weight: 700;">Immutable Episode Log Stream</h3>
        <input type="text" id="timelineFilter" class="search-input" placeholder="Search author, note, or seq..." oninput="renderTimeline()">
      </div>
      <div class="timeline" id="timelineList"></div>
    </section>
  </main>

  <script>
    let state = ${initialDataJson};

    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
      if (name === 'fleet') {
        document.getElementById('tabBtnFleet').classList.add('active');
        document.getElementById('viewFleet').classList.add('active');
      } else if (name === 'decomposer') {
        document.getElementById('tabBtnDecomposer').classList.add('active');
        document.getElementById('viewDecomposer').classList.add('active');
        populateDecomposerSelect();
      } else if (name === 'packer') {
        document.getElementById('tabBtnPacker').classList.add('active');
        document.getElementById('viewPacker').classList.add('active');
        runInteractivePack();
      } else if (name === 'timeline') {
        document.getElementById('tabBtnTimeline').classList.add('active');
        document.getElementById('viewTimeline').classList.add('active');
        renderTimeline();
      }
    }

    function renderMetrics() {
      const ents = state.entities || [];
      document.getElementById('metricTotalEntities').textContent = ents.length;
      const avg = ents.length > 0 ? (ents.reduce((acc, e) => acc + e.trustScore, 0) / ents.length).toFixed(3) : '0.000';
      document.getElementById('metricAvgTrust').textContent = avg;
      document.getElementById('metricDrifting').textContent = state.status?.drifting ?? 0;
      document.getElementById('metricEpisodes').textContent = state.episodes?.length ?? 0;

      // Distribution bar
      const counts = { trusted: 0, active: 0, probation: 0, quarantined: 0, retired: 0 };
      ents.forEach(e => { if (counts[e.status] !== undefined) counts[e.status]++; });
      const total = ents.length || 1;
      const bar = document.getElementById('distBar');
      bar.innerHTML = \`
        <div class="dist-seg" style="width: \${(counts.trusted / total) * 100}%; background: var(--trusted);" title="Trusted: \${counts.trusted}"></div>
        <div class="dist-seg" style="width: \${(counts.active / total) * 100}%; background: var(--active);" title="Active: \${counts.active}"></div>
        <div class="dist-seg" style="width: \${(counts.probation / total) * 100}%; background: var(--probation);" title="Probation: \${counts.probation}"></div>
        <div class="dist-seg" style="width: \${(counts.quarantined / total) * 100}%; background: var(--quarantined);" title="Quarantined: \${counts.quarantined}"></div>
        <div class="dist-seg" style="width: \${(counts.retired / total) * 100}%; background: var(--retired);" title="Retired: \${counts.retired}"></div>
      \`;
    }

    function renderEntitiesTable() {
      const q = (document.getElementById('filterSearch').value || '').toLowerCase();
      const statusFilter = document.getElementById('filterStatus').value;
      const tbody = document.getElementById('entitiesTbody');

      const filtered = (state.entities || []).filter(e => {
        if (statusFilter && e.status !== statusFilter) return false;
        if (!q) return true;
        const keyStr = e.key.namespace ? \`\${e.key.namespace}/\${e.key.kind}/\${e.key.id}\` : \`\${e.key.kind}/\${e.key.id}\`;
        const note = (e.lastNote || '').toLowerCase();
        return keyStr.toLowerCase().includes(q) || note.includes(q);
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-faint); padding: 2rem;">No entities match your filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(e => {
        const keyLabel = e.key.namespace ? \`\${e.key.namespace}/\${e.key.kind}/\${e.key.id}\` : \`\${e.key.kind}/\${e.key.id}\`;
        const pct = Math.round(e.trustScore * 100);
        return \`
          <tr>
            <td><span class="pill pill-\${e.status}">\${e.status}</span></td>
            <td><span class="entity-id">\${keyLabel}</span></td>
            <td>
              <div class="trust-meter">
                <span style="font-family: var(--font-mono); font-size: 0.8rem; width: 42px;">\${e.trustScore.toFixed(3)}</span>
                <div class="trust-track"><div class="trust-fill" style="width: \${pct}%;"></div></div>
              </div>
            </td>
            <td style="font-family: var(--font-mono); font-size: 0.82rem;">\${e.evidence.successes}/\${e.evidence.totalTrials}</td>
            <td style="font-family: var(--font-mono); font-size: 0.82rem; color: \${e.temporal.isDrifting ? 'var(--probation)' : 'var(--text-faint)'}">
              \${e.temporal.isDrifting ? '⚠ ' + e.temporal.driftDelta.toFixed(3) : '✓ stable'}
            </td>
            <td style="font-size: 0.8rem; color: var(--text-muted); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              \${e.lastNote ? '"' + e.lastNote + '"' : '—'}
            </td>
            <td>
              <button class="btn" style="padding: 4px 8px; font-size: 0.75rem;" onclick="inspectEntity('\${e.key.id}')">Inspect</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function populateDecomposerSelect() {
      const sel = document.getElementById('decomposerSelect');
      const ents = state.entities || [];
      sel.innerHTML = ents.map(e => {
        const keyLabel = e.key.namespace ? \`\${e.key.namespace}/\${e.key.kind}/\${e.key.id}\` : \`\${e.key.kind}/\${e.key.id}\`;
        return \`<option value="\${e.key.id}">\${keyLabel} (\${e.status}, T=\${e.trustScore.toFixed(3)})</option>\`;
      }).join('');
      updateDecomposer();
    }

    function inspectEntity(id) {
      switchTab('decomposer');
      const sel = document.getElementById('decomposerSelect');
      sel.value = id;
      updateDecomposer();
    }

    function updateDecomposer() {
      const id = document.getElementById('decomposerSelect').value;
      const entity = (state.entities || []).find(e => e.key.id === id);
      const container = document.getElementById('decomposerFactors');
      if (!entity) {
        container.innerHTML = '<p style="color: var(--text-faint)">Select an entity above.</p>';
        return;
      }

      const c = entity.components;
      container.innerHTML = \`
        <div class="factor-card">
          <div class="factor-header"><span>Wilson 95% Confidence Floor (W)</span><span style="font-family: var(--font-mono); color: #10b981;">\${c.wilson.toFixed(3)}</span></div>
          <div class="factor-desc">Derived from \${entity.evidence.successes} successes in \${entity.evidence.totalTrials} trials with Wilson continuity correction.</div>
        </div>
        <div class="factor-card">
          <div class="factor-header"><span>Guard Verdict Factor (G)</span><span style="font-family: var(--font-mono); color: #6366f1;">\${c.guard.toFixed(3)}</span></div>
          <div class="factor-desc">Multiplier from deterministic harness and automated oracle verification reports.</div>
        </div>
        <div class="factor-card">
          <div class="factor-header"><span>Recency Time-Decay (λ)</span><span style="font-family: var(--font-mono); color: #f59e0b;">\${c.recency.toFixed(3)}</span></div>
          <div class="factor-desc">Half-life decay factor modeling aging evidence without usage.</div>
        </div>
        <div class="factor-card">
          <div class="factor-header"><span>Durability Multiplier (D)</span><span style="font-family: var(--font-mono); color: #a855f7;">\${c.durability.toFixed(3)}</span></div>
          <div class="factor-desc">Cross-session durability anchor scaling.</div>
        </div>
        <div class="factor-card">
          <div class="factor-header"><span>Ceiling Cap (C)</span><span style="font-family: var(--font-mono); color: #94a3b8;">\${c.ceiling.toFixed(3)}</span></div>
          <div class="factor-desc">Structural upper bound ceiling for this entity kind.</div>
        </div>
      \`;
    }

    async function runSimulation() {
      const id = document.getElementById('decomposerSelect').value;
      const signal = document.getElementById('simulateSignal').value;
      const resContainer = document.getElementById('simulationResult');
      resContainer.style.display = 'block';
      resContainer.innerHTML = '<span style="color: var(--text-muted)">Simulating...</span>';

      try {
        const res = await fetch('/api/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, signal })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const deltaColor = data.deltaTrust >= 0 ? '#10b981' : '#f43f5e';
        const sign = data.deltaTrust >= 0 ? '+' : '';
        resContainer.innerHTML = \`
          <div style="font-weight: 700; margin-bottom: 8px;">Simulation Outcome:</div>
          <div style="display: flex; gap: 16px; font-size: 0.85rem; font-family: var(--font-mono);">
            <div>Before: <strong>\${data.before.trustScore.toFixed(3)}</strong> (\${data.before.status})</div>
            <div>➔</div>
            <div>After: <strong>\${data.after.trustScore.toFixed(3)}</strong> (\${data.after.status})</div>
            <div style="color: \${deltaColor}; font-weight: 700;">\${sign}\${data.deltaTrust.toFixed(3)}</div>
          </div>
        \`;
      } catch (err) {
        resContainer.innerHTML = \`<span style="color: var(--quarantined)">Simulation error: \${err.message}</span>\`;
      }
    }

    function updatePackerControls() {
      document.getElementById('lblBudget').textContent = document.getElementById('rngBudget').value;
      document.getElementById('lblExploration').textContent = document.getElementById('rngExploration').value + '%';
      document.getElementById('lblMinTrust').textContent = (document.getElementById('rngMinTrust').value / 100).toFixed(2);
    }

    async function runInteractivePack() {
      const budget = parseInt(document.getElementById('rngBudget').value, 10);
      const explorationRatio = parseInt(document.getElementById('rngExploration').value, 10) / 100;
      const minTrust = parseInt(document.getElementById('rngMinTrust').value, 10) / 100;
      const statsDiv = document.getElementById('packerStats');
      const listDiv = document.getElementById('packerSelectedList');

      statsDiv.innerHTML = '<span style="color: var(--text-muted)">Packing...</span>';

      try {
        const res = await fetch('/api/pack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ budget, explorationRatio, minTrust })
        });
        const data = await res.json();
        const outcome = data.outcome || data;

        const pct = (outcome.utilization * 100).toFixed(1);
        statsDiv.innerHTML = \`
          <div>Tokens: <strong>\${outcome.totalCost} / \${budget}</strong> (\${pct}% utilized)</div>
          <div>Selected: <strong>\${outcome.selected.length}</strong></div>
          <div>Probation Slot: <strong>\${outcome.probationCount}</strong></div>
          <div>Merit Slot: <strong>\${outcome.meritCount}</strong></div>
        \`;

        if (!outcome.selected || outcome.selected.length === 0) {
          listDiv.innerHTML = '<p style="color: var(--text-faint); padding: 1.5rem; text-align: center;">No entities fit in the requested budget.</p>';
          return;
        }

        listDiv.innerHTML = outcome.selected.map(item => {
          const keyLabel = item.key.namespace ? \`\${item.key.namespace}/\${item.key.kind}/\${item.key.id}\` : \`\${item.key.kind}/\${item.key.id}\`;
          return \`
            <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
              <div>
                <span class="entity-id" style="font-size: 0.88rem;">\${keyLabel}</span>
                <span class="badge" style="margin-left: 8px;">\${item.admittedBy}</span>
                \${item.hint.lastNote ? '<div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">"' + item.hint.lastNote + '"</div>' : ''}
              </div>
              <div style="text-align: right; font-family: var(--font-mono); font-size: 0.82rem;">
                <div style="color: #818cf8; font-weight: 700;">\${item.cost} tokens</div>
                <div style="color: var(--text-faint); font-size: 0.74rem;">T: \${item.hint.trustScore.toFixed(3)}</div>
              </div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        statsDiv.innerHTML = \`<span style="color: var(--quarantined)">Pack error: \${err.message}</span>\`;
      }
    }

    function copyPromptContext() {
      const budget = document.getElementById('rngBudget').value;
      const text = \`# Medha Evidential Context\\nBudget: \${budget} tokens\\n\\n\` +
        Array.from(document.querySelectorAll('#packerSelectedList .entity-id')).map(el => \`- \${el.textContent}\`).join('\\n');
      navigator.clipboard.writeText(text);
      const btn = document.getElementById('btnCopyPrompt');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = '📋 Copy Prompt Markdown'; }, 2000);
    }

    function renderTimeline() {
      const q = (document.getElementById('timelineFilter')?.value || '').toLowerCase();
      const container = document.getElementById('timelineList');
      const episodes = [...(state.episodes || [])].reverse();

      const filtered = episodes.filter(ep => {
        if (!q) return true;
        const note = (ep.note || '').toLowerCase();
        const author = (ep.author || '').toLowerCase();
        const seq = String(ep.seq);
        return note.includes(q) || author.includes(q) || seq.includes(q);
      });

      if (filtered.length === 0) {
        container.innerHTML = '<p style="color: var(--text-faint); padding: 2rem; text-align: center;">No episodes recorded yet.</p>';
        return;
      }

      container.innerHTML = filtered.map(ep => {
        const isRetracted = ep.type === 'retract';
        const keyLabel = ep.key.namespace ? \`\${ep.key.namespace}/\${ep.key.kind}/\${ep.key.id}\` : \`\${ep.key.kind}/\${ep.key.id}\`;
        const timeStr = new Date(ep.at).toLocaleString();
        return \`
          <div class="timeline-item \${isRetracted ? 'retracted' : ''}">
            <div class="timeline-meta">
              <span class="badge" style="font-weight: 700;">#\${ep.seq}</span>
              <span class="pill pill-active" style="padding: 2px 6px; font-size: 0.68rem;">\${ep.type}</span>
              <span class="entity-id">\${keyLabel}</span>
              <span>• \${timeStr}</span>
              \${ep.author ? '<span class="badge" style="color: #93c5fd;">@' + ep.author + '</span>' : ''}
            </div>
            \${ep.note ? '<div class="note-box">"' + ep.note + '"</div>' : ''}
            \${isRetracted ? '<div style="color: var(--quarantined); font-size: 0.8rem;">Retracted sequence #' + ep.targetSeq + ' — Reason: ' + ep.reason + '</div>' : ''}
          </div>
        \`;
      }).join('');
    }

    async function refreshData() {
      try {
        const [statusRes, entitiesRes, episodesRes] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/entities').then(r => r.json()),
          fetch('/api/episodes').then(r => r.json())
        ]);
        state = { ...state, status: statusRes, entities: entitiesRes, episodes: episodesRes };
        renderMetrics();
        renderEntitiesTable();
        renderTimeline();
      } catch (err) {
        console.error('Refresh error:', err);
      }
    }

    // Initialize
    renderMetrics();
    renderEntitiesTable();
  </script>
</body>
</html>
`;
}

async function collectDashboardData(
  opened: OpenedHome,
  now: number,
): Promise<{
  readonly status: StatusReport;
  readonly hints: readonly EvidentialHint[];
  readonly episodes: readonly Episode[];
}> {
  const [preflight, hints, episodes] = await Promise.all([
    opened.engine.preflight({ now }),
    pageAll(opened.engine, now),
    opened.store.episodes(),
  ]);

  const byStatus = Object.fromEntries(
    LIFECYCLE_STATUSES.map((status) => [
      status,
      hints.filter((hint) => hint.status === status).length,
    ]),
  ) as Record<(typeof LIFECYCLE_STATUSES)[number], number>;
  const drifting = hints.filter((hint) => hint.temporal.isDrifting).length;

  const status: StatusReport = {
    home: opened.home,
    asOf: now,
    backend: opened.config.backend,
    path: opened.config.path,
    preflight,
    byStatus,
    drifting,
    params: paramsReport(now),
  };

  return { status, hints, episodes };
}

export async function startUiServer(
  options: UiOptions,
  environment: Environment,
): Promise<UiServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort =
    options.port !== undefined && options.port !== '' ? Number(options.port) : 8448;

  const opened = openHome(options.dir ?? environment.cwd, options.home);
  await opened.store.open();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${requestedPort}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 1. Root: Serves Interactive SPA Dashboard
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const { status, hints, episodes } = await collectDashboardData(opened, environment.now());
        const html = generateDashboardHtml({
          status,
          entities: hints,
          episodes,
          version: VERSION,
          home: opened.home,
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 2. Standalone Downloadable Report
      if (url.pathname === '/report') {
        const { status, hints, episodes } = await collectDashboardData(opened, environment.now());
        const html = generateDashboardHtml({
          status,
          entities: hints,
          episodes,
          version: VERSION,
          home: opened.home,
        });

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'inline; filename="medha-report.html"',
        });
        res.end(html);
        return;
      }

      // 3. API: Status
      if (url.pathname === '/api/status') {
        const { status } = await collectDashboardData(opened, environment.now());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(toJson(status));
        return;
      }

      // 4. API: Entities
      if (url.pathname === '/api/entities') {
        const hints = await pageAll(opened.engine, environment.now());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(toJson(hints));
        return;
      }

      // 5. API: Episodes
      if (url.pathname === '/api/episodes') {
        const episodes = await opened.store.episodes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(toJson(episodes));
        return;
      }

      // 6. API: POST /api/simulate
      if (url.pathname === '/api/simulate' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || '{}') as {
          id?: string;
          kind?: string;
          namespace?: string;
          signal?: string;
        };
        const key: EntityKey = {
          namespace: parsed.namespace ?? '',
          kind: parsed.kind ?? 'rule',
          id: parsed.id ?? '',
        };
        const delta = await opened.engine.simulate(key, parsed.signal ?? 'APPLY', {
          now: environment.now(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(toJson(delta));
        return;
      }

      // 7. API: POST /api/pack
      if (url.pathname === '/api/pack' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || '{}') as {
          budget?: number;
          kind?: string;
          namespace?: string;
          explorationRatio?: number;
          minTrust?: number;
        };
        const outcome = await opened.engine.pack(
          {
            budget: parsed.budget ?? 1500,
            kind: parsed.kind ?? 'rule',
            ...(parsed.namespace === undefined ? {} : { namespace: parsed.namespace }),
            ...(parsed.explorationRatio === undefined
              ? {}
              : { explorationRatio: parsed.explorationRatio }),
            ...(parsed.minTrust === undefined ? {} : { minTrust: parsed.minTrust }),
          },
          { now: environment.now() },
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(toJson(outcome));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : requestedPort;
      const url = `http://${host}:${actualPort}`;

      if (options.open === true) {
        openBrowser(url);
      }

      resolve({
        url,
        port: actualPort,
        host,
        close: async () => {
          await new Promise<void>((res) => server.close(() => res()));
          await opened.engine.close();
        },
      });
    });
  });
}
