# Make current Codex support usable

Source mapping: Phase 1. This execution document preserves the canonical scope and gates; it does not authorize implementation.

Canonical source: [plan.md](../../plan.md)

## Shared execution requirements

## Execution and evidence rules

Implement bounded phases in order. Phases 1–3 form the first usable milestone; phases 4–6 expand compatibility and feasibility. Keep shared policy and services consistent across CLI, TUI and GUI. Preserve the archived safety baseline except for the explicitly proposed read-only version-policy change in phase 4.

Use disposable fixtures for writes and fault tests. Do not change real agent sessions, trust configuration or processes during validation. Do not enable capabilities by editing booleans without satisfying their acceptance evidence. Unknown ownership remains unknown.

Record each phase's changes, targeted checks, observed UI behavior, and remaining gates in a concise execution note. No raw logs or user data. Run relevant tests, typecheck and lint per code phase; run build and packaging checks for the completed release candidate. Do not publish or submit GitHub issues without user approval.

Do not spawn agents by default. When delegation is explicitly requested, use cheap Luna agents with fresh, bounded tasks unless the user specifies otherwise; follow AGENTS.md reporting and independent verification requirements.

Settings schema evolution is additive: new persisted keys are declared in CONFIG_DEFAULTS in src/core/config.ts so existing files stay valid, and each addition records whether the config version stays 1.0.0 and how an older binary reports a newer file (UNKNOWN_CONFIG_KEY or UNSUPPORTED_CONFIG_VERSION from validateConfig). Persisted path values (the path-valued fields only) are stored expanded (validateConfig expands ~ and environment references before writing).

## Phase scope and gates

## Phase 1 — Make current Codex support usable

Issue memo: 5, 6, 7, 8, 9. Dependencies: phase 0 landed baseline.

Relevant code: src/tui/app.ts, src/tui/settings.ts, src/tui/views.ts, src/core/config.ts, src/core/locks.ts, src/gui/api.ts, src/gui/public/app.js, README.md.

Work:
1. Reproduce Backspace handling with the installed Ink version and affected terminal. Correct key handling without changing modal shortcut scoping. Keep append/delete behavior, cancellation and save predictable.
2. Reload preferences when entering Settings in either UI and provide explicit refresh for an already-open view. Do not overwrite an active field editor while typing; show a conflict or require reload if preferences changed externally.
3. Replace whole stale-document saves with a field patch plus expected revision. Add a persisted monotonic revision to the settings schema in src/core/config.ts (new key, default 0; see the schema-evolution rule). Give FileSettingsStore in src/tui/settings.ts a compare-and-swap save: reject on revision mismatch, apply only the edited fields, validate the merged result and save atomically with the incremented revision. Both writers — saveSetting in src/tui/app.ts and the settings-save dispatch in src/gui/api.ts — use this contract, and a GUI save must not revert a TUI theme change made after the GUI form loaded. Keep preferences separate from inventory refresh.

   The settings lock: the compare-and-swap window is serialized across processes by extending the existing kernel-lock API in src/core/locks.ts with a new settings lock name ordered outside the existing pair — settings before maintenance, which stays before launcher — so the existing ordering check fails closed with LOCK_ORDER_VIOLATION if a settings scope is ever nested inside a maintenance or launcher scope, and settings saves are sequenced rather than nested when a maintenance-locked operation also needs to write settings. The lock file lives in a locks directory beside the settings file (a disposable settings path therefore gets disposable locks, and the directory must pass the existing trusted-lock-directory checks) and is held for the entire reread → validate → rename window; ordinary loads stay lock-free because atomic rename already keeps readers consistent. Saves use a bounded timeout (default 5,000 ms, passed through LockOptions.timeoutMs) so a contended save fails visibly with LOCK_TIMEOUT instead of hanging the UI. When mutual exclusion cannot be established at all — fs-ext missing (LOCK_BACKEND_UNAVAILABLE), a non-darwin/linux platform (LOCKING_UNSUPPORTED), an unsupported or unverifiable filesystem (LOCK_FILESYSTEM_UNSUPPORTED or LOCK_FILESYSTEM_UNKNOWN), or an unsafe lock directory or lock file — the save fails closed with a visible error in both TUI and GUI and the settings file is left unchanged; there is no unlocked save path. The revision check remains in force inside the lock as a second layer of defense.

   Concurrency evidence: a genuine two-process test against one disposable settings file, using two real separate processes standing in for the TUI and the GUI (child processes, as in the existing cross-process lock harness in test/core/primitives.test.ts). It must cover stale-writer rejection with the visible conflict, lock contention where the second process either completes within the bounded timeout or fails visibly, and lock release after a holder process exits or is killed mid-save so the next process can save immediately; the surviving file must always equal one writer's complete intended result, never a merge. Two in-process store instances may remain as an additional regression assertion but are not sufficient evidence on their own, and sequential reloads are never sufficient.
4. Change the default temp folder to ~/.agent-maintenance/temp. Preserve all existing persisted paths, including the old default, because its provenance is unknown. Persisted path values are stored expanded (validateConfig expands ~ and environment references before writing), so recognising the persisted old default means comparing against its expanded form. Offer an explicit reset-to-default; never move existing data implicitly. Check storage root relationships before phase 6 uses the nested default.
5. Distinguish empty data, incompatible data, absent agent, missing implementation, and actual setup errors. Explain that production storage is not implemented; do not imply a permission button will enable it. Identify metadata timestamps accurately.
6. Isolate read failures by agent and capability: an incompatible or unreadable trust configuration must not hide compatible session metadata, and one failed agent or capability must not hide the rest of the inventory. Preserve each error beside the records it scopes; never render a failed read as zero sessions. Phase 4 re-uses this isolation for contract-validated reads.
7. Document npm run tui and npm run gui for checkout use.

Acceptance:
- Backspace deletes in the reproduced terminal; typing, Enter save and Esc cancel behave correctly.
- GUI → TUI and TUI → GUI changes appear after entering Settings/refresh without process restart. With two real processes writing one disposable settings file, the stale writer is rejected with a visible conflict and never silently applied, the second process either completes within the bounded timeout or fails visibly, and lock release after a holder process exits or is killed is proven; a GUI save does not revert a TUI theme change made after the GUI form loaded.
- When the settings lock cannot be acquired or is unsupported — missing fs-ext, non-darwin/linux platform, unsupported filesystem, unsafe lock path or timeout — the save fails with a visible error in both interfaces and the settings file is unchanged; no unlocked save path exists.
- Fresh preferences use the new default; old persisted and custom paths remain intact until explicitly reset. A visible reset-to-default control in both TUI and GUI restores the new default, and only that action does. No data relocation occurs.
- Inventory for a 0.160.0-versioned Codex installation (fixture-driven, version-parameterised as in test/adapters/inventory.test.ts) appears in both interfaces; missing or malformed data produces an explicit state. Mutations remain disabled.
- An incompatible or unreadable Codex trust configuration leaves session metadata visible in CLI, TUI and GUI, with the trust failure shown as a separate explicit state; a failed agent or capability is never rendered as zero sessions.
- After npm ci from a clean checkout, npm run tui and npm run gui start successfully, with evidence recorded in the execution note.

Checks: test/tui/app.test.ts, test/tui/settings.test.ts, test/gui/settings-form.test.ts, test/gui/api.test.ts, test/core/primitives.test.ts, test/adapters/inventory.test.ts and test/cli.test.ts for explicit data states, Codex home precedence and per-agent/per-capability isolation, plus focused manual terminal/browser checks. Extend the lock tests in test/core/primitives.test.ts for settings-lock ordering and fail-closed unavailability. Verify preferences concurrency with a genuine two-process test (stale-writer rejection, contention and release after process exit) in disposable directories.
