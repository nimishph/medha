# Anthropic Plugin Directory Submission Checklist (medha-wt5.8)

This document provides the submission metadata and checklist for submitting `@cntxt-labs/medha` to Anthropic's official Claude Code plugin directory.

## Plugin Metadata

- **Name**: `medha`
- **Display Name**: Medha — Evidential Memory for AI Agents
- **Short Description**: Evidential memory for rules, recipes, and tools: tracks what actually happened, verifies guards, and returns calibrated trust hints without deciding for you.
- **Repository**: https://github.com/nimishph/medha
- **Marketplace**: `nimishph/cntxt-labs`
- **Installation Command**:
  ```text
  /plugin marketplace add nimishph/cntxt-labs
  /plugin install medha@cntxt-labs
  ```
- **License**: MIT
- **Author**: Nimish Phalnikar (https://github.com/nimishph)
- **Supported Platforms**: Windows (x64), Linux (x64, arm64), macOS (arm64, x64)

## Capabilities Included

1. **Model Context Protocol (MCP) Server**:
   - `hints`: Fast batch-querying of evidential trust hints.
   - `record_signal`: Autonomous recording of successes, skips, and rejections.
   - `report_guard`: Cryptographic/deterministic assertion of verification tests.
   - `record_decision`: Contextual branching and decision trees.
   - `propose`: Submitting candidate rules with provenance.
   - `drift` & `status`: Evidential divergence radar and health diagnostics.
   - `pack_context`: Token-budgeted evidential context injection.

2. **Automated Lifecycle Hooks**:
   - `SessionStart`: Injects active and trusted rules into session context without latency when `.medha/` is detected.
   - `PostToolUse`: Listens to `Bash` test/lint executions and automatically records pass/fail guard outcomes for mapped entities.

3. **Slash Commands**:
   - `/medha:hints`: Inspect trust hints for specified entity keys.
   - `/medha:propose`: Propose new rules from the conversation.
   - `/medha:why`: Explain why an entity has its current trust score and lifecycle status.
   - `/medha:status`: Report repository engine health and preflight status.
   - `/medha:drift`: Surface drifting rules and behaviors.
   - `/medha:pack`: Preview evidential prompt packing under budget.

## Submission Steps
1. Ensure release version tag (e.g. `v0.7.5`) is published to npm.
2. Verify marketplace entry in `nimishph/cntxt-labs`.
3. Complete Anthropic partner directory submission form linking to the GitHub repository and manifest.
