# Production managed-archive inspection

Source mapping: Phase 6A within Phase 6. This execution document preserves the canonical scope and gates; it does not authorize implementation.

Canonical source: [plan.md](../../plan.md)

## Shared execution requirements

## Execution and evidence rules

Implement bounded phases in order. Phases 1–3 form the first usable milestone; phases 4–6 expand compatibility and feasibility. Keep shared policy and services consistent across CLI, TUI and GUI. Preserve the archived safety baseline except for the explicitly proposed read-only version-policy change in phase 4.

Use disposable fixtures for writes and fault tests. Do not change real agent sessions, trust configuration or processes during validation. Do not enable capabilities by editing booleans without satisfying their acceptance evidence. Unknown ownership remains unknown.

Record each phase's changes, targeted checks, observed UI behavior, and remaining gates in a concise execution note. No raw logs or user data. Run relevant tests, typecheck and lint per code phase; run build and packaging checks for the completed release candidate. Do not publish or submit GitHub issues without user approval.

Do not spawn agents by default. When delegation is explicitly requested, use cheap Luna agents with fresh, bounded tasks unless the user specifies otherwise; follow AGENTS.md reporting and independent verification requirements.

Settings schema evolution is additive: new persisted keys are declared in CONFIG_DEFAULTS in src/core/config.ts so existing files stay valid, and each addition records whether the config version stays 1.0.0 and how an older binary reports a newer file (UNKNOWN_CONFIG_KEY or UNSUPPORTED_CONFIG_VERSION from validateConfig). Persisted path values (the path-valued fields only) are stored expanded (validateConfig expands ~ and environment references before writing).

## Phase scope and gates

## Phase 6 — Storage inspection, then mutation feasibility

Issue memo: 3, 4. Dependencies: phase 1 path defaults; phase 2 root visibility. Mutation implementation additionally depends on each agent's evidence from phase 5 or existing Codex evidence.

### 6A: Production managed-archive inspection

Design and implement a read-only production backend for managed storage root resolution, registry/manifest validation and exact archive identity. Keep it distinct from capability issuance for writes. Inspect src/storage/* and reconcile the temp root nested under ~/.agent-maintenance with registry layout, containment, traversal exclusions and recovery paths.

Do not create storage or run recovery as a side effect of inspection. Handle missing roots as empty only when inspection is available; unreadable, malformed, unsafe or racing roots receive explicit diagnostics. Reject symlink escapes and untrusted roots. Define snapshot consistency and concurrent-writer behavior before enabling the listing service in src/tui/services.ts.

Acceptance: valid disposable archives list in CLI/TUI/GUI; missing, malformed, inaccessible, symlinked and concurrently changing roots behave predictably. Listing changes no files. Exact archive IDs remain visible; restore remains disabled until 6B evidence exists.
