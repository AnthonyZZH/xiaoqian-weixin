# Optional owner PowerShell and native input provenance

`owner_powershell` is separate from the structured `owner_command` tool. Public
configuration leaves it disabled. A trusted administrator may enable it for the
explicitly bound owner private chat only after informed approval of the existing
host identity's command and filesystem privileges. It runs arbitrary PowerShell
with that identity; Windows Job lifecycle management is not an OS sandbox.

Create the private approval record outside Git with `approved: true`, a nonempty
`approvalId`, `capability: "host-administrator-powershell"`, the configured
`ownerChatId`, and the digest of the current `[id,title,mode,owner]` binding. The
record must come from the trusted deployment operator, never from model output,
group messages, websites or uploaded files. No approval record is shipped here.
The existing integration rejects missing or mismatched records.

Set `ownerShell: { enabled: true, python: "ABSOLUTE_PYTHON", approvalFile:
"ABSOLUTE_PRIVATE_APPROVAL_FILE" }` in the private host configuration. The
deployment renderer supports `--owner-shell true --base-python ABSOLUTE_PYTHON
--shell-approval-file ABSOLUTE_PRIVATE_APPROVAL_FILE`; it creates neither approval
nor OS privileges. Keep the current chats, state directory, sessions and ledger.

Each command must match the actual bound Agent, owner/private route, incoming open
reply grant, current native turn, host-sourced native user input ID, tool call ID
and exact normalized argument digest. Direct string/object arguments and native
PTC start/root/parent/subcall linkage are recognized. The separate core policy may
still deny `run_code`; recognizing provenance does not grant PTC permission.

Native dispatch can precede the bridge's durable admission commit. The guard now
waits at most two seconds only for the matching `accepting` receipt, rechecking the
owner binding, open grant, turn and paused/closed state every 10 ms. It proceeds
only after `accepted`. Missing, unknown, expired or changed evidence fails closed;
queued command text alone is never permission. Group, forwarded and proactive
inputs cannot mint authority. The callback already awaits the async guard.

The worker preserves call-ID deduplication, a 30-second default/120-second maximum
budget, cancellation, bounded output, Job exit confirmation and command-scoped
quarantine when termination is uncertain. Unknown commands are not blindly retried
and do not stop ordinary chat. Audit records retain hashes/status, not raw commands
or output. Long-task child Agents do not inherit this capability automatically.

The exported `src/owner-shell.mjs` is byte-identical to the verified Windows
deployment's function module (SHA256
`43a368faa9242e1d9d9441f2cc16dc533b1a38606e9deda3874e75eb34921858`).
Synthetic origin tests cover admission races, source/call/argument substitution,
turn end and bounded failure. Installed rc.4 offline native tests separately
verified a legitimate incoming owner input and group/foreign/expired denials.
The running host's trusted read-only boundary returned exit0 with confirmed Job
exit; the non-owner boundary denied execution. A natural model-triggered owner
call after deployment has not been manufactured or claimed as verified. No real
chat, persona, private configuration, approval record or credential is included.

```sh
node --test tests/owner-shell-origin.test.mjs tests/owner-integrations.test.mjs
```

This is source-only integration. Applying it does not itself restart an installed
host or enable shell. Deployment must preserve the complete module graph,
including `driver/durable-client.mjs`, and existing runtime data; verify full module
import before replacing an entry. Use a verified Session 2 startup path for a
Windows UI deployment. A failed import is not a successful feature deployment.
