# Expand read-only integrations

Source mapping: Phase 5. This execution document preserves the canonical scope and gates; it does not authorize implementation.

Canonical source: [plan.md](../../plan.md)

## Shared execution requirements

## Execution and evidence rules

Implement bounded phases in order. Phases 1–3 form the first usable milestone; phases 4–6 expand compatibility and feasibility. Keep shared policy and services consistent across CLI, TUI and GUI. Preserve the archived safety baseline except for the explicitly proposed read-only version-policy change in phase 4.

Use disposable fixtures for writes and fault tests. Do not change real agent sessions, trust configuration or processes during validation. Do not enable capabilities by editing booleans without satisfying their acceptance evidence. Unknown ownership remains unknown.

Record each phase's changes, targeted checks, observed UI behavior, and remaining gates in a concise execution note. No raw logs or user data. Run relevant tests, typecheck and lint per code phase; run build and packaging checks for the completed release candidate. Do not publish or submit GitHub issues without user approval.

Do not spawn agents by default. When delegation is explicitly requested, use cheap Luna agents with fresh, bounded tasks unless the user specifies otherwise; follow AGENTS.md reporting and independent verification requirements.

Settings schema evolution is additive: new persisted keys are declared in CONFIG_DEFAULTS in src/core/config.ts so existing files stay valid, and each addition records whether the config version stays 1.0.0 and how an older binary reports a newer file (UNKNOWN_CONFIG_KEY or UNSUPPORTED_CONFIG_VERSION from validateConfig). Persisted path values (the path-valued fields only) are stored expanded (validateConfig expands ~ and environment references before writing).

## Phase scope and gates

## Phase 5 — Expand read-only integrations

Issue memo: 2. Dependencies: phase 4 common read-state contracts.

Implement separate bounded adapter investigations for Claude, OpenCode and Agy, then implement only feasible readers. Prefer documented APIs or exports that satisfy the required read behavior. Inspect current upstream sources/documentation during implementation; no source is assumed available from this plan.

For each agent:
- Establish supported data source, identity, timestamp semantics, session coverage, version/format discovery, and whether any access command writes.
- Establish configured trust inspection separately; do not equate configured entries with effective layered policy.
- Create sanitized representative, empty, malformed and drift fixtures plus read-only access checks.
- Integrate metadata, discovery, diagnostics and verification provenance across all interfaces. Keep unknown ownership/workload state explicit.
- If no safe source exists, publish a concise feasibility result and actionable unavailable state; do not manufacture a parser to claim completion.

Suggested investigation order: Claude, OpenCode, Agy; revise based on evidence. OpenCode must avoid its currently blocked write-capable CLI listing startup. A direct database reader requires a validated consistent read method; ad hoc copying live database files is not sufficient.

Acceptance per implemented reader: real representative format evidence plus disposable integration validation; correct metadata in TUI/GUI/JSON; no unintended source changes. Phase completion can include explicitly unsupported adapters, but does not claim all three readers exist.
