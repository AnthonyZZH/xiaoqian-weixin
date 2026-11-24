"""Read-only monitoring for the bridge selected by XQ_MOBILE_PATCH.

Only this source is distributed. Configuration, ledgers, credentials and
runtime tickets belong to the Windows account running the host.
"""
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from time import time

import psutil


def configured_patch():
    value = os.environ.get("XQ_MOBILE_PATCH", "")
    if not value or not Path(value).is_absolute():
        raise ValueError("Set XQ_MOBILE_PATCH to the absolute path of the Harness JSON patch")
    return Path(value).resolve()


def bridge_config():
    document = json.loads(configured_patch().read_bytes())
    operations = document if isinstance(document, list) else [document]
    bridge_name = (Path(__file__).resolve().parents[2] / "src/index.mjs").as_uri()
    candidates = []
    for operation in operations:
        if not isinstance(operation, dict):
            continue
        inserted = operation.get("insert", [])
        for plugin in inserted if isinstance(inserted, list) else [inserted]:
            if not isinstance(plugin, dict) or plugin.get("disabled") is True:
                continue
            if (plugin.get("id") != "xiaoqian-wechat-native"
                    and plugin.get("name") not in ("@local/xiaoqian-harness", bridge_name)):
                continue
            config = plugin.get("config")
            if isinstance(config, dict) and config.get("enabled") is not False:
                candidates.append(config)
    if len(candidates) != 1:
        raise ValueError("Expected one enabled Xiaoqian WeChat bridge in XQ_MOBILE_PATCH")
    config, = candidates
    if (not isinstance(config.get("stateDir"), str) or not Path(config["stateDir"]).is_absolute()
            or not isinstance(config.get("chats"), list)):
        raise ValueError("Bridge configuration requires an absolute stateDir and a chats list")
    return config


def matching_host(process, patch):
    try:
        if process.name().lower() != "node.exe":
            return None
        node = os.environ.get("XQ_MOBILE_NODE")
        if node and Path(process.exe()).resolve() != Path(node).resolve():
            return None
        args = process.cmdline()
        if len(args) < 3:
            return None

        def absolute(value):
            path = Path(value)
            if not path.is_absolute():
                path = Path(process.cwd()) / path
            return path.resolve()

        entry = absolute(args[1])
        dsh = os.environ.get("XQ_MOBILE_DSH_BIN")
        if dsh:
            if entry != Path(dsh).resolve():
                return None
        elif tuple(part.lower() for part in entry.parts[-4:]) != ("@deepseek-ai", "dsh", "lib", "bin.js"):
            return None
        for index, arg in enumerate(args[2:], start=2):
            if arg == "--patch" and index + 1 < len(args):
                value = args[index + 1]
            elif arg.startswith("--patch="):
                value = arg[len("--patch="):]
            else:
                continue
            if value and absolute(value) == patch:
                return process.pid, process.create_time()
    except (OSError, ValueError, psutil.Error):
        pass
    return None


def local_host(pid=None):
    patch = configured_patch()
    if pid is None:
        # The ticket is a fast lookup only; still verify the executable, entry and patch.
        ticket = Path(os.environ["LOCALAPPDATA"]) / "Xiaoqian/MobileStatus/native.json"
        try:
            ticket_pid = json.loads(ticket.read_bytes())["pid"]
            if type(ticket_pid) is int and ticket_pid > 0:
                host = matching_host(psutil.Process(ticket_pid), patch)
                if host:
                    return host
        except (OSError, KeyError, ValueError, TypeError, psutil.Error):
            pass
        matches = [host for process in psutil.process_iter(["name"]) if (process.info["name"] or "").lower() == "node.exe"
                   if (host := matching_host(process, patch))]
        return matches[0] if len(matches) == 1 else None
    if type(pid) is not int or pid <= 0:
        return None
    try:
        return matching_host(psutil.Process(pid), patch)
    except psutil.Error:
        return None


def timestamp(value):
    try:
        return datetime.fromisoformat(value).timestamp()
    except (TypeError, ValueError, OSError, OverflowError):
        return 0


def local_time(value):
    return datetime.fromtimestamp(value).strftime("%m-%d %H:%M:%S") if value else "—"


def latest_reads(state_dir, targets, host):
    found = {}
    for name in ("read-outcomes-node.jsonl", "read-outcomes-node.jsonl.previous"):
        try:
            with (state_dir / "driver" / name).open("rb") as journal:
                journal.seek(max(0, os.fstat(journal.fileno()).st_size - 128 * 1024))
                lines = journal.read().splitlines()
        except FileNotFoundError:
            continue
        for line in reversed(lines):
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            target = row.get("target_hash")
            if row.get("phase") != "terminal" or target not in targets or target in found:
                continue
            at = timestamp(row.get("at"))
            if not at or (host and (row.get("controller_pid") != host[0] or at < host[1])):
                continue
            found[target] = (at, row.get("outcome") == "success", row.get("code"))
            if len(found) == len(targets):
                return found
    return found


def reply_status(chat, active):
    grants = chat.get("replyPermits", {})
    for key, message in reversed(chat.get("messages", {}).items()):
        grant_id = message.get("grantId")
        if key.startswith("wake:") or not grant_id:
            continue
        retry = chat.get("panelRetry") or {}
        if retry.get("key") == key:
            if retry.get("uncertain"):
                return "重新回复待核实"
            grant_id = retry.get("grantId") or grant_id
        receipts = [r.get("status") for r in chat.get("deliveries", {}).values()
                    if r.get("grantId") == grant_id]
        grant = grants.get(grant_id, {})
        if "unknown" in receipts:
            return "发送结果待核实"
        if receipts:
            return {"ok": "已发送", "rejected": "发送失败",
                    "sending": "发送中" if active else "发送待核实"}.get(receipts[-1], "待核实")
        if message.get("status") == "unknown" or grant.get("status") in ("unknown", "followup-unknown"):
            return "处理结果待核实"
        if grant.get("status") == "skipped":
            return "本轮已跳过"
        if grant.get("status") == "open" or message.get("status") == "accepting":
            if not active:
                return "尚未完成"
            return "正在处理" if grant.get("turn") is not None else "已收信，等待处理"
        return "本轮无发送回执"
    return "暂无回复记录"


def snapshot(config, ledger, reads, host, now, watch=None):
    rows, healthy = [], 0
    watch_at = timestamp((watch or {}).get("at"))
    watch_current = (host and watch and watch.get("pid") == host[0]
                     and host[1] <= watch_at <= now and now - watch_at < 65)
    show_anchor_hint = False
    for chat in config["chats"]:
        chat_id = chat["id"]
        target = hashlib.sha256(chat_id.encode()).hexdigest()
        state = ledger.get("chats", {}).get(chat_id, {})
        at, good, code = reads.get(target, (0, False, None))
        paused = ledger.get("paused") or state.get("groupPaused")
        blocked = state.get("rotationFence") or state.get("rotationUncertain") or state.get("sendQuarantined")
        if not host:
            health = "已停止"
        elif paused:
            health = "已暂停"
        elif blocked:
            health = "暂不可用"
        elif config.get("inboxMode") == "top-private":
            if not watch_current:
                health = "等待首行监听"
            else:
                health = {"listening": "首行监听中", "peek_unavailable": "等待微信会话列表",
                          "read_pending": "首行有更新，等待读取"}.get(watch.get("outcome"), "等待首行监听")
                if watch.get("outcome") == "read_pending" and watch.get("code") == "snapshot_without_order_anchor":
                    show_anchor_hint = True
        elif not at:
            health = "等待首次读取"
        elif now - at >= 60:
            health = "读取已超时"
        elif not good:
            health = "读取失败" + (f" · {code}" if code else "")
        else:
            health = "正常"
        healthy += health in ("正常", "首行监听中")
        received = next((r.get("at") for r in reversed(ledger.get("audit", []))
                         if r.get("chat") == target and r.get("code") == "INGEST"
                         and r.get("accepted", 0) > 0), None)
        label = chat.get("title") or chat_id
        rows.append((chat_id, (label, health, local_time(at), local_time(timestamp(received)),
                               reply_status(state, bool(host and not paused and not blocked)))))
    if not host:
        return "已停止", "未找到使用当前配置的微信宿主进程。", rows
    started = local_time(host[1])
    if ledger.get("paused"):
        return "收发已暂停", f"小千于 {started} 启动", rows
    status = "运行中" if healthy == len(rows) else f"运行中 · {healthy}/{len(rows)} 个会话读取正常"
    detail = f"小千于 {started} 启动"
    if show_anchor_hint:
        detail += "。微信当前可见的消息与上次记录接不上，请扩大微信窗口，让上一条已处理消息可见。"
    return status, detail, rows


def current_status(config=None):
    if config is None:
        config = bridge_config()
    state_dir = Path(config["stateDir"])
    host = local_host()
    try:
        ledger = json.loads((state_dir / "bridge/bridge.json").read_bytes())
    except (OSError, ValueError):
        if host:
            raise
        ledger = {}
    targets = {hashlib.sha256(c["id"].encode()).hexdigest() for c in config["chats"]}
    reads = latest_reads(state_dir, targets, host)
    now = time()
    try:
        watch = json.loads((state_dir / "driver/top-private-status.json").read_bytes()) if config.get("inboxMode") == "top-private" else None
    except (OSError, ValueError):
        watch = None
    status, detail, rows = snapshot(config, ledger, reads, host, now, watch)
    panel_enabled = config.get("ownerTasks", {}).get("panel", {}).get("enabled") is True
    return status, detail, rows, bool(host and panel_enabled), now
