"""python -B -m xiaoqian_schedule.demo: simulated lifecycle, no external I/O."""
from dataclasses import asdict
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from .config import ChatPolicy, ScheduleConfig
from .engine import Scheduler


def main():
    now = [1793260800.0]
    cfg = ScheduleConfig((ChatPolicy("synthetic-owner", "private", owner=True, quiet=()),), owner_peak_seconds=(60, 60), owner_offpeak_seconds=(60, 60))
    with TemporaryDirectory() as directory:
        path = Path(directory) / "fake-state.sqlite3"
        scheduler = Scheduler(path, cfg, clock=lambda: now[0])
        scheduler.poll(); now[0] += 60
        event, = scheduler.poll()
        duplicate_stable = scheduler.poll()[0].event_id == event.event_id
        claim = scheduler.claim(event.event_id, "fake-worker")
        reservation = scheduler.prepare_send(event.event_id, claim.token)
        scheduler.finish(event.event_id, claim.token, "uncertain")
        restored = Scheduler(path, cfg, clock=lambda: now[0])
        print(json.dumps({"simulation": True, "event": asdict(event), "duplicate_event_id_stable": duplicate_stable, "reserved": bool(reservation), "restart_blocks_uncertain_send": restored.poll() == [], "model_calls": 0, "transport_calls": 0}, indent=2))


if __name__ == "__main__":
    main()
