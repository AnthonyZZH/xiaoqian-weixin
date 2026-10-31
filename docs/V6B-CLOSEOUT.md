# v6b source closeout

This candidate is based on public commit `2cb8370ee9581498fbc2c3c21e724de4017c39c2`. It contains source and synthetic tests only. It is not a backup of any running account.

## Included fixes

* A single lifecycle-owned group policy replaces nested older wrappers. Explicit calls, configured exact mention aliases, topic followups and punctuation questions can participate; stop, self-echo and topic boundaries remain enforced. Aliases are private operator configuration and never grant owner privileges. Group timers remain disabled.
* The compatibility driver retains persistent ordered identities and an authenticated forward observation boundary. It journals program-owned drafts by operation and exact content hash, distinguishes failures before clicking from uncertain results afterwards, and never blindly retries unknown sends. Manual or changed drafts cannot be cleared by this mechanism.
* Obsolete incident read wrappers that performed additional UI checks on every poll are excluded. The persistent draft journal remains. Read timeout is an error, not proof that there was no new message. An already-bootstrapped successful poll can return accepted/ackable fields without a status field.
* Approval notifications, management jobs, lossless plugin DTOs and scoped status registration are included. Unknown sources still require a specific authenticated owner decision; the model cannot approve its own installation.
* Empty legacy task executors no longer advertise the unusable `wechat_task` submission. Read-only legacy status and independent owner long-task tools remain.

## Upgrade and rollback

Back up application source and private configuration separately from state, persona, media and the main Library. Do not put any of those private files in Git. Verify the complete executable/import/non-Python resource manifest before pausing, including calendar files and both bridge/provider shims. Keep the old source/profile mapping and an independent rollback process. Use a single deployment writer; verify the previous process has exited before recovering an abandoned lock. Never remove a live lock.

Restore the same state roots, session bindings, message ledger and unknown-operation records. On Windows, readers of an actively atomically-replaced state file must allow FILE_SHARE_DELETE; `tools/windows_shared_read.py` provides a bounded reader. The narrowly scoped sharing retry does not make arbitrary concurrent writers safe. Check a new PID/start generation and fresh per-chat poll receipts. HTTP reachability or a running process is not sufficient. Windows interactive startup can exceed the intended rollback window; 90 seconds is a target, not a guarantee.

For cross-desktop migration, changed UI identities need an independently verified continuity boundary. Do not delete the ledger or ingest all visible history as new. If that boundary cannot be established, retain paused/shadow state for uncertain history and report the limitation. The newer fulltext driver and the compatibility driver are separate lanes; do not silently change identity generations.

## Runtime acceptance still required

Synthetic SDK and fixture tests do not establish receipt by a real WeChat recipient, animated playback, complete real attachment downloads, or a new plugin/MCP installation. Native long tasks still require a natural owner submit/cancel/result roundtrip. Generic MCP listing is separate from the fixed main-Library adapter. Catalog network errors must be surfaced rather than represented as an empty market. Drawing is unavailable without a configured backend.

Automatic economic rotation remains disabled in this public default. Wake usage is not natural-user calibration; incomplete request/usage pairing cannot justify a saving claim. No model API calls or artificial WeChat messages are required by this source verification.

## Data backup

Privately inventory `stateDir` (bridge/driver/schedule/session-related state), the Harness home session store, persona, original-byte media, and the main Library vault/database. Record relative file names, sizes and SHA256 in a private manifest. SQLite snapshots require a consistent backup method; copying a live database alone is not a complete backup. Keep credentials and login state out of public bundles. Test restore into a separate directory before relying on a backup. No full-runtime backup success is claimed by this release.

## Single-selection followup

The compatibility read path reuses its selected adapter across owned-draft recovery and authenticated edge reading. It still revalidates the exact adapter/chat and preserves all budgets and signed receipts. Nine isolated fake-UI cases verify the baseline two selections versus one selection and failure boundaries. Successful INGEST timestamps are not poll-attempt heartbeats; no live latency improvement or elimination of long successful-record gaps is claimed.
