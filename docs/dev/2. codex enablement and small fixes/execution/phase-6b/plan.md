# Native mutation feasibility and conditional implementation

Source mapping: Phase 6B within Phase 6. This execution document preserves the canonical scope and gates; it does not authorize implementation.

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

### 6B: Native mutation feasibility and conditional implementation

Produce a per-agent/OS capability matrix for ownership binding, complete payload/database dependencies, writer exclusion covering startup/resume, protected-root file operations, durable publication and recovery. User-declared inactivity, process polling and internal tool locks do not prove exclusion of native writers.

Implement only capabilities with evidence satisfying the archived safety requirements. No-replace restore, conflict handling, crash recovery and dependency closure must be proven in disposable environments before production wiring. Trust edits and process termination have separate gates; session reading cannot enable either implicitly.

If mechanisms are unavailable, the deliverable is a documented blocked capability and a follow-up workflow/design proposal. It is not an unsafe fallback or a promise of full mutation support. No real-user mutation testing, publishing or issue submission is authorised here.

## Milestones and completion checklist

- [ ] M0 / phase 0: verified 0.160.0 baseline committed on the branch.
- [ ] M1 / phases 1–3: usable Codex metadata/trust inspection with per-agent and per-capability error isolation, cross-process conflict-safe preferences, visible setup and About.
- [ ] M2 / phase 4: newer compatible formats read automatically under the shared read-enablement decision table; latest-release evidence workflow exists.
- [ ] M3 / phase 5: each additional adapter has either a verified reader or a documented feasibility limitation.
- [ ] M4 / phase 6A: production managed archives can be inspected safely without writes.
- [ ] M5 / phase 6B: native capability decisions recorded; only proven operations implemented.
- [ ] Targeted checks and manual UI evidence recorded per completed phase.
- [ ] Final typecheck, lint, platform-appropriate tests, build and package dry-run pass; skipped/platform-blocked checks are explicit.
- [ ] Issue memo reconciled with implemented work; GitHub submission remains separately approved.

## Risks and decisions requiring evidence

Format validation cannot detect every semantic upstream change; scheduled release checks and honest tested/compatible labels reduce this risk. Version-probe failure neither gates nor certifies format-based reading, so labels must stay honest. Binary discovery and data-root configuration must stay separate. Shared preferences are serialized by a cross-process settings lock spanning reread → validate → rename; saves fail closed when the lock cannot be acquired, and in-process-only concurrency evidence is not accepted. Storage feasibility remains unresolved and must not hold the read-only milestone hostage. Any substantial departure from this blueprint is recorded before implementation rather than silently weakening its gates.
