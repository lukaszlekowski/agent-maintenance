# Project agent instructions

## User-facing chat format

- When communicating directly with the user in chat, begin with a short `tl;dr` summary, followed by the actual answer or output.
- This format does not apply to messages between agents or subagent reports.

## Reviewer and auditor verdicts

- Every reviewer or auditor report must return exactly one verdict: `APPROVED` or `REJECTED`. Do not use conditional or alternative verdicts.
- Return `APPROVED` only when confidence that the reviewed work satisfies its scoped requirements is at least `0.95` and no blocking findings remain. Otherwise return `REJECTED`, including when evidence is insufficient.
- State the confidence score and briefly list supporting evidence or blocking findings. The score is an assessment, not a substitute for verification.
- This is a repository reminder of the verdict policy also maintained in skills and agent configuration.

## Subagent review and context limits

- Delegate only when the user explicitly requests delegation or an applicable instruction requires it. Use the model and reasoning effort requested by the user.
- Give subagents bounded tasks and the relevant file paths. Prefer a fresh context rather than forwarding the full conversation when the task can be described independently.
- Include these reporting restrictions in each subagent task, including follow-up tasks to agents created before this file existed.
- Orchestrators and other agents waiting for subagents must use `wait_agent` to wait for messages or completion notifications. Do not poll agent status, inspect files or processes to infer progress, or send routine progress/status requests. Renew a timed-out wait without performing a progress check. Review artifacts only after a completion/handoff notification; send follow-ups for actionable findings or necessary task clarification, not merely to ask how work is progressing.
- Subagents must return concise summaries of changes, affected file paths, checks performed, outcomes, and unresolved issues. Keep progress messages brief.
- Do not send full terminal transcripts, raw tool logs, conversation dumps, or private reasoning to the parent agent. Do not write such material into review artifacts.
- Parent agents must review the resulting files or diffs and run targeted independent checks. A completion summary alone is not sufficient evidence of correctness.
- Do not retrieve, open, replay, or load a subagent's full terminal transcript, session history, or raw tool logs, including through local session files or tracing tools.
- If diagnosis requires more evidence, request a concise explanation or rerun a targeted check. Use only the relevant bounded error excerpt, not the full transcript.
- If full-log inspection appears necessary, stop that inspection and explain why it is needed. Obtain explicit user authorization before proceeding; continue unrelated authorized work where possible.
- These instructions govern agent behavior. They do not disable platform logging, change retention, or impose an access-control boundary.

## Documentation locations

- Specification: `docs/dev/design/project_summary.md`.
- Canonical implementation plan: `docs/dev/design/plan.md`.
- Phase plans and execution checklist: `docs/dev/execution/`.
