# Make discovery visible and configurable

Source mapping: Phase 2. This execution document preserves the canonical scope and gates; it does not authorize implementation.

Canonical source: [plan.md](../../plan.md)

## Shared execution requirements

## Execution and evidence rules

Implement bounded phases in order. Phases 1–3 form the first usable milestone; phases 4–6 expand compatibility and feasibility. Keep shared policy and services consistent across CLI, TUI and GUI. Preserve the archived safety baseline except for the explicitly proposed read-only version-policy change in phase 4.

Use disposable fixtures for writes and fault tests. Do not change real agent sessions, trust configuration or processes during validation. Do not enable capabilities by editing booleans without satisfying their acceptance evidence. Unknown ownership remains unknown.

Record each phase's changes, targeted checks, observed UI behavior, and remaining gates in a concise execution note. No raw logs or user data. Run relevant tests, typecheck and lint per code phase; run build and packaging checks for the completed release candidate. Do not publish or submit GitHub issues without user approval.

Do not spawn agents by default. When delegation is explicitly requested, use cheap Luna agents with fresh, bounded tasks unless the user specifies otherwise; follow AGENTS.md reporting and independent verification requirements.

Settings schema evolution is additive: new persisted keys are declared in CONFIG_DEFAULTS in src/core/config.ts so existing files stay valid, and each addition records whether the config version stays 1.0.0 and how an older binary reports a newer file (UNKNOWN_CONFIG_KEY or UNSUPPORTED_CONFIG_VERSION from validateConfig). Persisted path values (the path-valued fields only) are stored expanded (validateConfig expands ~ and environment references before writing).

## Phase scope and gates

## Phase 2 — Make discovery visible and configurable

Issue memo: 11. Dependencies: phase 1 settings conflict handling.

Relevant code: src/cli.ts, src/core/config.ts, src/types.ts, src/tui/services.ts, src/tui/views.ts, src/gui/contracts.ts, src/gui/public/app.js.

Work:
- Introduce a shared executable resolver. Automatic discovery uses inherited PATH; record the selected path, canonical target where available, detection source and version probe result. Invoke the resolved path directly so display and execution agree. Do not use shell aliases or interpolate shell command strings.
- Add optional absolute executable overrides per agent in validated settings. Verify existence/executability using platform rules, bound probe duration/output, and report failure. A broken explicit override must not silently fall back to another installation.
- Show details in Overview and configure paths in Settings, with Re-detect and Reset to automatic in both interfaces. Report additional PATH candidates without silently changing precedence.
- Model executable location and data root separately. Add a Codex data-root override with precedence: explicit headless flag, persisted override, CODEX_HOME, default. Show the selected value and its source. Never derive the data root from the executable directory.
- Other agents may show their executable while their data reader remains unavailable. Do not invent their data locations.
- Missing/failed version probes produce useful diagnostics. A command labelled --version is not assumed side-effect-free; document observed behavior and minimise probing.

Acceptance: PATH ordering, paths containing spaces, symlinks, multiple installations, missing/invalid overrides, explicit reset, probe timeout, data-root precedence, and CLI/TUI/GUI agreement are verified with disposable executable fixtures. No shell injection or real agent listing commands.

Checks: extend test/cli.test.ts for resolution, override failure and data-root precedence, alongside new focused resolver tests and the TUI/GUI suites.
