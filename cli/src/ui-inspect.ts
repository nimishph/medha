/**
 * The dashboard's Inspect tab, written for people who have never read the trust model.
 *
 * Plain words on purpose: "confidence" not "trust score", "independent check" not "guard",
 * "track record" not "Wilson lower bound", "On trial / Working / Proven" not
 * "probation / active / trusted". The real names stay in tooltips and behind "Show the math".
 *
 * These are plain strings spliced into the page by `generateDashboardHtml`, so the client script
 * avoids backticks and `${}` (it builds strings by concatenation) and never writes a closing
 * script tag.
 */

export const INSPECT_VIEW_CSS = `
    .inspect-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 1.5rem; }
    @media (max-width: 900px) { .inspect-grid { grid-template-columns: 1fr; } }
    .ix-h { font-weight: 700; margin: 0 0 4px 0; font-size: 1.02rem; }
    .ix-sub { font-size: 0.8rem; color: var(--text-muted); margin: 0 0 1rem 0; }
    .ix-headline { font-size: 1.15rem; line-height: 1.5; margin: 0.75rem 0 0.25rem 0; }
    .ix-headline b { color: #fff; }
    .ix-lead { color: var(--text-muted); font-size: 0.88rem; margin: 0 0 1rem 0; }
    .ix-stages { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0.5rem 0 0.25rem 0; }
    .ix-stage { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--border-subtle); font-size: 0.8rem; color: var(--text-faint); background: rgba(0,0,0,0.2); }
    .ix-stage.on { color: #fff; font-weight: 700; border-color: currentColor; }
    .ix-arrow { color: var(--text-faint); }
    .ix-sidenote { font-size: 0.74rem; color: var(--text-faint); margin-left: 6px; }
    .ix-scale { position: relative; height: 10px; border-radius: 5px; margin: 1.6rem 0 0.4rem 0; background: linear-gradient(to right, var(--probation) 0 25%, var(--active) 25% 60%, var(--trusted) 60% 100%); opacity: 0.85; }
    .ix-dot { position: absolute; top: -5px; width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 3px solid #0f172a; transform: translateX(-50%); box-shadow: 0 0 0 2px #fff3; }
    .ix-scale-labels { display: flex; font-size: 0.72rem; color: var(--text-faint); }
    .ix-row { padding: 12px 0; border-top: 1px solid var(--border-subtle); }
    .ix-row:first-of-type { border-top: 0; }
    .ix-row-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
    .ix-row-name { font-weight: 600; font-size: 0.9rem; }
    .ix-mult { font-family: var(--font-mono); font-size: 0.82rem; color: #a5b4fc; white-space: nowrap; }
    .ix-meter { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.08); margin: 6px 0; overflow: hidden; }
    .ix-meter > i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(to right, #6366f1, #10b981); }
    .ix-say { font-size: 0.82rem; color: var(--text-muted); line-height: 1.45; }
    .ix-flag { font-size: 0.68rem; margin-left: 8px; }
    .ix-sum { margin-top: 10px; padding: 10px 12px; border-radius: var(--radius-sm); background: rgba(99,102,241,0.08); border-left: 3px solid #6366f1; font-size: 0.85rem; }
    .ix-check { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; font-size: 0.87rem; }
    .ix-check .mark { width: 20px; text-align: center; font-weight: 700; }
    .ix-check.ok .mark { color: var(--success); }
    .ix-check.no .mark { color: var(--probation); }
    .ix-note { font-size: 0.8rem; padding: 10px 12px; border-radius: var(--radius-sm); margin: 10px 0; background: rgba(245,158,11,0.1); border-left: 3px solid var(--probation); color: #fde68a; }
    .ix-cmd { font-family: var(--font-mono); font-size: 0.76rem; background: rgba(0,0,0,0.35); padding: 8px 10px; border-radius: 6px; word-break: break-all; margin: 6px 0; }
    .ix-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px 0; }
    .ix-chip { cursor: pointer; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border-subtle); background: rgba(255,255,255,0.04); color: var(--text-main); font-size: 0.8rem; font-family: inherit; }
    .ix-chip:hover { border-color: var(--primary); background: var(--primary-subtle); }
    .ix-chip.good { border-color: var(--success-border); }
    .ix-chip.bad { border-color: var(--danger-border); }
    .ix-queue { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 0.8rem; margin-bottom: 10px; color: var(--text-muted); }
    .ix-q { padding: 3px 10px; border-radius: 6px; background: rgba(99,102,241,0.15); color: #c7d2fe; cursor: pointer; }
    .ix-q:hover { text-decoration: line-through; }
    .ix-frame { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border-subtle); font-size: 0.82rem; }
    .ix-frame.change { background: rgba(99,102,241,0.08); }
    .ix-hist { font-size: 0.84rem; padding: 7px 0; border-top: 1px solid var(--border-subtle); display: flex; gap: 10px; flex-wrap: wrap; }
    .ix-hist time { color: var(--text-faint); min-width: 110px; }
    .ix-math summary { cursor: pointer; font-size: 0.8rem; color: var(--text-muted); margin-top: 10px; }
    .ix-math pre { font-family: var(--font-mono); font-size: 0.76rem; color: #c7d2fe; white-space: pre-wrap; }
`;

export const INSPECT_VIEW_HTML = `
    <section id="viewDecomposer" class="tab-view">
      <div class="card">
        <label style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted);">Pick a rule to look at:</label>
        <select id="decomposerSelect" class="search-input" style="width: 100%; margin-top: 6px;" onchange="resetWhatIf(); updateDecomposer()"></select>
        <div id="ixHeadline"></div>
      </div>

      <div class="inspect-grid">
        <div class="card">
          <h3 class="ix-h">Why this score?</h3>
          <p class="ix-sub">Confidence is built from four simple things, multiplied together.</p>
          <div id="ixWhy"></div>
        </div>
        <div class="card">
          <h3 class="ix-h">Independent check</h3>
          <p class="ix-sub">A test, a linter or a review that confirms the rule is still right.</p>
          <div id="ixCheck"></div>
        </div>
      </div>

      <div class="inspect-grid">
        <div class="card">
          <h3 class="ix-h">What happens next?</h3>
          <p class="ix-sub">What this rule still needs to move up, or what could knock it down.</p>
          <div id="ixNext"></div>
        </div>
        <div class="card">
          <h3 class="ix-h">Try it: "what if...?"</h3>
          <p class="ix-sub">Pick things that might happen, in order. Nothing is saved; this is only a preview.</p>
          <div id="ixWhatIfChips"></div>
          <div id="ixQueue"></div>
          <div id="ixFrames"></div>
        </div>
      </div>

      <div class="card" style="margin-top: 1.5rem;">
        <h3 class="ix-h">What has happened so far</h3>
        <p class="ix-sub">Every time this rule was used, checked or changed, newest first.</p>
        <div id="ixHistory"></div>
      </div>

      <div class="card" style="margin-top: 1.5rem;" id="decomposerTreeCard">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div>
            <h3 style="font-weight: 700; margin: 0;">Decision Tree &amp; Branch Governance</h3>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px; margin-bottom: 0;">
              "If this situation, then do this" branches under the rule, each with its own record of what worked:
            </p>
          </div>
          <span id="decomposerTreeBadge" class="badge badge-secondary">0 branches</span>
        </div>
        <div id="decomposerTreeForest" style="margin-top: 1rem;"></div>
      </div>
    </section>
`;

export const INSPECT_VIEW_JS = String.raw`
    var STAGES = {
      probation: { name: "On trial", color: "var(--probation)" },
      active: { name: "Working", color: "var(--active)" },
      trusted: { name: "Proven", color: "var(--trusted)" },
      quarantined: { name: "Paused", color: "var(--quarantined)" },
      retired: { name: "Retired", color: "var(--retired)" }
    };
    var DEFAULT_MODEL = { active: 0.25, trusted: 0.6, minUsesForTrusted: 5, minUsesForRetired: 3,
      retiredTrustThreshold: 0.1, unguardedCeiling: 0.5, recencyHalfLifeDays: 45, recencyFloor: 0.3 };
    var SIGNAL_TEXT = {
      APPLY: { label: "It worked", cls: "good", tip: "Counts as a try that succeeded." },
      REJECT_RULE: { label: "It didn't work", cls: "bad", tip: "Counts as a try that failed." },
      SKIP: { label: "Skipped it", cls: "", tip: "Not counted either way." },
      REJECT_CONTEXT: { label: "Not right for this situation", cls: "", tip: "Not counted as a try; nudges the record slightly down." }
    };
    var DAY_MS = 86400000;
    var inspectState = { detail: null, steps: [], frames: null, token: 0, error: null };

    function stageName(s) { return (STAGES[s] || { name: s }).name; }
    function stageColor(s) { return (STAGES[s] || { color: "var(--text-main)" }).color; }
    function signalLabel(n) { return (SIGNAL_TEXT[n] || { label: n }).label; }
    function pct(x) { return Math.round(x * 100) + "%"; }
    function f2(x) { return Number(x).toFixed(2); }
    function fmtDate(ms) {
      if (ms == null) return "never";
      return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
    function daysBetween(then, now) { return Math.max(0, Math.floor((now - then) / DAY_MS)); }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
    function keyText(k) { return (k.namespace ? k.namespace + "/" : "") + k.kind + "/" + k.id; }
    function encKey(k) { return encodeURIComponent(JSON.stringify([k.namespace, k.kind, k.id])); }

    function selectedKey() {
      var sel = document.getElementById("decomposerSelect");
      if (!sel || !sel.value) return null;
      try {
        var a = JSON.parse(decodeURIComponent(sel.value));
        return { namespace: a[0], kind: a[1], id: a[2] };
      } catch (e) { return null; }
    }
    function sameKey(a, b) { return a.namespace === b.namespace && a.kind === b.kind && a.id === b.id; }

    function resetWhatIf() { inspectState.steps = []; inspectState.frames = null; }

    function populateDecomposerSelect() {
      var sel = document.getElementById("decomposerSelect");
      var prev = sel.value;
      var ents = state.entities || [];
      sel.innerHTML = ents.map(function (e) {
        return "<option value='" + escapeHtml(encKey(e.key)) + "'>" + escapeHtml(keyText(e.key)) +
          " (" + escapeHtml(stageName(e.status)) + ", confidence " + f2(e.trustScore) + ")</option>";
      }).join("");
      if (prev) sel.value = prev;
      if (!sel.value && ents.length) sel.selectedIndex = 0;
      updateDecomposer();
    }

    function inspectEntity(id, ns, kind) {
      switchTab("decomposer");
      var sel = document.getElementById("decomposerSelect");
      var ents = state.entities || [];
      var hit = ents.find(function (e) {
        return e.key.id === id && (ns === undefined || e.key.namespace === ns) && (kind === undefined || e.key.kind === kind);
      });
      if (hit) sel.value = encKey(hit.key);
      resetWhatIf();
      updateDecomposer();
    }

    // Used when the page is a saved report with no live server behind it.
    function fallbackDetail(entity) {
      var g = entity.components.guard;
      var cond = g === 1 ? "passed" : g === 0 ? "failed" : g === 0.8 ? "unverified" : "none";
      var eps = (state.episodes || []).filter(function (ep) { return sameKey(ep.key, entity.key); });
      var lastSig = null;
      eps.forEach(function (ep) { if (ep.type === "signal") lastSig = ep.at; });
      return {
        key: entity.key, known: true, asOf: entity.asOf, hint: entity, gates: [],
        guard: { kind: cond === "none" ? "none" : "check", condition: cond, lastOk: cond === "passed" ? true : cond === "failed" ? false : null, lastOkAt: null },
        override: null, lastSignalAt: lastSig, thresholds: DEFAULT_MODEL, live: false,
        signals: Object.keys(SIGNAL_TEXT).map(function (n) { return { name: n }; }),
        episodes: eps
      };
    }

    async function updateDecomposer() {
      var key = selectedKey();
      var entity = key ? (state.entities || []).find(function (e) { return sameKey(e.key, key); }) : null;
      var head = document.getElementById("ixHeadline");
      var token = ++inspectState.token;

      renderBranches(entity);
      if (!entity) {
        head.innerHTML = "<p class='ix-lead' style='margin-top:1rem'>Pick a rule above to see how it is doing.</p>";
        ["ixWhy", "ixCheck", "ixNext", "ixWhatIfChips", "ixQueue", "ixFrames", "ixHistory"].forEach(function (id) {
          document.getElementById(id).innerHTML = "";
        });
        return;
      }
      var detail;
      try {
        var q = "?namespace=" + encodeURIComponent(key.namespace) + "&kind=" + encodeURIComponent(key.kind) + "&id=" + encodeURIComponent(key.id);
        var res = await fetch("/api/inspect" + q);
        detail = await res.json();
        if (detail.error) throw new Error(detail.error);
        detail.live = true;
      } catch (err) {
        detail = fallbackDetail(entity);
      }
      if (token !== inspectState.token) return;
      inspectState.detail = detail;
      renderInspect();
      if (inspectState.steps.length) runWhatIf();
    }

    function renderBranches(entity) {
      var treeForest = document.getElementById("decomposerTreeForest");
      var treeBadge = document.getElementById("decomposerTreeBadge");
      var tree = [];
      if (entity) {
        var k = entity.key;
        var keyStr = (k.namespace ? k.namespace : "") + "\u0000" + k.kind + "\u0000" + k.id;
        tree = (state.decisionTrees && (state.decisionTrees[keyStr] || state.decisionTrees[k.id])) || [];
      }
      treeBadge.textContent = tree.length + " branch" + (tree.length === 1 ? "" : "es");
      treeBadge.className = tree.length > 0 ? "badge badge-primary" : "badge badge-secondary";
      treeForest.innerHTML = entity ? renderDecisionForest(tree) : "";
    }

    function stageSentence(d) {
      var h = d.hint;
      var m = d.thresholds;
      switch (h.status) {
        case "probation": return "It has not earned enough confidence yet. Keep using it, and have it checked.";
        case "active": return "It is earning its keep. More successful uses and a passing independent check will make it Proven.";
        case "trusted": return "It has a strong record and has passed an independent check.";
        case "quarantined":
          if (d.override === "quarantined") return "Someone paused it by hand, so it is not being offered.";
          if (d.guard.condition === "failed") return "Its last independent check failed, so it is paused until a check passes.";
          return "Its recent results have been much worse than where it started, so it is paused.";
        case "retired": return "It kept failing (or was retired by hand), so it is no longer offered.";
        default: return "";
      }
    }

    function renderHeadline(d) {
      var h = d.hint;
      var order = ["probation", "active", "trusted"];
      var stages = order.map(function (s) {
        var on = h.status === s;
        return "<span class='ix-stage" + (on ? " on" : "") + "' style='" + (on ? "color:" + stageColor(s) : "") + "'>" + stageName(s) + "</span>";
      }).join("<span class='ix-arrow'>&rarr;</span>");
      var side = ["quarantined", "retired"].map(function (s) {
        var on = h.status === s;
        return "<span class='ix-stage" + (on ? " on" : "") + "' style='" + (on ? "color:" + stageColor(s) : "") + "'>" + stageName(s) + "</span>";
      }).join("");
      var m = d.thresholds;
      var dot = Math.max(0, Math.min(1, h.trustScore)) * 100;
      document.getElementById("ixHeadline").innerHTML =
        "<p class='ix-headline'><b>" + escapeHtml(keyText(d.key)) + "</b> is <b style='color:" + stageColor(h.status) + "'>" + stageName(h.status) +
        "</b>. Confidence: <b>" + f2(h.trustScore) + "</b> out of 1.</p>" +
        "<p class='ix-lead'>" + escapeHtml(stageSentence(d)) + "</p>" +
        (d.known ? "" : "<p class='ix-note'>This rule has no record yet, so this is where a brand-new one would start.</p>") +
        "<div class='ix-stages'>" + stages + "<span class='ix-sidenote'>can also be</span>" + side + "</div>" +
        "<div class='ix-scale' title='Confidence from 0 to 1'><div class='ix-dot' style='left:" + dot + "%'></div></div>" +
        "<div class='ix-scale-labels'><span style='width:25%'>0</span><span style='width:35%'>" + f2(m.active) + " Working starts</span>" +
        "<span style='flex:1'>" + f2(m.trusted) + " Proven starts (also needs " + m.minUsesForTrusted + " uses and a passed check)</span></div>";
    }

    function renderWhy(d) {
      var h = d.hint, c = h.components, m = d.thresholds, ev = h.evidence;
      var rows = [];
      var trackSay = ev.totalTrials === 0
        ? "Not used yet. No record means no confidence."
        : "It worked " + ev.successes + " out of " + plural(ev.totalTrials, "time", "times") + ". We stay cautious with small numbers, so this counts as " + pct(c.wilson) + ".";
      rows.push({ name: "Track record", val: c.wilson, mult: "x" + f2(c.wilson), say: trackSay, hold: true });

      var g = d.guard, checkSay;
      if (g.condition === "none") checkSay = "No independent check has ever been reported, so confidence can never go above " + pct(m.unguardedCeiling) + ".";
      else if (g.condition === "unverified") checkSay = "A check (" + g.kind + ") is set up but has not reported a result yet.";
      else if (g.condition === "passed") checkSay = "The last check (" + g.kind + ") passed" + (g.lastOkAt ? " on " + fmtDate(g.lastOkAt) : "") + ". Nothing is holding it back here.";
      else checkSay = "The last check (" + g.kind + ") failed. Confidence stays at zero until a check passes.";
      rows.push({ name: "Has it been checked?", val: c.guard, mult: "x" + f2(c.guard), say: checkSay, hold: true });

      var freshSay;
      if (d.lastSignalAt == null) freshSay = "Never used, so it sits at the minimum of " + pct(m.recencyFloor) + ".";
      else {
        var days = daysBetween(d.lastSignalAt, h.asOf);
        freshSay = "Last used " + (days === 0 ? "today" : plural(days, "day", "days") + " ago") + ". Confidence fades by half every " + m.recencyHalfLifeDays + " days if it is not used, but never below " + pct(m.recencyFloor) + ".";
      }
      rows.push({ name: "How recently it was used", val: c.recency, mult: "x" + f2(c.recency), say: freshSay, hold: true });

      var durSay;
      if (c.durability > 1) durSay = "It has held up over several separate periods, which earns a small bonus.";
      else if (g.condition === "none") durSay = "The bonus only starts once an independent check exists.";
      else durSay = "No bonus yet. It needs to keep succeeding over more than one period.";
      rows.push({ name: "Held up over time", val: Math.min(1, (c.durability - 1) / 0.5), mult: "x" + f2(c.durability), say: durSay, hold: false });

      var holdIdx = -1, low = 0.95;
      rows.forEach(function (r, i) { if (r.hold && r.val < low) { low = r.val; holdIdx = i; } });

      var html = rows.map(function (r, i) {
        return "<div class='ix-row'><div class='ix-row-top'><span class='ix-row-name'>" + r.name +
          (i === holdIdx ? "<span class='badge badge-warning ix-flag'>Holding it back most</span>" : "") +
          "</span><span class='ix-mult'>" + r.mult + "</span></div>" +
          "<div class='ix-meter'><i style='width:" + Math.round(Math.max(0, Math.min(1, r.val)) * 100) + "%'></i></div>" +
          "<div class='ix-say'>" + escapeHtml(r.say) + "</div></div>";
      }).join("");

      var capped = (c.wilson * c.guard * c.recency * c.durability) > c.ceiling + 1e-9;
      var off = h.status === "quarantined" || h.status === "retired";
      html += "<div class='ix-sum'>" + (off
        ? "Shown confidence is <b>0</b> because this rule is " + stageName(h.status).toLowerCase() + ", whatever its record says."
        : "Put together: " + f2(c.wilson) + " x " + f2(c.guard) + " x " + f2(c.recency) + " x " + f2(c.durability) + " = <b>" + f2(c.wilson * c.guard * c.recency * c.durability) + "</b>" +
          (capped ? ", limited to <b>" + f2(c.ceiling) + "</b> because it has no passed check" : "") + ".") + "</div>";
      html += "<details class='ix-math'><summary>Show the math</summary><pre>confidence = the smaller of\n  limit (" + f2(c.ceiling) + ")  and\n  track record (Wilson lower bound) " + f2(c.wilson) +
        "\n  x check result " + f2(c.guard) + "\n  x recency decay " + f2(c.recency) + "\n  x durability " + f2(c.durability) +
        "\n= " + f2(h.trustScore) + "</pre></details>";
      document.getElementById("ixWhy").innerHTML = html;
    }

    function guardCommand(d, ok) {
      var parts = ["medha guard", "--id " + d.key.id];
      if (d.key.namespace) parts.push("--namespace " + d.key.namespace);
      if (d.key.kind !== "rule") parts.push("--kind " + d.key.kind);
      parts.push(ok ? "--ok" : "--fail");
      parts.push("--guard " + (d.guard.condition === "none" ? "review" : d.guard.kind));
      return parts.join(" ");
    }

    function renderCheck(d) {
      var g = d.guard;
      var pill = { none: ["badge-secondary", "Never checked"], unverified: ["badge-warning", "Set up, no result yet"], passed: ["badge-success", "Passed"], failed: ["badge-danger", "Failed"] }[g.condition];
      var html = "<p><span class='badge " + pill[0] + "'>" + pill[1] + "</span>" +
        (g.condition === "none" ? "" : " <span class='ix-say'>check name: <b>" + escapeHtml(g.kind) + "</b>" + (g.lastOkAt ? ", last reported " + fmtDate(g.lastOkAt) : "") + "</span>") + "</p>";
      html += "<p class='ix-say'>Medha does not run checks itself. Your tests, linters or reviewers do, and then report the result back.</p>";
      html += "<div class='ix-row'><div class='ix-say'><b>Why it matters:</b> a rule can be used a lot and still be wrong. Without a passing check its confidence is capped at " + pct(d.thresholds.unguardedCeiling) + " and it can never become Proven. A failing check pauses it.</div></div>";
      if (g.condition === "none") {
        html += "<div class='ix-note'>Tip: always give the check a name when you report it (for example <b>--guard review</b>). A result with no name is still treated as no check at all.</div>";
      }
      html += "<div class='ix-say' style='margin-top:10px'>To report that the check passed, run:</div><div class='ix-cmd'>" + escapeHtml(guardCommand(d, true)) + "</div>";
      html += "<div class='ix-say'>And if it failed:</div><div class='ix-cmd'>" + escapeHtml(guardCommand(d, false)) + "</div>";
      html += "<div class='ix-chips'><button class='ix-chip good' onclick=\"addStep('guard', true)\">Preview: the check passes</button>" +
        "<button class='ix-chip bad' onclick=\"addStep('guard', false)\">Preview: the check fails</button></div>";
      document.getElementById("ixCheck").innerHTML = html;
    }

    function checklistRow(ok, text) {
      return "<div class='ix-check " + (ok ? "ok" : "no") + "'><span class='mark'>" + (ok ? "&#10003;" : "&#9675;") + "</span><span>" + text + "</span></div>";
    }

    function renderNext(d) {
      var h = d.hint, m = d.thresholds, ev = h.evidence, html = "";
      var s = h.status;
      if (s === "probation" || s === "active") {
        var target = s === "probation" ? "Working" : "Proven";
        html += "<p class='ix-say'>To become <b>" + target + "</b>, it needs:</p>";
        html += checklistRow(h.trustScore >= (s === "probation" ? m.active : m.trusted),
          "Confidence of at least " + f2(s === "probation" ? m.active : m.trusted) + " (now " + f2(h.trustScore) + ")");
        if (s === "active") {
          html += checklistRow(ev.totalTrials >= m.minUsesForTrusted, "Used at least " + m.minUsesForTrusted + " times (so far " + ev.totalTrials + ")");
          html += checklistRow(d.guard.condition === "passed", "A passing independent check" + (d.guard.condition === "passed" ? "" : " (" + ({ none: "none has been reported", unverified: "no result yet", failed: "the last one failed" }[d.guard.condition]) + ")"));
        }
      } else if (s === "trusted") {
        html += "<p class='ix-say'>Nothing more is needed. It already has a strong record and a passed check.</p>";
      } else if (s === "quarantined") {
        html += d.override === "quarantined"
          ? "<p class='ix-say'>It was paused by a person, so only a person can bring it back (an override to restore it).</p>"
          : d.guard.condition === "failed"
            ? "<p class='ix-say'>It comes back as soon as a later independent check passes.</p>"
            : "<p class='ix-say'>Its results have slipped well below where it started. A person should look into why, and restore it if the problem is fixed.</p>";
      } else {
        html += "<p class='ix-say'>Retired rules are only brought back by a person restoring them.</p>";
      }
      if (s !== "retired" && s !== "quarantined") {
        html += "<div class='ix-row'><div class='ix-say'><b>What could go wrong:</b><br>&bull; A failed independent check pauses it.<br>&bull; Failing at least " + m.minUsesForRetired +
          " times with confidence under " + f2(m.retiredTrustThreshold) + " retires it.<br>&bull; Results drifting well below where it started pause it.<br>&bull; Simply not being used never retires it. It just fades.</div></div>";
      }
      document.getElementById("ixNext").innerHTML = html;
    }

    function renderChips(d) {
      var live = d.live !== false;
      var html = "";
      if (!live) {
        html = "<div class='ix-note'>The preview needs the live dashboard (run <b>medha ui</b>). This saved report can only show the numbers above.</div>";
        document.getElementById("ixWhatIfChips").innerHTML = html;
        document.getElementById("ixQueue").innerHTML = "";
        document.getElementById("ixFrames").innerHTML = "";
        return;
      }
      html += "<div class='ix-say'>Something is used:</div><div class='ix-chips'>" + (d.signals || []).map(function (sg) {
        var t = SIGNAL_TEXT[sg.name] || { label: sg.name, cls: "", tip: "A custom signal registered for this project." };
        return "<button class='ix-chip " + t.cls + "' title='" + escapeHtml(t.tip) + "' onclick=\"addStep('signal', '" + escapeHtml(sg.name) + "')\">" + escapeHtml(t.label) + "</button>";
      }).join("") + "</div>";
      html += "<div class='ix-say'>Time passes:</div><div class='ix-chips'>" + [7, 30, 90].map(function (n) {
        return "<button class='ix-chip' onclick=\"addStep('advance', " + n + ")\">Wait " + n + " days</button>";
      }).join("") + "</div>";
      document.getElementById("ixWhatIfChips").innerHTML = html;
    }

    function stepLabel(st) {
      if (st.type === "signal") return signalLabel(st.signal);
      if (st.type === "guard") return st.ok ? "Check passes" : "Check fails";
      return "Wait " + st.days + " days";
    }

    function renderQueue() {
      var el = document.getElementById("ixQueue");
      if (!inspectState.detail || inspectState.detail.live === false) { el.innerHTML = ""; return; }
      if (!inspectState.steps.length) {
        el.innerHTML = "<div class='ix-say'>Nothing picked yet. Click a button above to see what it would change.</div>";
        return;
      }
      el.innerHTML = "<div class='ix-queue'>In this order: " + inspectState.steps.map(function (st, i) {
        return (i ? "<span>&rarr;</span>" : "") + "<span class='ix-q' title='Click to remove' onclick='removeStep(" + i + ")'>" + escapeHtml(stepLabel(st)) + "</span>";
      }).join("") + " <button class='btn' style='padding:3px 10px;font-size:0.75rem' onclick='clearSteps()'>Start over</button></div>";
    }

    function addStep(type, arg) {
      var d = inspectState.detail;
      if (!d || d.live === false) return;
      if (type === "signal") inspectState.steps.push({ type: "signal", signal: arg });
      else if (type === "guard") inspectState.steps.push({ type: "guard", ok: arg, kind: d.guard.condition === "none" ? "check" : undefined });
      else inspectState.steps.push({ type: "advance", days: arg });
      runWhatIf();
    }
    function removeStep(i) { inspectState.steps.splice(i, 1); runWhatIf(); }
    function clearSteps() { resetWhatIf(); renderQueue(); document.getElementById("ixFrames").innerHTML = ""; }

    async function runWhatIf() {
      renderQueue();
      var el = document.getElementById("ixFrames");
      var d = inspectState.detail;
      if (!d || !inspectState.steps.length) { el.innerHTML = ""; return; }
      try {
        var res = await fetch("/api/simulate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace: d.key.namespace, kind: d.key.kind, id: d.key.id, steps: inspectState.steps })
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error);
        inspectState.frames = data.frames;
        renderFrames();
      } catch (err) {
        el.innerHTML = "<div class='ix-note'>Could not run the preview: " + escapeHtml(err.message) + "</div>";
      }
    }

    function renderFrames() {
      var frames = inspectState.frames || [];
      if (!frames.length) return;
      var first = frames[0], last = frames[frames.length - 1];
      var html = frames.map(function (f, i) {
        var label = i === 0 ? "Right now" : stepLabel(inspectState.steps[i - 1] || { type: "advance", days: 0 });
        var delta = f.deltaTrust === 0 ? "" : " <span style='color:" + (f.deltaTrust > 0 ? "var(--success)" : "var(--danger)") + "'>(" + (f.deltaTrust > 0 ? "+" : "") + f2(f.deltaTrust) + ")</span>";
        var move = f.statusChanged ? "<b>" + stageName(f.previousStatus) + " &rarr; " + stageName(f.hint.status) + "</b>" : stageName(f.hint.status);
        return "<div class='ix-frame" + (f.statusChanged ? " change" : "") + "'><span>" + escapeHtml(label) + "</span><span>Confidence " + f2(f.hint.trustScore) + delta + "</span><span style='color:" + stageColor(f.hint.status) + "'>" + move + "</span></div>";
      }).join("");
      var summary;
      if (last.hint.status === first.hint.status && Math.abs(last.hint.trustScore - first.hint.trustScore) < 0.005) summary = "After all of this, nothing important changes.";
      else summary = "After all of this: " + (last.hint.status === first.hint.status ? "it stays " + stageName(last.hint.status) : "it goes from " + stageName(first.hint.status) + " to " + stageName(last.hint.status)) +
        ", with confidence moving from " + f2(first.hint.trustScore) + " to " + f2(last.hint.trustScore) + ".";
      document.getElementById("ixFrames").innerHTML = "<div class='ix-sum'>" + summary + "</div>" + html;
    }

    function episodeText(ep) {
      switch (ep.type) {
        case "signal": return signalLabel(ep.spec ? ep.spec.name : "signal");
        case "guard":
          if (!ep.kind || ep.kind === "none") return "Independent check " + (ep.ok ? "passed" : "failed") + " (no check name was given, so it still counts as unchecked)";
          return "Independent check " + (ep.ok ? "passed" : "failed") + " (" + ep.kind + ")";
        case "override": return "Set to " + ep.override + " by hand" + (ep.reason ? ": " + ep.reason : "");
        case "proposal": return "Proposed as a new rule";
        case "decision": return "Decision branch added or changed";
        case "retract": return "An earlier entry (#" + ep.targetSeq + ") was taken back";
        default: return ep.type;
      }
    }

    function renderHistory(d) {
      var eps = (d.episodes || []).slice().reverse().slice(0, 15);
      if (!eps.length) { document.getElementById("ixHistory").innerHTML = "<p class='ix-say'>Nothing recorded yet.</p>"; return; }
      document.getElementById("ixHistory").innerHTML = eps.map(function (ep) {
        return "<div class='ix-hist'><time>" + escapeHtml(fmtDate(ep.at)) + "</time><span>" + escapeHtml(episodeText(ep)) +
          (ep.author ? " <span class='ix-say'>by " + escapeHtml(ep.author) + "</span>" : "") +
          (ep.note ? " <span class='ix-say'>&ldquo;" + escapeHtml(ep.note) + "&rdquo;</span>" : "") + "</span></div>";
      }).join("");
    }

    function renderInspect() {
      var d = inspectState.detail;
      renderHeadline(d);
      renderWhy(d);
      renderCheck(d);
      renderNext(d);
      renderChips(d);
      renderQueue();
      renderHistory(d);
    }
`;
