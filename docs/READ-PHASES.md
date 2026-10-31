# Read phase audit and title selection follow-up

This component adds metadata-only stage timing to an existing serial read and removes an unused private/group control traversal during open_chat title polling. current() and validate() still freshly check the chat mode; no title/mode cache is introduced. Target, foreground, list focus, draft, receipt, ACK and send validation remain intact.

Stages: adapter_import, adapter_construct, select_open_chat, select_validate, draft_recover, edge_initial_validate, edge_list_lookup, edge_navigation_validate, adapter_read, edge_final_validate and read_total. Each entered stage emits complete/error when it returns; a killed worker may retain only enter. A last enter indicates where evidence ended, not proof that the stage alone caused a timeout. read_total includes nested stages: do not sum all durations.

read-phases-python.jsonl is written beside driver state, includes request ID, worker PID/generation, UTC time, stage/event and elapsed_ms. It excludes chat title, message body, sender, raw errors and credentials. Rotation is approximately 1 MiB to read-phases-python.previous.jsonl. Journaling OSError is nonfatal; private operational journals must remain outside Git.

The source was extracted from a fixed installed snapshot. The public worker retains owner_edge_chat validation and excludes an unrelated runtime-only raw-error diagnostic. The public edge controller retains parameterized owner/group authorization, not deployment-specific names. Only current_title/current/open_chat methods were imported into the public adapter; attachment, text-completeness and send safeguards were preserved. Source hashes and extraction scope are in READ-PHASES-SOURCE.json.

Offline validation (Python 3.12):

```powershell
python -B -m unittest discover -s tests -p test_read_phases.py -v
python -B -m unittest discover -s tests -p test_read_title.py -v
```

Three audit cases cover normal/error sanitation, a terminated actual child retaining its last stage, and the unchanged UI call graph. Five AST-extracted actual-adapter-method cases cover title-only opening, fresh mode validation, target rejection, absent-title recovery and identical unrelated methods. Fake controls do not certify real UI latency.

Live observations reported around installation included reads around 6.69-11.95 seconds and cutoff cases. The retained fixed natural-stage sample includes seven completed read_total spans of 6.922-11.531 seconds and a further adapter_read enter without a terminal at capture time. Host continuity and these aggregate observations are component evidence only; this public tree was not deployed or used to send messages by the publication task. Slow-read root cause remains unresolved; no budget increases, extra UI calls, optional measurement port or speed SLA are included.
