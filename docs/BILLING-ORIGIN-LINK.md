# Minimal host-origin linkage

Baseline: a974d5071cb44d1ca2e2779669dc12342c9bfae4. Offline candidate only.

## Why no retrospective exact join
Current collector rows contain a random physical HTTP attempt UUID, session hash and request hash, but no native turn/step/attempt identity. The SDK provider request passes sessionId but omits its logical turn and live attempt ID. ReplyPermits retain host-issued nativeMessageId/kind/turn, while native stream events expose turn/step/attemptId. No shared stable key connects those records to OLD collector UUIDs. Matching by time, usage values or same session/model is not accepted. No raw logs, prompts, request bodies, credentials or private state were scanned to manufacture a join. Old observations stay unlinked.

## Minimal runtime changes
1. src/billing/native-origin.mjs: new metadata-only per-Agent observer.
2. src/billing/owner-binding.mjs: connects host receipt lookup and native observer to existing collector registration.
3. src/billing/collector.mjs: copies an explicitly whitelisted origin snapshot into each attempt's existing metadata row.
No SDK source, provider shim, model prompt, tool schema, permissions, economics policy or core chat dispatch changes.

The existing host-generated nativeMessageId must match an open ReplyPermits entry. Only that host entry's incoming/proactive kind classifies natural_user/wake. A message source label alone cannot classify anything. The rc.4 loop-owned runtime-context snapshot is ignored as decoration, never as an input trigger. Other unreceipted user messages make the turn unknown. Multiple authorized trigger kinds become mixed and are not certified as user-only.

Actual session/event turn/start, step/start and user/message signals identify the logical turn; actual agent/assistant-stream start supplies native attempt/turn/step. The SDK publishes this start BEFORE iterating the provider stream. The collector snapshots the association at the final HTTP boundary. Multiple physical HTTP retries can share the same logical native attempt; physical UUIDs stay separate.

Origin fields:
- target_category: owner_private (only already authenticated owner/private binding is eligible).
- trigger_type: natural_user, wake or mixed.
- native_turn, native_step, native_turn_event_seq: native numeric identity.
- native_attempt_hash: SHA256(agent lifecycle nonce + native SDK attempt ID).
- agent_lifecycle: random UUID distinguishes resumed Agents whose process-local attempt counters restart.
- source_receipt_hashes: at most 8 hashes of generated native message IDs.
- link_status: host_receipt_and_native_attempt or mixed_host_receipts.

No target ID, display name, sender, WeChat ID, raw session ID, native attempt ID (which embeds the session ID), raw receipt/message ID, wake ID, message content, persona, token or credential is persisted. No role/trigger fields from tool arguments or model output are trusted. Unknown/missing/inconsistent events give origin=null without suppressing otherwise valid usage collection.

Existing usage completeness and origin eligibility are separate:
complete=true AND origin.link_status=host_receipt_and_native_attempt AND trigger_type=natural_user are required for user-origin calibration, in addition to route/family/meter/price consistency. Wake/mixed/null records do not count as natural-user evidence. This does not authorize rotation.

## Deployment and rollback
Do not modify the running source from this candidate. The sole deployment writer may apply origin-link.patch to the pinned baseline and reconcile any later source changes. Update the three runtime files together in a new immutable snapshot. Collector and binding must import the SAME collector.mjs URL. Existing provider shim imports that module by absolute URL, so regenerate the composed shim from the final new snapshot and coordinate bridge/provider entry reload using the existing collector deployment procedure. Do not leave an old provider shim pointing at the prior collector singleton.

No new switch is needed: existing billingCollector.enabled and rotation.autoEnabled=false remain. No model probe or new summary is necessary. Existing owner Agents must receive the new observer through their normal setup lifecycle; loading code alone does not backfill current or historical turns. A resumed in-flight turn with missing start/source events remains unknown.

Rollback by restoring bridge/provider module names together at an approved idle safe point; retain collected metadata. Old consumers with an exact top-level metadata whitelist must add optional origin and validate its fixed nested fields before reading new rows. Existing economics consumers may ignore origin only in shadow mode; they must not silently count unlinked records as user-origin calibration.

## Evidence
ORIGIN_TESTS.tap includes actual installed rc.4 Cordis/Agent loop, host WeChatCore ingress and wake, native event frames and fake local fetch. Two native attempts map to three physical attempts (including retry), with natural_user/natural_user/wake origin. The test verifies hashes against native frame IDs and host receipt metadata exactly, with zero network calls, model API calls and sends.
Synthetic tests also cover forged labels, mixed/foreign input, wrong Agent, mismatched turn/step, disposal, lifecycle nonce uniqueness, and existing collector/provider/binding regressions.

This candidate cannot repair the origin labels of existing production records. After an independently authorized deployment, wait for natural events; do not send a calibration probe.
