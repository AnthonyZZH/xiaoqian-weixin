# Native UI lookup and worker recovery

The previous read-terminal and phase-audit fixes are retained. This follow-up addresses repeated Python UIAutomation descendant traversal for title, private-header and input predicates. Native UIAutomation queries remain scoped to descendants of the same freshly checked window. Conditions preserve control type plus the exact class/automation ID, or the original title-ID regular expression. Ambiguous title matches and unsupported providers fall back to the original library lookup. No recipient cache, inferred owner authority, reduced search depth, deadline increase or new listener is introduced.

For a private target, a freshly found title's live ancestor with the existing private-header class is a positive type witness. Unknown/stale ancestry falls back to the full query. Group checks do not use this private shortcut. validate() still rejects changed titles, wrong chat type and missing/wrong input controls. The duplicate validate immediately before read() was removed because read() starts with a fresh validate and no intervening UI action; final focus/foreground, draft, receipt and send protections remain.

Worker startup now owns the actual worker PID. On Windows it launches sys._base_executable with -S, adds the existing environment's site directories, and runs the worker module. It verifies that the hello PID equals Popen.pid. It does not install packages or alter the active environment. On other platforms the existing sys.executable module invocation remains. A quarantined live or missing process handle stays denied; only a confirmed exit of the original Popen handle permits stream cleanup and admission of a later worker. It never kills an arbitrary PID or silently clears uncertainty.

## Evidence and limits

The fixed installed snapshot's latest eight naturally occurring alternating private/group read terminal records at 2026-10-31 21:28 UTC were successful, about 2.48-3.00 seconds. The existing host was not restarted. These are a short observed sample, not a latency SLA, broad load test, delivery/receiver confirmation, or proof that all future cutoff cases are fixed. One stage record was still in flight at capture; the eight terminal outcomes are the completed-read evidence. Raw IDs, chat data and runtime proofs are excluded from this repository.

The public adapter imports only the lookup/title/type/selection methods; its existing text completeness, attachment and send safeguards remain. The public edge controller retains parameterized owner configuration. The public worker retains its prior safe owner checks and excludes an unrelated raw runtime error-file hook. READ-NATIVE-SOURCE.json maps exact installed hashes and public equivalents.

Temporary maintenance/sample hooks and file-card sampling were removed in the reviewed runtime evidence. Those hooks are not included here. Attachment downloading remains disabled/unaccepted. Metering remains withdrawn. This is not a claim that the whole project or every tool capability is complete.

## Offline validation

Use Python 3.12 and Node 24. The synthetic worker tests use actual subprocesses, not real WeChat UI or a paid model. For the Windows venv case, run the tests with an existing venv interpreter or a newly created temporary local venv with no package download. Require Popen.pid == hello.pid, successful read/close and forced-hang termination. Stage/private/native tests compile the final adapter methods with fake controls; they validate predicates and fallback, not real provider latency.

```powershell
$env:XQ_TEST_PYTHON = 'C:\Python312\python.exe'
& $env:XQ_TEST_PYTHON -B -m unittest discover -s tests -p 'test_read*.py' -v
& $env:XQ_TEST_PYTHON -B -m unittest discover -s tests -p 'test_worker*.py' -v
node --test tests/read-outcomes.test.mjs tests/read-outcomes-hot-apply.test.mjs
```

Publication regression: 33 read/predicate cases, 10 worker/reaping cases and 9 Node transport/lifecycle cases passed (52 total, zero failed/skipped), plus Node entry syntax validation. The worker set includes an actual temporary Windows venv created without pip/package download. Full command output is retained only in the isolated review evidence, not published runtime proof.
