# Format-based reading and latest-release checks

Source mapping: Phase 4. This execution document preserves the canonical scope and gates; it does not authorize implementation.

Canonical source: [plan.md](../../plan.md)

## Shared execution requirements

## Execution and evidence rules

Implement bounded phases in order. Phases 1–3 form the first usable milestone; phases 4–6 expand compatibility and feasibility. Keep shared policy and services consistent across CLI, TUI and GUI. Preserve the archived safety baseline except for the explicitly proposed read-only version-policy change in phase 4.

Use disposable fixtures for writes and fault tests. Do not change real agent sessions, trust configuration or processes during validation. Do not enable capabilities by editing booleans without satisfying their acceptance evidence. Unknown ownership remains unknown.

Record each phase's changes, targeted checks, observed UI behavior, and remaining gates in a concise execution note. No raw logs or user data. Run relevant tests, typecheck and lint per code phase; run build and packaging checks for the completed release candidate. Do not publish or submit GitHub issues without user approval.

Do not spawn agents by default. When delegation is explicitly requested, use cheap Luna agents with fresh, bounded tasks unless the user specifies otherwise; follow AGENTS.md reporting and independent verification requirements.

Settings schema evolution is additive: new persisted keys are declared in CONFIG_DEFAULTS in src/core/config.ts so existing files stay valid, and each addition records whether the config version stays 1.0.0 and how an older binary reports a newer file (UNKNOWN_CONFIG_KEY or UNSUPPORTED_CONFIG_VERSION from validateConfig). Persisted path values (the path-valued fields only) are stored expanded (validateConfig expands ~ and environment references before writing).

## Phase scope and gates

## Phase 4 — Format-based reading and latest-release checks

Issue memo: 1. Dependencies: phases 1–3; per-agent and per-capability error isolation is established in phase 1 and is re-verified here against contract-validated reads.

This changes the archived exact-version read policy: the per-capability evidence gate in docs/dev/archived/1. initial set-up/design/plan.md ("Every enabled adapter capability has exact version/schema/OS evidence; unsupported capabilities remain disabled") and the runtime allowlist CODEX_SUPPORTED_VERSIONS in src/adapters/codex.ts. It supersedes the archived project_summary.md sentence "Unknown versions or schema changes fall back to read-only inspection with UNKNOWN ownership": current behavior is fail-closed, and this phase replaces exact-version rejection with contract-validated reading. It does not change mutation policy. Complete the contract review before removing the runtime allowlist.

Work:
1. Define named Codex read contracts: index field types/identity, latest-entry semantics, timestamp meaning, absent files, additional fields, malformed rows, and configured trust extraction. Distinguish absent or empty data from evidence that a newer format is compatible.
2. Dispatch through known format readers and validate every read. A newer or unrecognised release may use an existing reader when its observable format satisfies the contract. Display compatible-but-not-release-tested separately from tested. Do not infer new field meanings or write behavior from successful JSON parsing.
3. Apply one read-enablement decision table in the shared read-state service so CLI JSON, TUI and GUI render identical capability states, with no per-interface exceptions. Reading is enabled by contract-validated format evidence only — never by a version-probe result, and never by absent or empty data — and mutations stay disabled in every row:

   | Observed state | Reading enabled | Compatibility label | Partial results |
   | --- | --- | --- | --- |
   | Missing or empty files on an untested release | No: absent or empty data is not compatibility evidence, so the capability stays unavailable under the fail-closed rule | Unknown — no data; never compatible, never tested | None: an explicit empty/absent state, not a fabricated session list |
   | Populated files whose format satisfies a known contract | Yes, through the matching known reader | Compatible — not release-tested, shown separately from tested | No: a fully validating read returns all validated records |
   | Malformed or partially written files | No for the malformed artifact; field meanings are never inferred from partial parsing | Explicit error naming the malformed artifact; artifacts that validate keep the compatible label | Yes: validated records are returned beside the isolated error; a failed read is never presented as zero sessions |
   | Missing or failed executable version detection | Yes when format evidence alone satisfies a contract; probe failure does not gate reading and probe success alone never enables it | Compatible — version undetected; never shown as tested or release-verified | Yes for validated records; the probe failure is a separate diagnostic and release verification stays inconclusive |
   | Compatible session data alongside incompatible trust configuration | Yes for sessions; trust inspection is a separate capability that stays failed | Session capability shows its own label; trust capability shows an explicit incompatible-data error | Yes: sessions are returned; trust inspection returns no results with an explicit error; neither is presented as zero sessions |
4. Add scheduled and manually triggered CI checks for latest releases in disposable environments. Resolve and record exact tested versions, generate controlled sample data where feasible, compare structural and semantic expectations, and test readers for unintended writes. Agent interaction requiring unavailable credentials is reported as inconclusive, not passing. Keep untrusted release commands away from production credentials.
5. CI generates concise compatibility evidence and failure artifacts; it does not automatically publish a release, grant mutations or claim full verification from a version probe. Keep a no-credentials fixture suite for reliable pull-request checks. Release cadence/check frequency is configurable rather than hardcoded into user flows.

Acceptance: compatible newer version fixtures read successfully, incompatible formats show explicit errors, empty fixtures do not certify a release, optional/additional fields follow the contract, capability failures are independent (isolation established in phase 1, re-verified for contract-validated reads), all native mutations remain disabled, and CLI, TUI and GUI render the decision table's states identically — including a version-undetected release that reads with an honest unverified label. CI visibly differentiates pass, failure and inconclusive evidence.
