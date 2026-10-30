# Cache and owner-session status deployment

The deployed slice adds cached community-market search and the owner-only
`owner_sessions_status` tool. Status returns registered-session metadata, not chat
bodies, prompts, command arguments or private memory. It does not enumerate every
possible external agent/task registry; missing coverage is reported explicitly.
The tool is scoped to the configured owner Agent and current binding; group access
is denied. No plugin installation or new MCP connection is part of this release.

Community search caches the existing catalog source, verifies the GitHub blob
identity, distinguishes cold loading/stale/error states and never treats a timeout
as an empty catalog. Installation still follows the existing approval workflow.

For a new deployment, the native Cordis profile must load
`tools/owner-session-status-extension.mjs` after the bridge service, with `enabled`
true and `nativePackageRoot` pointing to the installed native packages. The module
declares its `xiaoqianBridge` dependency. Its `apply` returns no API object: returning
one causes Cordis rc.4 to dispose the registration as an invalid effect. Locally
registered `owner_sessions_status` is excluded from the global native-tool allowlist
when an Agent resumes; it remains protected by the owner-scoped guard.

Keep the group-addressing profile extension from [GROUP-ADDRESSING.md](GROUP-ADDRESSING.md)
in both candidate and restore profiles. Group initiative remains disabled. Preserve
the driver identity database, unknown-send records, private persona and session state
outside Git. Never clear a baseline to work around identity ambiguity.

## Observed deployment result

A controlled Windows deployment on 2026-10-30 completed successfully: the independent
guardian transaction took about 32.1 seconds and the observed poll gap was about
30.8 seconds. Acceptance used the actual owner status tool, group denial, a real
cached catalog query, source identity, preserved session/persona/unknown state and
new driver polling. HTTP reachability alone was not accepted. No model-generation
or WeChat test message was required. This observation is not an uptime guarantee.

The transaction used 55 seconds for candidate acceptance, reserving 35 seconds for
restore. Known registration failure triggers immediate rollback. A detached guardian
owns the deadline independently of the agent/SSH command. On Windows,
DETACHED_PROCESS alone still inherits an SSH Job: the observed Job had
KILL_ON_JOB_CLOSE and explicitly allowed BREAKAWAY_OK. The launcher must read that
existing policy and request ordinary permitted breakaway, or stop before pausing.
It must not change Job restrictions or try another identity. Cross-SSH synthetic
tests verified that the repaired guardian survived and completed its deadline.

Rollback restores verified source/profile pointers, not old chat/SQLite snapshots.
Only the application `bridge.lock` of a verified dead, transaction-owned process may
be backed up and removed; live/foreign owners and SDK/session locks must be left
alone. PID creation identity, exclusive deployment lock and profile compare-and-swap
protect against a stale controller overwriting a newer deployment or user settings.
Temporary verifier/resume entries and completed one-shot tasks are removed after
success, without another restart.

The real interactive startup can still fail under Task Scheduler, desktop, resource
or OS failures. Guardian termination, a nonresponsive machine, ambiguous PID or a
newer user profile can require manual recovery beyond 90 seconds. Never advertise a
100% hard recovery bound. Keep recoverable backups and an explicit maintenance
window; a new permission/task configuration requires its specific authorization.

## Source reproducibility

`CACHE-STATUS-SOURCE-MANIFEST.json` hashes deployable source files after UTF-8/LF
normalization. Windows working trees can contain CRLF while Git objects contain LF;
raw-byte differences do not by themselves imply different code. The runtime mapping
must compare the declared normalized scope and record both the repository commit
and manifest aggregate. Real paths, profile/persona/configuration, approval records,
runtime logs and chat/knowledge data are excluded from this public manifest.

The source scope excludes the CLI-only deployment renderer, which is not imported
by the running service. Existing public CLI options remain available.
