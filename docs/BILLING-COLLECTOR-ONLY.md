# Collector-only handoff

Base: 91cf93a3098e579650b7f084830be920b07639f1.
This slice observes naturally incurred official DeepSeek Messages requests. It does not summarize, retrieve library documents, invoke a model, rotate an Agent, create tasks, send messages, or alter autoEnabled. Keep rotation.autoEnabled=false.

## Files and deployment
DELIVERY_MANIFEST.json lists nine runtime/tool files and two tests. collector-only.patch applies cleanly to the pinned base. Do not copy the entire candidate checkout over a newer production tree. The sole deployment writer must reconcile these file changes with the current admin-group-prepared source and preserve its cache/status changes.

Required existing settings: ownerIntegrations.enabled=true and balance.enabled=true. Enabling the collector without that existing shim path fails with BILLING_BALANCE_SHIM_INTEGRATION_REQUIRED; there is no silent uninstrumented success.

Add only:
    billingCollector: {
      enabled: true,
      root: "C:/XiaoqianPrivate/billing-metadata"
    }
Keep rotation.autoEnabled=false. This root must be outside Git and beneath the already protected private evidence directory. On Windows mode 0600 is not an ACL: the deployer must verify inherited access is restricted to the service account, SYSTEM and Administrators before enabling. Collector code does not read existing payload or session logs.

Install these files in a new immutable deployment snapshot, then generate the composed provider shim FROM THAT FINAL PATH:
    node tools/build-billing-provider.mjs C:/xiaoqian/app/dsh/node_modules/@deepseek-ai ABSOLUTE_STATE_DIR/provider-shim
The returned path is the existing profile llm-deepseek entry's new module name (file URL). Preserve that entry's credential references and full config without reading or copying their values into evidence. The shim retains the existing balance capability and substitutes only the official final Messages fetch. Nothing modifies installed SDK files.

The bridge module and generated provider shim must use the SAME canonical collector.mjs URL. Never deploy a shim generated from the temporary candidate, add cache-busting imports to just one side, or mix snapshots: process-local registration would not pair.

## Hot activation and lifecycle
Already running code has no final-fetch boundary, so setting enabled in memory alone cannot instrument it. No public rc.4 final HTTP interceptor exists; llm/request is before final serialization and cannot establish complete wire measurements. No monkey patch of global fetch, private adapter registry or arbitrary existing adapter is used.

A coordinated loader reload of the bridge entry AND its existing official provider entry is required once. A whole OS service/host restart is not logically required by the SDK registry, but this candidate does not claim the current production loader is proven safe to reload in place. At an approved idle safe point, the deployment writer must dispose the old provider entry before initializing its replacement; a second provider route while the first is live fails DUPLICATE_ADAPTER. Reload the bridge into the same snapshot. Preserve the original module names/config references for rollback. If no authenticated safe entry-reload path is available, use one approved host reload instead. This work did neither.

After initial loading, bridge.billingCollector.setEnabled(false/true) is a host-only reversible collection toggle, with no model tool exposed. Agent-context disposal unregisters its session; bridge close unregisters the collector. Duplicate collector roots and duplicate session registrations fail explicitly. Disposal cannot unregister a newer owner. Multiple matching collectors bypass collection rather than double count.

Existing owner-balance automatic loader matching recognizes official package name or the newly generated exact shim name. An OLD different shim name will not match automatically. Explicitly updating the existing provider entry's module name to the generated path during the coordinated deployment avoids this known match gap; do not add another provider entry.

## Metadata and privacy contract
One UUID-named JSON file per physical fetch attempt. A started row is replaced atomically by settled/unavailable. Interrupted started rows remain incomplete after restart; UUIDs prevent replay/overwrite, and no old attempt is reissued. Each record contains only:
attempt UUID; hashed session; final request hash; wire byte count; empirical model-envelope UTF8 units/version (NOT tokens or a guaranteed bound); allowlisted route/model; strict family/system/tool/host-policy/history-policy hashes; request start/completion times; four numeric usage buckets and presence booleans; status/reason enum.

No messages, system/persona strings, tools schema/description, auth headers, response text, URL/secret values, tool parameters, library documents, raw errors or raw session IDs are persisted. Request/response bytes are inspected transiently at the already-existing dispatch boundary only. At most 64 pending metadata objects are retained. File writes are metadata-sized and errors increment writeFailures without blocking provider execution. Operators should archive/disable after the required sample collection; this minimal slice does not delete evidence or impose a background retention job.

Cache semantics: input_tokens is uncached input; cache_read_input_tokens/cache_creation_input_tokens are separate input buckets; output_tokens is separate. Cumulative SSE usage replaces prior values rather than summing. Missing raw fields remain null and complete=false; no inferred zero. Stream failure, cancellation, or no message_stop remains incomplete. A valid terminal message_stop settles before the SDK cancels its stream reader; EOF is not falsely required after terminal acknowledgement.

Family includes the entire rendered system, tools, in-history system/tool deltas and host identity policy, plus non-message model envelope controls. Changed dynamic system sections therefore deliberately split families. Three arbitrary usage records or three same-model requests are not certified as one stable family. Do not weaken this on the fly to make calibration pass.

Timestamps permit a separately sourced tariff/band lookup; no fee/rate is guessed here. Requests crossing tariff windows, missing buckets or unstable families remain ineligible. This collector does not authorize any economic decision.

## Offline evidence and remaining acceptance
COLLECTOR_TESTS.tap: eight passing tests, including installed rc.4 DeepSeek serialization/extensions + terminal SSE processing using synthetic fetch, Cordis adapter mount/dispose/re-register/duplicate guards, privacy/pairing, host-owner revocation and existing native queued-turn/dynamic-persona flow. Zero network/model calls.
The unrelated old native-contract fixture fails NO_REPLY_PERMIT on both the pristine pinned baseline and candidate; BASELINE_NATIVE_CONTRACT.tap records that comparison. No production permission check was weakened to satisfy it.

Deployment-only acceptance:
1. Confirm host bridge.billingCollector.status(): enabled, zero writeFailures, expected owner session registration; automaticRotationEnabled remains false. No test message or paid probe.
2. Observe at least three NATURALLY incurred complete attempts with the same strict family, matching model/meter version and valid timestamps. Inspect metadata only. If any are incomplete, report exact missing fields; do not scan chat logs.
3. Confirm the final provider entry preserved balance capability and only one official route is registered. Existing cache/status and ordinary chat flow remain normal.
4. Toggle collection off after the agreed sample window. No rotation is enabled by collecting evidence.

Rollback: set collector disabled and restore prior bridge/provider module names together at a safe idle point (or approved host reload). Preserve the private metadata directory; never delete context, jobs, persona, library or delivery/dedup state. The old source ignores billingCollector config; remove that flag if restoring a configuration validator that rejects unknown properties.
