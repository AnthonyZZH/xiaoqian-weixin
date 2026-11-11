"""Offline synthetic scheduling checks; no model, UI or production state."""
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'vendor'))
import owner_wake_policy as policy


def stamp(iso):
    return datetime.fromisoformat(iso).timestamp()


def settings(**overrides):
    return dict(owner='synthetic-owner', chats={
        'synthetic-owner': {'mode': 'private'}, 'synthetic-group': {'mode': 'group'}}, **overrides)


class Endpoint:
    def __init__(self, index=0): self.index = index
    def uniform(self, lo, hi): return (lo, hi)[self.index]


def bounds(iso):
    now = stamp(iso)
    return [policy.Scheduler._schedule(SimpleNamespace(rng=Endpoint(i)), SimpleNamespace(owner=True), now) - now for i in (0, 1)]


class WakePricingTests(unittest.TestCase):
    def test_cadences_and_config_use_card(self):
        self.assertEqual(bounds('2026-11-09T09:00:00+08:00'), [3600, 7200])
        self.assertEqual(bounds('2026-11-09T12:00:00+08:00'), [900, 1800])
        cfg = policy.ScheduleConfig.from_legacy(settings())
        self.assertEqual(cfg.owner_peak_seconds, (3600, 7200))
        self.assertEqual(cfg.owner_offpeak_seconds, (900, 1800))
        self.assertFalse(cfg.chats[1].enabled)

    def test_flat_day_night_boundaries_and_unknown_year(self):
        with patch.dict(policy.POLICY, time_based_pricing=False):
            for clock, expected in [('00:59:59', [1800, 3600]), ('01:00:00', [7200, 14400]),
                                    ('07:59:59', [7200, 14400]), ('08:00:00', [1800, 3600]),
                                    ('23:59:59', [1800, 3600]), ('00:00:00', [1800, 3600])]:
                with self.subTest(clock=clock):
                    self.assertEqual(bounds('2027-01-01T' + clock + '+08:00'), expected)

    def test_custom_cross_midnight_window(self):
        with patch.dict(policy.POLICY, peak_intervals_local=[['22:00', '02:00']], peak_weekdays=list(range(1, 8)), exclude_cn_statutory_holidays=False):
            for iso, band in [('2026-11-09T21:59:59+08:00', 'offpeak'), ('2026-11-09T22:00:00+08:00', 'peak'),
                              ('2026-11-09T23:59:59+08:00', 'peak'), ('2026-11-10T00:00:00+08:00', 'peak'),
                              ('2026-11-10T01:59:59+08:00', 'peak'), ('2026-11-10T02:00:00+08:00', 'offpeak')]:
                self.assertEqual(policy.price_band(stamp(iso)), band)

    def test_real_scheduler_rebases_at_tariff_boundary(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as root:
            now = [stamp('2026-11-09T08:59:59+08:00')]
            scheduler = policy.Scheduler(Path(root) / 'synthetic.sqlite3', policy.ScheduleConfig.from_legacy(settings()), clock=lambda: now[0], rng=Endpoint())
            self.assertEqual(scheduler.snapshot()['owner_wake_state'][0]['next_due'], now[0] + 900)
            now[0] += 1
            self.assertEqual(scheduler.poll(), [])
            self.assertEqual(scheduler.snapshot()['owner_wake_state'][0]['next_due'], now[0] + 3600)
            now[0] += 3600
            event, = scheduler.poll()
            claim = scheduler.claim(event.event_id, 'synthetic-worker')
            self.assertIsNotNone(claim)
            self.assertTrue(scheduler.finish(event.event_id, claim.token, 'declined'))
            self.assertEqual(scheduler.snapshot()['owner_wake_state'][0]['next_due'], now[0] + 3600)
            now[0] = stamp('2026-11-09T12:00:00+08:00')
            scheduler.poll()
            self.assertEqual(scheduler.snapshot()['owner_wake_state'][0]['next_due'], now[0] + 900)

    def test_master_disable_and_mute_still_win(self):
        for options in [settings(initiative_enabled=False), settings()]:
            if 'initiative_enabled' not in options: options['chats']['synthetic-owner']['muted'] = True
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as root:
                now = [stamp('2026-11-09T12:00:00+08:00')]
                scheduler = policy.Scheduler(Path(root) / 'synthetic.sqlite3', policy.ScheduleConfig.from_legacy(options), clock=lambda: now[0], rng=Endpoint())
                now[0] += 1800
                self.assertEqual(scheduler.poll(), [])

    def test_rpc_shim_and_staging_use_only_sibling_app(self):
        shim = APP.parent / 'rpc/vendor/owner_wake_policy.py'
        spec = importlib.util.spec_from_file_location('synthetic_rpc_policy', shim)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(Path(module.__file__), APP / 'vendor/owner_wake_policy.py')
        self.assertEqual(module.PRICE_CARD, policy.PRICE_CARD)
        spec = importlib.util.spec_from_file_location('synthetic_stage_rpc', APP / 'tools/stage-rpc.py')
        staging = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(staging)
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as root:
            root = Path(root)
            vendor = root / 'app/vendor'
            shutil.copytree(APP / 'vendor', vendor, ignore=shutil.ignore_patterns('__pycache__'))
            result = staging.stage(APP, vendor, root / 'rpc')
            self.assertFalse((root / 'rpc/vendor/calendar-2026.json').exists())
            self.assertFalse((root / 'rpc/vendor/xiaoqian_schedule/price-card.json').exists())
            self.assertEqual((root / 'rpc/vendor/owner_wake_policy.py').read_bytes(), shim.read_bytes())
            self.assertTrue(staging.smoke(root / 'rpc', sys.executable)['passed'])
            self.assertIn('vendor/owner_wake_policy.py', result['files'])
            self.assertIn('vendor/owner-tools/pdf-deps.zip', result['staticResources'])
            self.assertEqual((root / 'rpc/vendor/owner-tools/pdf-deps.zip').read_bytes(),
                             (APP / 'vendor/owner-tools/pdf-deps.zip').read_bytes())


if __name__ == '__main__':
    if '--bands' in sys.argv:
        print(json.dumps([{'band': policy.price_band(stamp(iso)), 'bounds': bounds(iso)} for iso in json.load(sys.stdin)]))
    else:
        unittest.main()
