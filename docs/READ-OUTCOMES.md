# Read terminal outcomes

## Scope and limits

This component records metadata-only read lifecycle evidence in the compatibility Python driver and the Node transport. It closes missing-terminal/future-completion paths; it does not solve slow UI reads, replay old messages, confirm delivery, change time budgets or loosen identity/permission checks. No optional worker measurement port or new network listener is included.

The deployed component had six naturally occurring reads with paired host/Python outcomes. Successful reads remained about 10.2–11.6 seconds; failures reached the existing approximately12-second backend_read_wait deadline and a later worker generation succeeded. These observations are not a performance SLA, a full-runtime deployment certification or proof of receiver-side message visibility.

## Source and flow

| File | Responsibility |
| --- | --- |
| compat/vendor/xiaoqian_driver/read_audit.py | Python queued/terminal metadata, safe codes and bounded journal rotation |
| compat/vendor/xiaoqian_driver/client.py | Complete read futures on success, exception, timeout, dispatcher failure and shutdown; attach worker/generation metadata |
| compat/driver/bridge_rpc.py | Carry a read request ID and sanitized Python outcome across the existing JSONL facade |
| driver/read-outcomes.mjs | Node admitted/terminal/exit metadata and in-memory diagnostic status |
| driver/durable-client.mjs | Record completion on every read transport path while retaining existing call guards |

No raw private proof or runtime file is bundled. Public-file SHA256 values and the deployed RPC compatibility difference are recorded in READ-OUTCOMES-SOURCE.json; paths there are repository-relative. SOURCE.json retains prior provenance and records this component separately from the whole-release deployment status.

## Metadata and interpretation

Under the private driver state directory, Python appends read-outcomes-python.jsonl and Node appends read-outcomes-node.jsonl. The schema includes request IDs, timestamps, stage/outcome, elapsed milliseconds, generation, process/exit metadata when known, and a hash of the target ID on the host side. It excludes message bodies, chat titles, persona, model/shell arguments, credentials and raw exception strings. Unknown codes are sanitized.

Python records queued and one terminal attempt. Host records admitted and one terminal attempt; rpc_request_id links to the Python request_id. Driver readDiagnosticsStatus() reports started, finished, pending, writeFailures and last metadata. A journal-write failure is a local diagnostic failure and must not hang a future. In-memory status and persisted records are different evidence sources; an abrupt host termination cannot magically append a final row after process death.

The host timing_scope is queued_to_terminal only when the queue origin is actually known. A preexisting captured call guard can enter the upgraded _call path directly: timing_scope is admitted_to_terminal and queue_ms is null. null means unavailable, not zero. Successful INGEST audit timestamps are not polling-attempt heartbeats.

Outcomes are success, timeout, cancelled or error. A read timeout is not an unknown send. The existing inbox, ACK transaction, send dedupe and unknown-send behavior are unchanged. Outer RPC death can leave the host's python field null; do not invent a Python acknowledgement. An old diagnostic consumed marker is not proof that a read finished.

Journals rotate when the existing file exceeds approximately1MiB. Python retains read-outcomes-python.previous.jsonl; Node retains read-outcomes-node.jsonl.previous. Keep these files outside source control. Even metadata can identify operational relationships: sanitize IDs and retain only necessary timing/code fields when filing a public issue.

## Reproduce the offline regression

Use Node24 and Python3.12. From the repository root:

```powershell
$env:XQ_TEST_PYTHON = 'C:\Python312\python.exe'
& $env:XQ_TEST_PYTHON -B -m unittest discover -s tests -p test_read_audit.py -v
node --test tests/read-outcomes.test.mjs tests/read-outcomes-hot-apply.test.mjs
```

The seven Python cases use actual fake-mode worker subprocesses: successful request binding, timeout then subsequent recovery, worker exit, backend exception sanitization, close cancelling inflight/queued reads, dispatcher BaseException completion, and the synthetic legacy consumed-without-completion regression.

The nine Node cases cover actual JSONL RPC/client/fake-worker pairing, backend failure, outer timeout, cancellation, RPC exit, journal-write failure, an existing captured call guard, and two synthetic lifecycle/override-refusal checks. Lifecycle code under tests/fixtures is a test-only fixture, not a deployment entry. Test state lives under .test-scratch; no real UI, model/provider request, native installation or WeChat send occurs. A missing XQ_TEST_PYTHON fails explicitly rather than silently skipping.

## Remaining diagnosis

Backend_read_wait still combines lazy adapter/dependency load, selecting a chat, draft recovery, UIA title/focus checks, row traversal/media readiness and final validation. No duration for those subphases is claimed by this component. Single UIA traversals are not hard-bounded by the short Exists argument. Do not call a higher budget, missing error log, or a fake-clock result a live UI fix. Add only separately reviewed source-stage evidence before attributing the slow path.
