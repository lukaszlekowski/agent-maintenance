# Execution checklist

Canonical plan: [plan.md](../plan.md). Phase documents below preserve its bounded scope, dependencies, acceptance gates, checks and evidence requirements. For 6A and 6B, see the explicit mapping to Phase 6.

Status legend: `[ ]` pending. Update each status only when its evidence is recorded in a concise phase execution note.

| Milestone | Phase document | Implementation | Validation | Review | Evidence | Completion gate |
|---|---|---:|---:|---:|---:|---|
| M0 | [Phase 0](phase-0/plan.md) | [ ] | [ ] | [ ] | [ ] | Clean branch checkout carries tested 0.160.0 reader baseline; phase 1 begins from committed state. |
| M1 | [Phase 1](phase-1/plan.md) | [ ] | [ ] | [ ] | [ ] | All phase 1 acceptance gates pass, including genuine two-process preferences evidence and both UI checks. |
| M1 | [Phase 2](phase-2/plan.md) | [ ] | [ ] | [ ] | [ ] | Discovery, overrides, data-root precedence, failure cases and interface agreement meet acceptance. |
| M1 | [Phase 3](phase-3/plan.md) | [ ] | [ ] | [ ] | [ ] | TUI and GUI show shared app version and evidence provenance; unknown claims remain unknown. |
| M2 | [Phase 4](phase-4/plan.md) | [ ] | [ ] | [ ] | [ ] | Contract-based read table is consistent across interfaces; CI distinguishes pass, failure and inconclusive; mutations remain disabled. |
| M3 | [Phase 5](phase-5/plan.md) | [ ] | [ ] | [ ] | [ ] | Each additional adapter has a verified reader or documented feasibility limitation; no unsupported completion claim. |
| M4 | [Phase 6A](phase-6a/plan.md) | [ ] | [ ] | [ ] | [ ] | Disposable archive inspection is predictable and read-only; restore remains disabled pending 6B evidence. |
| M5 | [Phase 6B](phase-6b/plan.md) | [ ] | [ ] | [ ] | [ ] | Per-agent/OS decisions recorded; only operations backed by archived safety evidence are implemented, or blocked capability is documented. |

## Workstream completion gates

- [ ] Targeted checks and manual UI evidence are recorded per completed phase.
- [ ] Final typecheck, lint, platform-appropriate tests, build and package dry-run pass; skipped or platform-blocked checks are explicit.
- [ ] Issue memo is reconciled with implemented work; GitHub submission remains separately approved.
