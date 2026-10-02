# Land the verified 0.160.0 baseline

Source mapping: Phase 0. This execution document preserves the canonical scope and gates; it does not authorize implementation.

Canonical source: [plan.md](../../plan.md)

## Shared execution requirements

## Execution and evidence rules

Implement bounded phases in order. Phases 1–3 form the first usable milestone; phases 4–6 expand compatibility and feasibility. Keep shared policy and services consistent across CLI, TUI and GUI. Preserve the archived safety baseline except for the explicitly proposed read-only version-policy change in phase 4.

Use disposable fixtures for writes and fault tests. Do not change real agent sessions, trust configuration or processes during validation. Do not enable capabilities by editing booleans without satisfying their acceptance evidence. Unknown ownership remains unknown.

Record each phase's changes, targeted checks, observed UI behavior, and remaining gates in a concise execution note. No raw logs or user data. Run relevant tests, typecheck and lint per code phase; run build and packaging checks for the completed release candidate. Do not publish or submit GitHub issues without user approval.

Do not spawn agents by default. When delegation is explicitly requested, use cheap Luna agents with fresh, bounded tasks unless the user specifies otherwise; follow AGENTS.md reporting and independent verification requirements.

Settings schema evolution is additive: new persisted keys are declared in CONFIG_DEFAULTS in src/core/config.ts so existing files stay valid, and each addition records whether the config version stays 1.0.0 and how an older binary reports a newer file (UNKNOWN_CONFIG_KEY or UNSUPPORTED_CONFIG_VERSION from validateConfig). Persisted path values (the path-valued fields only) are stored expanded (validateConfig expands ~ and environment references before writing).

## Phase scope and gates

## Phase 0 — Land the verified 0.160.0 baseline

The 0.160.0 reader support claimed under "Current verified state" exists only as uncommitted working-tree changes to src/adapters/codex.ts, src/mutations/capabilities.ts, test/adapters/inventory.test.ts and AGENTS.md; committed HEAD validates only 0.159.2/0.159.3. An implementer starting from committed state does not have the stated baseline.

Work: review the pending diff, run the adapter and CLI test suites, and commit the changeset so the branch itself carries the claimed baseline. Record the landing in the execution note.

Acceptance: a clean checkout of the branch lists codex-cli 0.160.0 among the validated reader versions with its tests passing; phase 1 starts from committed state.
