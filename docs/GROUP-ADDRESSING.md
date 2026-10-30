# Group replies require an explicit current-message call

The scoped policy allows clear calls such as `小千，你在吗` or `小千帮我查一下`.
Ordinary chat, discussion about the bot and wholly quoted text do not trigger an
Agent turn. Merely finding the name somewhere in the text is insufficient.
The rule uses conservative wording; ambiguous third-person statements may be ignored.

True WeChat mention and quote identities are not certified by the current adapter.
A leading textual `@小千` is treated as an explicit name call, not proof of a genuine
mention, sender identity, owner authority or quote relationship. Group tools and
memory isolation remain unchanged. Group scheduled initiative remains disabled.

The policy filters new ingress and ACKs non-triggering rows as baseline without
replaying history. Only a triggering message receives a grant. Grant consumption,
core sending and the actual driver send are checked again. Old unsent grants are
revoked when the policy is loaded; unknown send records are never replayed.
Private chat is unaffected. Authenticated owner-private relay requests retain their
existing authority; a group nickname/self-claim cannot obtain that authority.

Install `tools/group-addressed-policy/index.mjs` as a separate Cordis plugin after
the bridge service, with `source` set to the project root's absolute `file:` URL and
`work` set to an existing private metadata directory. The default binding is the
single configured `bread-group` ID. Do not copy a real profile or persona into Git.
The plugin supplies its `xiaoqianBridge` dependency and returns no API object from
Cordis `apply`. Unload fails closed for that group; replace/reload deliberately.

Keep this plugin entry in upgrade/rollback profiles: the core's older `natural`
participation setting alone does not implement this policy. Back up private profile
and state separately. `node --test tools/group-addressed-policy/test.mjs` checks
vocative filtering, ignored-message ACKs, old-grant revocation, sending denial and
private-chat routing without real messages or model calls.
