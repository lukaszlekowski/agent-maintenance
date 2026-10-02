# Add Help → About and verification provenance

Source mapping: Phase 3. This execution document preserves the canonical scope and gates; it does not authorize implementation.

Canonical source: [plan.md](../../plan.md)

## Shared execution requirements

## Execution and evidence rules

Implement bounded phases in order. Phases 1–3 form the first usable milestone; phases 4–6 expand compatibility and feasibility. Keep shared policy and services consistent across CLI, TUI and GUI. Preserve the archived safety baseline except for the explicitly proposed read-only version-policy change in phase 4.

Use disposable fixtures for writes and fault tests. Do not change real agent sessions, trust configuration or processes during validation. Do not enable capabilities by editing booleans without satisfying their acceptance evidence. Unknown ownership remains unknown.

Record each phase's changes, targeted checks, observed UI behavior, and remaining gates in a concise execution note. No raw logs or user data. Run relevant tests, typecheck and lint per code phase; run build and packaging checks for the completed release candidate. Do not publish or submit GitHub issues without user approval.

Do not spawn agents by default. When delegation is explicitly requested, use cheap Luna agents with fresh, bounded tasks unless the user specifies otherwise; follow AGENTS.md reporting and independent verification requirements.

Settings schema evolution is additive: new persisted keys are declared in CONFIG_DEFAULTS in src/core/config.ts so existing files stay valid, and each addition records whether the config version stays 1.0.0 and how an older binary reports a newer file (UNKNOWN_CONFIG_KEY or UNSUPPORTED_CONFIG_VERSION from validateConfig). Persisted path values (the path-valued fields only) are stored expanded (validateConfig expands ~ and environment references before writing).

## Phase scope and gates

## Phase 3 — Add Help → About and verification provenance

Issue memo: 10. Dependencies: phase 2 discovery metadata.

Work:
- Add a shared verification catalog containing agent, exact tested release, verification date, supported format contract, scope, evidence reference, and known limitations. Separate installed version, tested version and current compatibility status.
- Show application version from package/build metadata and the catalog in Help → About in TUI and GUI. Unknown dates or scopes must say unknown; do not fabricate values.
- Codex 0.160.0 evidence starts with the 2026-10-02 source/local parser verification; label it metadata and configured trust inspection, not release-wide mutation validation. Preserve links to upstream contracts in developer evidence.
- Explain disabled capabilities and settings/discovery locations in concise user language.

Acceptance: both UIs show the same app version and evidence; detected-but-unverified agents are not described as verified. Built and source execution agree. New release verification updates the catalog as part of its documented workflow.
