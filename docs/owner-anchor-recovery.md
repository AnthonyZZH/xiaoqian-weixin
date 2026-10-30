# Owner latest-page recovery

The compatibility driver now retains persisted snapshot anchors and can follow a
certified latest-page observation after a page loses all overlap with its previous
snapshot. This fixes permanent `snapshot_without_order_anchor` deferral without
declaring an unknown historical page to be new input.

Use `compat/driver/bridge_rpc.py` with its matching `compat/vendor` package. The
top-level experimental driver has a different text completeness contract and is
not replaced by this release. Set the host's `driverRpcPath` to the compatibility
RPC and keep its existing state directory, adapter directory, sessions and persona.

The trusted host configuration must contain at most one private chat with
`owner: true`. The RPC maps it to optional `DriverConfig.owner_edge_chat`. No owner
is inferred from a nickname, message text, or first private chat; with no explicit
binding, latest-page navigation is disabled. This field is local trusted
configuration, not an incoming-message identity credential.

For that owner chat only, the existing serial worker and desktop lease select the
chat, focus the message list, verify foreground and focus ancestry, navigate to its
latest page, and check that the draft and target still match. The worker returns a
fresh HMAC receipt bound to the chat, exact rows, worker epoch and sequence. The
ephemeral key remains inside the local parent/worker IPC. Windows UI imports remain
lazy; fake/client/state code use the standard library. A non-Windows real backend
continues to fail closed. macOS UI automation has not been tested or implemented.

The first uncertified-history page becomes shadow observation only. It is neither
dispatched nor ACKed. Subsequent certified pages can emit uniquely aligned new tail
rows, preserving legitimate identical messages in distinct ordered positions.
Ambiguous pages and changed body/identity representations are shadowed again.
Archived pages never advance the live horizon. History evidence searches have a
six-page total budget; the archive retains 32 pages per chat. An epoch change starts
a new shadow observation rather than replaying the visible page. Persisted ACKs,
send operation IDs and unknown outcomes remain intact; unknown sends are not retried.

The Windows server deployment passed targeted recovery and controller tests plus a
single user-initiated end-to-end receipt check. The stalled historical interval was
**not backfilled** and remains for separate review. This mechanism cannot recover a
message that was never observed, or prove two wholly disjoint pages continuous.
It intentionally prefers a documented gap over replaying old conversation.

Source export contains the six deployed recovery modules, with two deliberate
publication adjustments: the deployment-specific owner name becomes explicit
configuration, and incident-only diagnostic/draft-clearing hooks are excluded.
No production state, conversation samples, persona, credentials or private config
are included. No running service is changed by this source archive.

Run synthetic regressions without WeChat or model API calls:

```sh
python -B tests/test_compat_owner_recovery.py
```

For an actual recovery, preserve the existing database and unknown ledger; obtain a
short maintenance window through the existing serial controller, load the matching
package, resume polling, and verify one newly sent user message traverses ingestion,
Agent completion and a terminal send receipt exactly once. Do not clear baselines,
ACK uncertain history, fabricate user input, or retry unknown sends to test recovery.
