# SDK runtime-context task input compatibility

This maintenance slice changes three runtime modules only. rc.4 ApprovalService
can add a loop-owned runtime-context snapshot as a user/message projection. That
projection is not an additional task request. Validation now consults the native
agent/inbox/spliced admission receipts as well as user/message events.

A genuine SDK snapshot or exact context-clear notice is ignored only when its ID
was never queued as user input. An extra queued message remains extra even if its
caller supplies source.kind=runtime-context or copies the snapshot shape. Unknown
or oversized event history fails closed. The task executor, tool grants, authority,
model route, private resolver, budgets and cancellation behavior are unchanged.

Real installed-SDK tests load the global ApprovalService with an offline provider;
independent persona completion, foreground progress, cancellation and original-chat
completion pass without network/model/WeChat calls. Synthetic receipt tests retain
forged-input rejection. This does not certify a real owner task's external outcome.
No plugin/MCP approval transport or installer is enabled by this maintenance fix.
