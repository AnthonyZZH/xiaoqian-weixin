"""Read-only monitoring for the bridge selected by XQ_MOBILE_PATCH.

Only this source is distributed. Configuration, ledgers, credentials and
runtime tickets belong to the Windows account running the host.
"""
import hashlib
import json
import sqlite3
from contextlib import closing
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


STATUS_FIELDS = ("name", "health", "lastRead", "lastReceived", "reply", "lastSent", "waiting", "unconfirmedSends")


def read_metadata(path):
    try:
        value = json.loads(path.read_bytes())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def legacy_sent_times(state_dir, chats):
    """Old successful driver receipts recorded their start time, not their confirmation time."""
    if not chats:
        return {}
    file = state_dir / "driver/driver.sqlite3"
    found = {}
    try:
        with closing(sqlite3.connect(file.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)) as db:
            for chat in chats:
                identity = {"name": chat.get("title") or chat["id"], "mode": chat.get("mode", "private")}
                key = hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True,
                                                separators=(",", ":")).encode()).hexdigest()
                row = db.execute("SELECT MAX(g.reserved_at) FROM send_scope g JOIN sends s USING(operation_id) "
                                 "WHERE g.chat_key=? AND s.status='success'", (key,)).fetchone()
                if row and timestamp(row[0]):
                    found[chat["id"]] = local_time(timestamp(row[0])) + "（发起）"
    except sqlite3.Error:
        pass
    return found


def elapsed(since, now):
    seconds = int(max(0, now - since))
    if seconds < 60:
        return f"{seconds} 秒"
    if seconds < 3600:
        return f"{seconds // 60} 分钟"
    return f"{seconds // 3600} 小时 {(seconds % 3600) // 60} 分钟"


def launcher_summary(launcher, fallback, now):
    phase, reason = launcher.get("phase"), launcher.get("reason")
    if launcher.get("version") != 1:
        return "已停止", fallback
    active = phase in ("starting", "backoff") or (phase == "blocked" and reason == "desktop_unavailable")
    pid = launcher.get("pid")
    if active and (type(pid) != int or pid <= 0 or not psutil.pid_exists(pid)):
        return "已停止", fallback
    labels = {"host_exit": "微信宿主意外退出", "library_exit": "记忆库意外退出",
              "library_start": "记忆库未能启动", "host_start": "微信宿主未能启动",
              "desktop_unavailable": "等待当前用户登录并解锁桌面", "paused": "收发已暂停",
              "ledger_unavailable": "无法确认运行账本", "host_present": "已有宿主进程，需核对",
              "bridge_lock": "账本锁需要核对", "driver_busy": "上一微信驱动仍在运行", "port_in_use": "服务端口已被占用",
              "user_stop": "已手动停止", "normal_exit": "已正常停止"}
    why = labels.get(reason, "请检查本机启动器")
    if phase == "starting":
        return "正在启动", "启动器正在检查微信宿主和记忆库。"
    if phase == "backoff":
        when = timestamp(launcher.get("retryAt"))
        delay = max(0, int(when - now)) if when else None
        suffix = f"，约 {delay} 秒后重试" if delay is not None else ""
        return "等待自动恢复", why + suffix
    if phase in ("blocked", "exhausted"):
        if reason == "desktop_unavailable":
            return "等待桌面就绪", why
        return "恢复需人工处理", why + ("，已用尽自动重试次数。" if phase == "exhausted" else "。")
    if phase == "stopped":
        return "已停止", why + "。"
    return "已停止", fallback


def snapshot(config, ledger, reads, host, now, watch=None, cursors=None, legacy_sends=None, launcher=None):
    rows, affected, unconfirmed_total = [], 0, 0
    watch = watch or {}
    watch_at = timestamp(watch.get("at"))
    watch_current = bool(host and watch.get("pid") == host[0]
                         and host[1] <= watch_at <= now and now - watch_at < 65)
    missing_cursor = cursors is None
    show_anchor_hint = False
    for chat in config["chats"]:
        chat_id = chat["id"]
        target = hashlib.sha256(chat_id.encode()).hexdigest()
        state = ledger.get("chats", {}).get(chat_id, {})
        at, good, code = reads.get(target, (0, False, None))
        paused = ledger.get("paused") or state.get("groupPaused")
        blocked = state.get("rotationFence") or state.get("rotationUncertain") or state.get("sendQuarantined")
        cursor = (cursors or {}).get(chat_id) or {}
        pending = cursor.get("pending") is True
        if not host:
            health = "已停止"
        elif paused:
            health = "已暂停"
        elif blocked:
            health = "暂不可用"
        elif config.get("inboxMode") == "top-private":
            if pending:
                health = "首行有更新，等待读取"
                if cursor.get("pendingCode") == "snapshot_without_order_anchor":
                    show_anchor_hint = True
            elif not watch_current:
                health = "等待首行监听"
            elif watch.get("outcome") == "peek_unavailable":
                health = "等待微信会话列表"
            elif watch.get("outcome") == "read_pending" and missing_cursor:
                health = "待确认读取状态"
            elif watch.get("outcome") in ("listening", "read_pending"):
                health = "首行监听中"
            else:
                health = "等待首行监听"
        elif not at:
            health = "等待首次读取"
        elif now - at >= 60:
            health = "读取已超时"
        elif not good:
            health = "读取失败" + (f" · {code}" if code else "")
        else:
            health = "正常"

        received = state.get("lastReceivedAt") or next((r.get("at") for r in reversed(ledger.get("audit", []))
                if r.get("chat") == target and r.get("code") == "INGEST" and r.get("accepted", 0) > 0), None)
        received_at = timestamp(received)
        receipts = state.get("deliveries", {}).values()
        unconfirmed = sum(row.get("status") == "unknown" and not row.get("reviewed") for row in receipts)
        unconfirmed_total += unconfirmed
        reply = reply_status(state, bool(host and not paused and not blocked))
        waiting = []
        if pending:
            since = timestamp(cursor.get("pendingSince"))
            waiting.append("等待读取" + (" · " + elapsed(since, now) if since else " · 起始时间未记录"))
        sending = [row for row in receipts if row.get("status") == "sending"]
        if sending:
            since = min((at for row in sending if (at := timestamp(row.get("startedAt")))), default=0)
            sending_stage = "等待微信发送回执" if host else "发送待核实"
            waiting.append(sending_stage + (" · " + elapsed(since, now) if since else " · 起始时间未记录"))
        elif reply in ("正在处理", "已收信，等待处理", "尚未完成"):
            waiting.append(reply + (" · 收信后 " + elapsed(received_at, now) if received_at else ""))
        reply_issue = reply in ("发送失败", "本轮无发送回执", "处理结果待核实", "发送结果待核实", "重新回复待核实", "待核实")
        if health not in ("正常", "首行监听中") or reply_issue:
            affected += 1
        label = chat.get("title") or chat_id
        sent_at = timestamp(state.get("lastConfirmedSentAt"))
        last_sent = local_time(sent_at) if sent_at else (legacy_sends or {}).get(chat_id, "—")
        rows.append((chat_id, (label, health, local_time(at), local_time(received_at), reply,
                               last_sent, " / ".join(waiting), unconfirmed)))
    if not host:
        status, detail = launcher_summary(launcher or {}, '未找到使用当前配置的微信宿主进程。', now)
        return status, detail, rows
    started = local_time(host[1])
    if ledger.get("paused"):
        return "收发已暂停", f"小千于 {started} 启动", rows
    status = f"运行中 · {affected} 个会话需关注" if affected else "运行中"
    detail = f"小千于 {started} 启动"
    if (launcher and launcher.get("reason") in ("library_exit", "library_start")
            and launcher.get("phase") in ("backoff", "exhausted")
            and host[1] <= timestamp(launcher.get("updatedAt")) <= now + 1):
        recovery, info = launcher_summary(launcher, "", now)
        if info:
            status = "微信运行中 · 记忆库" + ("待恢复" if recovery == "等待自动恢复" else "需人工处理")
            detail += " · " + info
    if unconfirmed_total:
        detail += f" · {unconfirmed_total} 笔历史发送结果待核实"
    if show_anchor_hint:
        detail += "。请扩大微信窗口，让上一条已处理消息可见。"
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
    watch, cursors = {}, None
    if config.get("inboxMode") == "top-private":
        watch = read_metadata(state_dir / "driver/top-private-status.json")
        cursors = read_metadata(state_dir / "driver/top-private-cursors.json") or None
    legacy = [c for c in config["chats"] if not ledger.get("chats", {}).get(c["id"], {}).get("lastConfirmedSentAt")]
    sends = legacy_sent_times(state_dir, legacy)
    launcher = read_metadata(state_dir / "launcher-status.json")
    status, detail, rows = snapshot(config, ledger, reads, host, now, watch, cursors, sends, launcher)
    panel_enabled = config.get("ownerTasks", {}).get("panel", {}).get("enabled") is True
    return status, detail, rows, bool(host and panel_enabled), now
