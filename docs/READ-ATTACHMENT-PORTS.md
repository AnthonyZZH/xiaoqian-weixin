# Attachment ports: connected boundary, native download still disabled

This follow-up connects the existing durable Node driver to RPC/client/worker attachment_inspect, attachment_save_as and attachment_completion operations. These are host capabilities, not arbitrary model-facing paths or automatic WeChat downloads. No listener, shell command, new account, provider or native control selector is enabled by importing the modules.

## Identity and authority

The configured owner-private target is checked at Node and RPC entry. Caller-provided owner/mode/title flags do not grant authority. The client resolves the canonical 64-character sourceMessageId against its own durable inbox and current identity observation, requires an incoming user row and a fresh worker generation, and constructs the raw row/token handle itself. A deferred/shadow current observation cannot fall back to an older snapshot. The worker rechecks chat/generation/message/token/role against its last captured rows. Groups and other private targets are denied by the configured host entry, even if a document or model claims owner status.

## Save and completion

The native port is absent by default. A real native provider requires separately reviewed control acceptance before trusted host registration. Fake attachment fixtures are available only in fake mode. Native acceptance flags are host-supplied evidence, never permission to trust a model-created profile.

Saving requires an exact host-reserved UUID destination below attachment-downloads, a supported TXT/DOCX/PDF filename, a bounded byte limit and deadline. It rejects traversal, UNC/alternate stream paths and symlink/reparse/hardlink destinations. A durable attempted reservation is written before native action. An uncertain action never authorizes another save click for the same reservation; later calls may only check completion. Completion must independently attest exact message/chat/destination and byte count. File identity, size, change detection and SHA256 are checked before returning verified metadata. Parsing is a separate bounded host handoff; document contents remain untrusted data.

Node helper modules provide broker/ingress wiring for the existing attachment registry. They require an accepted native profile, owner authority callback and shared driver lease. No real selector implementation or accepted native provider is bundled here. The buffered helper is limited to 5 MiB; the Python transport has a separate capped limit. This commit does not claim a fully wired streaming PDF parser or live document-reading tool.

## Actual acceptance and remaining work

The fixed runtime evidence at 2026-10-31 22:26 UTC confirms that all three unknown canonical-message operations were rejected and that group calls were rejected at both Node and RPC boundaries. No UI action, file save or paid model request occurred in that boundary check. At final cleanup, nine temporary entries and the cleanup entry were removed, the original host remained running, and natural reads resumed around 2.3-4.1 seconds. These are bounded observations, not a speed SLA or receiver-side delivery proof.

**Native downloading remains disabled. Real file-card identity, Save As controls, independent download completion, and end-to-end TXT/Word/PDF delivery into the Agent are not accepted.** The temporary owner header/history/info probes and maintenance/profile entries are excluded. This is not completed WeChat file reading. Raw runtime proof, chat content, persona and credentials are not published.

## Reproduce offline checks

Use Python 3.12 and Node 24 with XQ_TEST_PYTHON set to the local interpreter. All state and file bytes are synthetic; actual fake-worker subprocess/RPC tests do not use a WeChat desktop.

```powershell
python -B -m unittest discover -s tests -p test_attachment_ports.py -v
node --test tests/attachment-ports.test.mjs
```

READ-ATTACHMENT-PORTS-SOURCE.json records fixed installed hashes and public equivalents. Public worker/RPC preserve parameterized owner configuration and the shared-vendor fallback; an unrelated raw-error runtime hook is excluded.

Publication checks: 6 Python attachment-boundary cases and 11 Node attachment/read-RPC cases passed (17 total, zero failures/skips), plus entry syntax validation. This is targeted interface regression, not a repeated whole-repository suite or real native download acceptance.
