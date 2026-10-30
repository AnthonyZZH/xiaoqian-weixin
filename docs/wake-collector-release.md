# Wake completion and passive billing metadata

The wake completion protocol and passive owner-only billing collector were deployed
from application snapshot `8d2587203eb7bfca554d7d0dadae8536cfa12017`.
An Agent that completes a matching wake turn without selecting a reply/skip is
recorded as `completed_without_decision` and scheduled again. True timeouts retain
the bounded fallback. Neither path cancels an independent normal message permit.

The collector pairs the final request meter with cumulative provider usage per
physical attempt. It stores hashes, structural sizes, numeric usage and timestamps,
not text, persona, tool arguments, URLs, headers or credentials. UTF-8 meter units
are not tokens. Automatic session rotation remains disabled. Three complete,
compatible natural samples are a data review prerequisite, not permission to enable
automatic rotation or proof of guaranteed savings. Do not issue paid calibration
probes. See [BILLING-COLLECTOR-ONLY.md](BILLING-COLLECTOR-ONLY.md).

## Package the external RPC and its data dependencies

The first coordinated restart rolled back because a code-only `.py` copy omitted
`vendor/calendar-2026.json`. The scheduler reads this file during import, before any
JSONL handshake. Python AST checks do not catch missing runtime data. The corrected
package includes the calendar from the same policy snapshot and pins its hash.

Use `tools/stage-rpc.py RPC_SOURCE_ROOT POLICY_SNAPSHOT_ROOT NEW_DEST
--smoke-python ABSOLUTE_PYTHON` (one command line). The source root must contain the
reviewed driver/ and vendor/ implementations; the policy root contains
owner_wake_policy.py and calendar-2026.json. It copies Python source and this explicit
public resource, not arbitrary JSON, databases or live state. Inspect the resulting
manifest and run the actual final directory through initialize, health and close.
The smoke starts the real RPC process with synthetic state and fake UI. It does not
prove that the real WeChat desktop can be controlled.

Preserve group addressing, cache/status, balance integration, stable identity state,
unknown sends, sessions and private persona in candidate and restore configurations.
Generate the provider shim from the same immutable application snapshot as the
bridge, keeping authentication inside the existing provider closure. Do not publish
private profiles, deployment plans, approval records, usage records or user data.

The corrected coordinated restart completed with a 21.03-second guardian window and
a 20.72-second observed polling gap. These measurements do not guarantee future
Windows interactive startup time. Use a separately running, verified rollback
guardian; the nominal budget is 55 seconds for acceptance and 35 for recovery.
Never reuse a consumed deployment transaction. A fresh approved window must recheck
live PID, profile and source hashes before pausing. Natural wake completion and real
usage pairing require subsequent observation, not a fabricated success test.
