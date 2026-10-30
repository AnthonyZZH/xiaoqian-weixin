# Owner-only supplemental tools: integration contract

This is an independent, uninstalled module. It does not modify core/live/publish,
start services, interact with WeChat, or read provider secrets. Node 22+ and Python
3.12 standard library suffice; no npm/pip dependencies are needed.

## What is implemented

- Host-bound owner tool registration with exact Agent object identity, dynamic
  authority checks, explicit revocation and cancellation.
- Official DeepSeek balance response validation using an injected authenticated
  provider transport. No new key or credential file is accepted.
- Opt-in DuckDuckGo HTML search with Bing fallback on ordinary network failures.
  CAPTCHA stops the operation; no bypass, paid search/fetch API or page crawling.
- Opaque attachment registry plus bounded TXT/DOCX extraction in a subprocess.
- Project command/file adapter, disabled unless a trusted host executor reports
  a verified OS isolation boundary. There is no host-shell fallback.

None of these tools is installed or advertised in the current live Agent merely
by creating this directory. `available()` reports only configured capabilities.

## Host / Agent binding

```js
import {createOwnerToolkit} from './owner-tools/index.mjs';
const kit = await createOwnerToolkit({
  isCurrentOwner: ({agent,bindingId}) =>
    hostBindings.isAuthenticatedOwner(agent,bindingId) && !bridgePaused,
  getProvider: () => trustedProviderAdapter, // omitted if not implemented
  searchEnabled: true,                     // explicit opt-in
  python: trustedPythonExecutable,
  attachments: attachmentRegistry,          // omitted until safe ingestion exists
  projectExecutor: isolatedExecutor,        // omitted until OS proof exists
  projectIds: ['explicit-project-id']
});
const bound = kit.bind({agent,bindingId:trustedOwnerBindingId});
bound.register(agentCtx,defineTool);
// Host must also allow exactly kit.available() in this owner's scoped guard.
// Do not add the names to group/social defaults or global native tool grants.
// On owner identity change, pause or scope disposal:
bound.revoke();
```

`bind`, `createAttachmentRegistry.register` and executor/provider callbacks are
HOST APIs, never model tools. Tool arguments cannot set owner identity, Agent
identity, provider URL, secret, project root, attachment pathname or tool grants.
`exec.agent` and nonempty `exec.callId` must come from the native host. Owner
revocation is checked before calls and before returning sensitive results; the
host should invoke `revoke()` immediately to abort in-flight operations as well.

## Shell and file boundary: intentionally requires real OS work

An arbitrary shell running as the existing Harness/WeChat account can read that
account's secrets and private memory regardless of command string filtering.
This module does **not** claim to sandbox such a process. No production executor
is included or configured. A JSON receipt is a trusted host attestation, not
independent proof and not something a model may construct.

The host must implement and test a container or distinct restricted OS account:

1. Only explicit project roots are mounted/granted. No Harness home, private
   memory, credentials, attachment spool, SSH keys, production data, host pipes,
   parent process handles, administrative token, or privileged helper access.
2. The account cannot read/control the Harness or WeChat processes, impersonate
   their accounts, inherit their handles/environment or change its ACLs into the
   denied directories. OS network policy denies egress for this executor.
3. Junctions, symlinks, hard links, alternate streams and paths are checked at the
   actual open operation inside that boundary. Lexical path checks here are
   defense in depth, not OS isolation. Commands receive a project working root
   inside the boundary, never an arbitrary host cwd.
4. A Windows Job Object/container lifecycle terminates all descendants and waits
   for exit; output, process count, CPU, memory, file growth and run duration are
   bounded. `terminateTree(operationId)` confirms whole-tree termination.
5. Negative integration probes from that account must prove secret/private-store
   reads, parent process control, egress and sandbox escape attempts fail. Store
   the evidence identifier. A mock receipt is not production acceptance.

Executor API:

```js
{
  verifyIsolation: async () => ({
    verified:true, boundary:'restricted-os-account', // or os-container
    verificationId:'real-evidence-id',
    providerCredentialsAccessible:false, privateMemoryAccessible:false,
    attachmentSpoolAccessible:false, parentProcessControl:false,
    network:'denied', killTreeVerified:true
  }),
  owner_command: async ({operationId,projectId,command,signal,maxOutputBytes}) => result,
  owner_file_read: async ({operationId,projectId,path,signal,maxOutputBytes}) => result,
  owner_file_write: async ({operationId,projectId,path,text,signal,maxOutputBytes}) => result,
  terminateTree: async operationId => true // only after confirmed tree exit
}
```

`verifyIsolation` is rechecked before every project operation. A timeout with
unconfirmed termination quarantines that executor object. Host methods must be
short, bounded and use operation IDs to prevent replay after uncertain writes.
The module does not provide durable exactly-once command execution or automatic
retries. Outputs are capped at 64 KiB. Owner project access remains powerful:
the OS policy, not a promise in the system prompt, defines its reachable files.

## Official DeepSeek balance

The current provider adapter must expose:

```js
{
  kind:'deepseek-official',
  baseURL:'https://api.deepseek.com',
  requestOfficialBalance: async ({method,path,signal,redirect}) => {
    // Reuse THIS verified provider client's internal authenticated transport.
    // GET /user/balance; reject redirects; bound response size; honor signal.
    // Return parsed JSON only. Never return/print the key or auth headers.
  }
}
```

Only HTTPS api.deepseek.com (root or SDK /v1 base) is accepted. Provider kind and
transport come from trusted host configuration. A relay/reseller provider must
not be relabelled official based on model output or an OpenAI-compatible schema.
On provider change the check runs again, before any request. Tokens have no
cryptographic issuer proof here: the host must know the configured provider.

Output is restricted to `is_available`, `currency`, `total_balance`,
`granted_balance`, `topped_up_balance`; decimal strings are preserved. Error
messages and unknown response fields are discarded. No inference, recharge,
paid Search/Fetch or model endpoint is used. Mock tests do not prove the live
provider adapter exists. Official contract consulted on 2026-10-29:
https://api-docs.deepseek.com/api/get-user-balance/

## Search and connectivity

Server public read-only probes on 2026-10-29: Python.org HTTPS 200, Bing search
HTTPS 200 (redirect to cn.bing.com), DuckDuckGo request exceeded 7 seconds.
This disproves whole-server disconnection; it does not prove every domain is
reachable. The live profile at that inspection had no `searchEnabled` field.
The follow-up DDG probe resolved DNS but timed out during TCP connection after
3.03 seconds; TLS was not reached. The new worker's real public query at
2026-10-29T14:21:36Z returned five Bing results after DDG network failure.

The worker has fixed public search origins, a 6-second request timeout per
engine, a 1 MiB response bound, a 5-result limit and a 15-second process deadline.
It does not fetch result URLs. Results are untrusted web data. Search queries
leave the server: the host must not automatically include private memory/chat
context. Only the explicit owner query is an argument. It reports no-results,
network failures and challenges instead of asserting Internet access is absent.

## Attachment ingestion / TXT / DOCX

**WeChat download/attachment receipt is still missing.** This module cannot turn
file-read permission into attachment reception. Do not expose the attachment
tool until the parent has a real receiver and a host-managed spool.

The receiver must: authenticate owner chat and stable source message ID; download
the exact selected file; enforce a 5 MiB limit during download; keep it in a
dedicated owner-only spool outside project mounts; atomically finish the write;
reject symlink/junction/hard-link tricks; then call the HOST API:

```js
const registry=createAttachmentRegistry({root:absoluteHostManagedSpool});
const descriptor=registry.register({
  absolutePath:downloadedPath, ownerBindingId:trustedOwnerBindingId,
  sourceMessageId:stableMessageId, displayName:'user-visible-name.docx'
});
// Supply descriptor.id in trusted attachment metadata to that owner Agent.
```

Registry IDs are in-memory and expire on module restart; re-register only from
the host's durable validated download records. The tool accepts only that opaque
ID and checks the same owner binding. The registry denies path escape, links,
multiple hard links, changed file identity, unsupported types and oversized
files. The root and its ancestors must have host-only write ACLs: this Node code
is not an ACL verifier and cannot guarantee a TOCTOU-free arbitrary hostile
shared Windows directory. A trusted immutable spool is a required boundary.

TXT accepts UTF-8 (optional BOM) and BOM-marked UTF-16, rejects binary NULs and
ambiguous legacy encodings. DOCX reads only document body/table text, tabs and
line breaks; no `.doc`, `.docm`, macros, DTD/entities, embedded objects, external
relationships, image OCR, headers/footers/comments or document commands execute.
It never extracts ZIP entries to disk. ZIP count, expansion and individual XML
sizes are bounded. Output beyond 60000 characters is explicitly truncated with
the original count. Text is labelled `untrusted_document_content`; content
cannot create tool grants. Parser is a short-lived process with no provider
credentials, not a proven OS sandbox for parser vulnerabilities.

## Cross-target sends: parent-core contract only

This module neither sends messages nor scans contacts. The owner may request an
explicit recipient without maintaining a manual allowlist; other participants
cannot inherit that authority. Parent core remains the sole send implementation.

Suggested host-only dispatch envelope:

```js
{
  source:{ownerBindingId,ownerAgent,authenticatedMessageId},
  intent:{recipientExactName,recipientKind:'private',body},
  operationId:hostStableId,
  resolvedTarget:{stablePlatformId,exactDisplayName,kind},
  resolution:'unique-exact-match'
}
```

Authenticate the originating owner and explicit recipient/body first; resolve
only that named target, fail on ambiguity, then grant a single-use durable send
operation. No arbitrary owner boolean, scope string or whitelist edit in model
arguments grants authority. Do not infer recipients, enumerate all chats, scan
private memory to fill the body, or run a real-send test without a concrete
requested recipient and message. Group Agent tools cannot access owner dispatch
grants or owner stores. Unknown delivery stays attached to that operation; a
later independent explicit owner request gets its own operation. The caller
must not retry a consumed grant under a new ID. These are integration contracts,
not an implemented or tested dynamic-recipient sender in this module.

## Tests

```
node --test --test-concurrency=1 --test-timeout=10000 tests/toolkit.test.mjs
python -B tests/test_worker.py
```

Set OWNER_TOOLS_TEST_PYTHON to the server Python executable for the Node subprocess
test. Tests use synthetic text, balances, documents and mocked provider/executor
transports. They never call a model, send WeChat or read a real credential.
