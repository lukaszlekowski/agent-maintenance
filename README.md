# Agent Maintenance

Agent Maintenance provides read-only session/trust inventory and a capability-gated terminal and local browser interface for agent maintenance.

## Runtime and supported platforms

Use Node.js 22.18 or later in the 22.x, 24.x, or 26.x lines. Local verification for this release candidate ran on macOS Node 26.10.0. Durable storage transactions are enabled only on macOS with a verified local APFS root; Linux runs the portable suite and explicit storage fail-closed checks, while APFS-only transaction fixtures are reported as skipped with their capability reason. The hosted macOS/Linux matrix is configured but has not yet been executed. Windows is an inventory/schema portability target; storage transactions, trust writes, process termination, and lock-dependent GUI lifecycle remain unavailable there. Network filesystems and filesystems outside the runtime validated local-lock allowlist are not supported for serialized operations.

Install from an npm tarball or checkout with `npm install`. `fs-ext` is an optional native dependency: on unsupported systems install can complete, while lock-dependent operations return a stable disabled-capability error. The Homebrew template installs declared production dependencies under its private `libexec` directory and explicitly rebuilds `fs-ext`; it requires Node/npm, Python, and the platform's native compiler toolchain. No native agent mutation is currently enabled because Phase 0 did not establish external-writer exclusion or production race-safe protected-root operations.

## Commands

```text
agent-maintenance [--tui | --gui]
agent-maintenance inventory --json [--codex-home ABSOLUTE_PATH]
agent-maintenance archived [--json]
agent-maintenance deleted [--json]
agent-maintenance restore AGENT/SESSION [--archive-id ID] [--json]
agent-maintenance trust [--json]
agent-maintenance trust add|prune|sync AGENT ABSOLUTE_PATH [--json]
agent-maintenance --help
agent-maintenance --version
```

An explicit command takes precedence over terminal detection. With no command, a terminal opens the TUI and redirected input/output selects JSON inventory mode. `--tui` and `--gui` are explicit modes and cannot be combined with each other or a command. Errors in redirected mode are one JSON object on stdout. Exit status is `0` for success, `2` for command/runtime failures, `3` for a disabled capability, and `64` for invalid command syntax or mode conflicts. Restore selectors always include the agent ID; when there are multiple archives, pass the full immutable `--archive-id`. The implementation never chooses a newest archive implicitly.

`archived` and `deleted` report that listing is unavailable until a production protected-root storage backend can safely inspect the registry. Restore, trust add/prune/sync, and other mutations report the exact disabled safety gate. The controlled test backend is not enabled by the installed command. The trust command reports only schema-validated inventory entries. Unknown or unsupported agent formats stay unavailable rather than being inferred.

## Data and recovery

Internal UI preferences are stored in `~/.agent-maintenance/settings.json`; the planned managed storage root is `~/.agent-maintenance/`. At present, the default service does not inspect or mutate real managed storage because production protected-root operations are unavailable. Journals created through controlled tests preserve archive payloads and recovery diagnostics. If a future supported workflow reports `RECOVERY_PENDING`, keep the journal and payloads in place and resolve the diagnostic before retrying; do not delete or edit them manually. The exact restore form is `agent-maintenance restore <agent>/<sessionId> [--archive-id <id>]`.

## Validation and release

Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm pack --dry-run`. The platform-aware test runner executes the complete storage fault and recovery matrix on macOS and marks those local-APFS-only fixtures skipped on Linux while still running Linux readers, GUI/lock checks, and explicit durable-storage denial assertions. The configured Windows runner selects portable inventory/schema and fail-closed checks. The `ci.yml` and `release.yml` macOS/Linux jobs are configured but their hosted results have not been observed locally; release artifact generation waits for both supported-platform checks. A tag build checks that the CLI/package version matches the tag and packages a tarball and checksum without publishing. A later publishing decision must provision narrowly scoped npm provenance credentials and a Homebrew tap token, require the protected `release` environment, and match the verified tag/version. Before updating a Homebrew tap, replace the template owner, version, URL, and SHA-256 with values from the verified artifact. Retry only the failed release step after checking whether the previous step completed; publishing steps must be idempotent or inspect the registry/tap state before retrying.
