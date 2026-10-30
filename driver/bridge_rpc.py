"""Host-only JSONL facade over the durable xiaoqian_driver client.

No model, WeChat, or UI code runs here. The client owns the only UI worker.
"""
from __future__ import annotations

import json
import hashlib
import base64
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vendor"))
from xiaoqian_driver import Chat, DriverClient, DriverConfig  # noqa: E402
from xiaoqian_media import MediaLibrary  # noqa: E402
from owner_wake_policy import ScheduleConfig, Scheduler  # noqa: E402


def reply(request_id, status, **rest):
    print(json.dumps({"id": request_id, "status": status, **rest}, ensure_ascii=False), flush=True)


def serve():
    client = None
    chats = {}
    libraries = {}
    allow_static_capture = False
    scheduler = None
    trusted_owner = set()
    try:
        for line in sys.stdin:
            request_id = None
            try:
                request = json.loads(line)
                request_id = request["id"]
                op = request["operation"]
                args = request.get("args") or {}
                if op == "initialize":
                    if client is not None:
                        raise ValueError("already_initialized")
                    config = args["config"]
                    if config.get("mode") not in ("fake", "real"):
                        raise ValueError("invalid_mode")
                    chats = {row["id"]: Chat(row["title"], row["mode"])
                             for row in config["chats"]}
                    trusted_owner = {row["id"] for row in config["chats"] if row.get("owner") is True}
                    if len(chats) != len(config["chats"]):
                        raise ValueError("duplicate_chat")
                    if config["mode"] == "real" and not config.get("allow_real"):
                        raise ValueError("real_mode_not_authorized")
                    options = DriverConfig(
                        mode=config["mode"], allow_real=config.get("allow_real") is True,
                        adapter_root=config.get("adapter_root"),
                        media_root=config.get("media_root"),
                        allowed_chats=tuple(chats.values()),
                        command_timeout=config.get("command_timeout", 5.0),
                        max_chars=config.get("max_chars", 1000),
                        fake_options=config.get("fake_options", {}),
                    )
                    client = DriverClient(config["state_dir"], options)
                    media_root = config.get("media_root")
                    if not isinstance(media_root, str) or not Path(media_root).is_absolute():
                        raise ValueError("media_root_required")
                    import_roots = config.get("media_import_roots", [])
                    if not isinstance(import_roots, list):
                        raise ValueError("invalid_media_import_roots")
                    libraries = {chat_id: MediaLibrary(
                        media_root, collection="c_" + hashlib.sha256(chat_id.encode()).hexdigest()[:32],
                        allowed_import_roots=import_roots)
                        for chat_id in chats}
                    allow_static_capture = config.get("media_allow_static_capture") is True
                    schedule_settings = config.get("initiative", {})
                    schedule_input = {**schedule_settings,
                                      "owner": next(iter(trusted_owner), None),
                                      "chats": {row["id"]: {"mode": row["mode"],
                                                          "muted": row.get("muted") is True}
                                                for row in config["chats"]},
                                      "social_timezone": config.get("time_zone", "Asia/Shanghai")}
                    scheduler = Scheduler(config["schedule_path"],
                                          ScheduleConfig.from_legacy(schedule_input))
                    reply(request_id, "ok", code="DRIVER_READY")
                    continue
                if client is None:
                    raise ValueError("not_initialized")
                if op == "close":
                    client.close()
                    client = None
                    reply(request_id, "ok", code="CLOSED")
                    break
                if op == "health":
                    reply(request_id, "ok", code="HEALTHY", data=client.health())
                    continue
                if op == "schedule_poll":
                    reply(request_id, "ok", code="SCHEDULE_POLL",
                          events=[asdict(event) for event in scheduler.poll()],
                          nextWakeup=scheduler.next_wakeup())
                    continue
                target_id = args.get("targetId")
                if target_id not in chats:
                    raise ValueError("target_denied")
                chat = chats[target_id]
                if op == "read":
                    result = client.read(chat)
                    rows = []
                    for item in result.messages:
                        if item.chat_key != chat.key:
                            raise ValueError("chat_binding_mismatch")
                        rows.append({"id": item.message_id, "text": item.text,
                                     "role": item.role, "sender": item.sender,
                                     "sourceKey": item.source_key,
                                     "imageAvailable": item.image_available,
                                     "voiceAvailable": item.voice_available,
                                     "textComplete": item.text_complete, "textSource": item.text_source,
                                     "legacyMessageIds": list(item.legacy_message_ids)})
                    deferred=[{"id":item.message_id,"textLength":len(item.text),"textSource":item.text_source,
                               "reason":item.text_reason,"legacyMessageIds":list(item.legacy_message_ids)} for item in result.deferred]
                    reply(request_id, "ok", code="READ", messages=rows,deferred=deferred,identityVersion="uia-row-v2", identityDeferred=getattr(client._state, "last_identity_defer", None), identityDuplicateCount=result.duplicate_count)
                elif op == "ack":
                    ids = args.get("messageIds")
                    if not isinstance(ids, list) or len(ids) > 200 or any(
                            not isinstance(item, str) or len(item) != 64 for item in ids):
                        raise ValueError("invalid_ack")
                    pending = {item.message_id for item in client.pending(chat)}
                    count = client.ack(set(ids) & pending)
                    reply(request_id, "ok", code="ACK", count=count)
                elif op == "send_text":
                    result = client.send(chat, args["text"], at=args.get("at", ()),
                                         operation_id=args["idempotencyKey"])
                    status = {"success": "ok", "failed": "rejected",
                              "unknown": "unknown"}[result.status]
                    reply(request_id, status, code=result.code,
                          confirmation=result.confirmation,
                          missingMentions=result.missing_mentions)
                elif op == "transcribe":
                    reply(request_id, "ok", code="TRANSCRIBED",
                          text=client.transcribe(chat, args["sourceKey"]))
                elif op == "extract_image":
                    reply(request_id, "ok", code="STATIC_CAPTURE",
                          base64=client.extract_image(chat, args["sourceKey"]),
                          sourceKind="static_capture")
                elif op == "send_image":
                    target, _original = libraries[target_id].read_for_send(
                        args["stickerId"], allow_static_capture=allow_static_capture)
                    result = client.send_file(chat, str(target.path), target.sha256,
                                              operation_id=args["idempotencyKey"])
                    status = {"success": "ok", "failed": "rejected",
                              "unknown": "unknown"}[result.status]
                    reply(request_id, status, code=result.code,
                          confirmation=result.confirmation, animated=target.animated)
                elif op == "media_catalog":
                    lib = libraries[target_id]
                    rows = (lib.pending(limit=100) if args.get("includePending") else
                            lib.search(args.get("query", ""), limit=min(100, args.get("limit", 20))))
                    reply(request_id, "ok", code="CATALOG", records=[row.to_dict() for row in rows])
                elif op == "media_review":
                    lib = libraries[target_id]
                    action, media_id = args.get("action"), args.get("mediaId")
                    if action == "approve":
                        row = lib.keep(media_id)
                    elif action == "reject":
                        row = lib.discard(media_id)
                    elif action == "describe":
                        row = lib.set_description(media_id, args["description"])
                    else:
                        raise ValueError("invalid_media_action")
                    reply(request_id, "ok", code="REVIEWED", record=row.to_dict())
                elif op == "media_import_file":
                    row = libraries[target_id].import_file(
                        args["path"], description=args.get("description", ""),
                        name=args.get("name", ""), tags=args.get("tags", ()))
                    reply(request_id, "ok", code="IMPORTED_PENDING", record=row.to_dict())
                elif op == "media_import_static":
                    data = base64.b64decode(args["base64"], validate=True)
                    if len(data) > 1024 * 1024:
                        raise ValueError("static_capture_too_large")
                    row = libraries[target_id].import_static_capture(data,
                        description=args.get("description", ""),
                        source_label="wechat-ui-static-screen-capture")
                    reply(request_id, "ok", code="STATIC_PENDING", record=row.to_dict())
                elif op == "media_preview":
                    lib = libraries[target_id]
                    row = lib.get(args["mediaId"])
                    if row.source_kind != "static_capture":
                        raise ValueError("vision_requires_static_capture")
                    target = lib.preview_target(row.media_id)
                    data = target.path.read_bytes()
                    if hashlib.sha256(data).hexdigest() != row.sha256 or len(data) > 1024 * 1024:
                        raise ValueError("static_capture_changed")
                    reply(request_id, "ok", code="STATIC_PREVIEW",base64=base64.b64encode(data).decode("ascii"),
                          label=target.label)
                elif op == "media_resolve":
                    target = libraries[target_id].resolve_send_target(
                        args["mediaId"], allow_static_capture=allow_static_capture)
                    reply(request_id, "ok", code="ORIGINAL_VERIFIED",
                          media={"id": target.media_id, "sha256": target.sha256,
                                 "animated": target.animated, "kind": target.format})
                elif op == "schedule_heard":
                    text = args.get("text", "")
                    owner_sleep = target_id in trusted_owner and any(
                        word in text for word in ("睡了", "睡觉", "晚安", "去睡", "困了", "休息了"))
                    result = scheduler.heard(target_id, chat.mode,
                                             source_id=args["sourceId"], owner_sleep=owner_sleep)
                    reply(request_id, "ok", code="HEARD", changed=result)
                elif op == "schedule_spoke":
                    result = scheduler.spoke(target_id, chat.mode, source_id=args["sourceId"])
                    reply(request_id, "ok", code="SPOKE", changed=result)
                elif op == "schedule_claim":
                    claim = scheduler.claim(args["eventId"], "xiaoqian-bridge", lease_seconds=60)
                    if claim is not None and (claim.event.chat_id != target_id or claim.event.mode != chat.mode):
                        raise ValueError("schedule_chat_mismatch")
                    reply(request_id, "ok", code="CLAIM", claim=asdict(claim) if claim else None)
                elif op == "schedule_renew":
                    renewed = scheduler.renew(args["eventId"], args["token"], lease_seconds=60)
                    reply(request_id, "ok", code="RENEW", renewed=renewed)
                elif op == "schedule_prepare":
                    reservation = scheduler.prepare_send(args["eventId"], args["token"])
                    reply(request_id, "ok", code="PREPARE", reservation=reservation)
                elif op == "schedule_finish":
                    finished = scheduler.finish(args["eventId"], args["token"], args["outcome"], decision=args.get("decision"))
                    reply(request_id, "ok", code="FINISH", finished=finished)
                else:
                    raise ValueError("operation_denied")
            except Exception as exc:
                code = getattr(exc, "code", None) or str(exc)
                reply(request_id, "rejected", code=str(code)[:120])
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    serve()
