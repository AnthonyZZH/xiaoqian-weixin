# Isolated owner tasks on the current wake/collector baseline

Prepared against canonical core `a974d5071cb44d1ca2e2779669dc12342c9bfae4`,
whose application runtime is the deployed wake/collector snapshot `8d258720`.
This source slice has been deployed. Real owner task submission/cancellation/result delivery and deployed crash reconciliation still require natural-use acceptance; the offline SDK checks do not certify those outcomes.

The smallest supported task kinds are `reasoning` and `persona-edit`. Submission
returns a persistent task ID, a separate native Agent performs the work, and the
foreground owner chat remains available. Status/progress/cancel use the original
current owner binding. The task status projection does not read task or result
bodies. Cancellation denies further physical requests and confirms native cleanup;
uncertain effects are retained rather than rerun. A persona draft commits only
through the revision/CAS path. Completed results enter a durable original-chat
queue, at most one short flush per critical section; unknown acceptance is not
replayed. Background Agents receive no generic owner shell, installer or file
executor in this slice.

## Reconciled differences

- The old candidate is not copied over current code. Fifteen long-task runtime
  files were reconciled using their recorded original blobs and current source.
- Both wake completion and task-completion methods remain present. Current
  dynamic persona, per-turn permits, group policy, identity driver, cache/status,
  balance and rotation-off behavior remain intact.
- Status extension `apply` returns void. The old candidate's API-object return
  was rejected during review because rc.4 disposes such registrations.
- One generated common provider adapter composes physical task admission outside
  the final billing capture. A rejected request consumes no network call or billing
  record. The original credential resolver remains inside the existing API-key
  provider closure; no credential is copied into a task, model or test.
- The three origin-link runtime files classify future attempts using trusted host
  receipts and actual native turn/step/attempt events. Missing/mixed origins do not
  qualify for user calibration. A task-completion reply permit is not sufficient:
  the native message must also exist in the host's input receipt table. This keeps
  background result notifications out of natural-user calibration.

## Minimal future configuration delta

Apply field changes to the two currently used bootstrap declarations by their
`xiaoqian-wechat-native` ID; do not replace profiles from the old handoff.

1. Point the bridge module at the final immutable candidate snapshot.
2. Keep `longTasks.enabled=true`, set `longTasks.isolated=true`, and select a NEW
   dedicated persistent task root. Do not reuse/migrate/replay the legacy ledger.
3. Preserve the actual current model, owner/group bindings, persona, library,
   `driverRpcPath`, wake policy, billing collector root and `rotation.autoEnabled=false`.
   The working external RPC needs no code change for this slice.
4. Regenerate the composed shim from that same immutable snapshot with both
   `billingCollector=true` and `isolatedTasks=true`. Reuse the existing active
   official provider entry and private resolver. Do not enable a stale on-disk row
   or switch model routes based on the old candidate's inspection report.
5. Keep exactly ONE existing owner-session-status extension; update its module
   pointer to this snapshot. Do not add the differently named duplicate suggested
   by the older handoff. Reuse the existing sessionQuery service.

No proposed delta changes credentials, group tools, shell authority, live message
identity, attachment support or automatic rotation permission.

## Loading and acceptance still required

First load changes the bridge factory, resumed owner setup, status lifecycle and
the absolute URL used by the provider singleton. A no-interruption partial reload
has not been proven. Prepare one coordinated bridge/provider window with the
existing independent guardian after explicit approval. Before pausing, reconcile
any active legacy jobs, verify a single active official provider and the current
owner/sessionQuery binding, preserve all ledgers and pin the final snapshot.

Runtime acceptance must verify the isolated provider budget is attached, owner
task schemas are registered while groups are denied, the existing foreground
driver keeps polling, and the actual owner request returns its ID promptly. Real
model execution, original-chat delivery and deployed crash recovery remain onsite
acceptance; do not create paid probes or send messages merely to claim success.
Metadata collection does not enable rotation, and prior unlinked rows are not
retroactively certified. Keep unknown task creation/delivery states for explicit
reconciliation. If rollback cannot prove children idle and the budget fence
released, hold and report instead of removing the helper from an active child.

The offline integration log records 64 passing targeted checks, including real
installed rc.4 lifecycle tests, a composed final-provider test with fake fetch,
status lifecycle and origin linkage. There were zero paid/network model calls and
zero real WeChat sends. Tests do not replace the controlled production acceptance.
