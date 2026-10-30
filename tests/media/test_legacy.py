"""Targeted migration tests; fixtures only, no live catalogs or paid APIs."""
import hashlib
import json
from pathlib import Path
from unittest.mock import patch
import unittest

from test_media import LibraryFixture, gif, png, WEBP
from xiaoqian_media import (MediaLibrary, InvalidState, IntegrityError, UnsafePath,
    inspect_legacy, inspect_binding, stage_legacy_import, verify_staged_import)
from xiaoqian_media.safety import read_regular


class LegacyMigrationTests(LibraryFixture):
    def legacy(self, missing=False):
        root = self.base / 'legacy-stickers'
        root.mkdir()
        (root / '_inbox').mkdir()
        (root / 'a.gif').write_bytes(gif())
        (root / 'b.webp').write_bytes(WEBP)
        (root / 'c.png').write_bytes(png(True))
        (root / '_inbox' / '123.png').write_bytes(png())
        rows = {'a': {'file': 'a.gif', 'desc': ' happy   hello ', 'tags': ['friendly']},
                'alias': {'file': 'a.gif', 'desc': 'other wording', 'tags': ['wave']},
                'b': {'file': 'b.webp', 'desc': 'blue red'},
                'c': {'file': 'c.png', 'desc': 'apng original'}}
        if missing:
            rows['gone'] = {'file': 'gone.gif', 'desc': 'missing original'}
        (root / 'index.json').write_text(json.dumps(rows), encoding='utf-8')
        (root / '_inbox' / 'index.json').write_text(json.dumps({'123': {'desc': 'pending crop',
            'chat': 'private synthetic context', 'sender': 'synthetic person', 'hash': '1'}}), encoding='utf-8')
        return root

    def test_inspection_reads_metadata_only_and_preserves_state(self):
        root = self.legacy(missing=True)
        def metadata_only(path, limit):
            self.assertEqual('.json', path.suffix)
            return read_regular(path, limit)
        with patch('xiaoqian_media.legacy.read_regular', side_effect=metadata_only):
            plan = inspect_legacy(root)
        summary = plan.summary()
        self.assertEqual((5, 4, 1, 1), (summary['available_entries'], summary['expected_kept'],
                         summary['expected_pending'], summary['missing_files']))
        self.assertNotIn('private synthetic', json.dumps(summary))
        self.assertFalse((root / 'default').exists())

    def test_staging_preserves_all_animation_bytes_labels_aliases_and_review(self):
        root = self.legacy()
        before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}
        plan = inspect_legacy(root); stage = self.base / 'new-stage'
        result = stage_legacy_import(plan, stage, collection='c_synthetic')
        self.assertEqual((4, 1), (result['verified_kept'], result['verified_pending']))
        lib = MediaLibrary(stage, 'c_synthetic', require_existing=True)
        rows = lib.catalog(limit=100)
        self.assertEqual(4, len(rows))
        duplicates = [r for r in rows if r.sha256 == hashlib.sha256(gif()).hexdigest()]
        self.assertEqual(2, len(duplicates))
        self.assertEqual({'happy hello', 'other wording'}, {r.description for r in duplicates})
        self.assertEqual({('friendly',), ('wave',)}, {r.tags for r in duplicates})
        for row in rows:
            original = {'gif': gif(), 'webp': WEBP, 'apng': png(True)}[row.info.format]
            self.assertEqual(original, lib.read_for_send(row.media_id)[1])
        pending = lib.pending()[0]
        self.assertEqual('static_capture', pending.source_kind)
        with self.assertRaises(InvalidState): lib.resolve_send_target(pending.media_id)
        receipt = json.loads((stage / 'legacy-migration.json').read_text())
        self.assertIn(' happy   hello ', [m['original_description'] for m in receipt['mappings']])
        self.assertNotIn('private synthetic context', json.dumps(receipt))
        self.assertEqual('verified', verify_staged_import(stage)['status'])
        self.assertEqual(before, {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()})

    def test_missing_files_are_explicit_not_success_as_empty(self):
        plan = inspect_legacy(self.legacy(missing=True)); stage = self.base / 'new-stage'
        with self.assertRaises(InvalidState): stage_legacy_import(plan, stage, collection='c_test')
        self.assertFalse(stage.exists())
        result = stage_legacy_import(plan, stage, collection='c_test', allow_missing=True)
        self.assertFalse(result['source_complete']); self.assertEqual(1, result['summary']['missing_files'])
        self.assertEqual(4, verify_staged_import(stage)['kept'])

    def test_existing_target_and_source_overlap_are_never_overwritten(self):
        root = self.legacy(); plan = inspect_legacy(root)
        for target in (root, self.base, self.base/'store'):
            with self.assertRaises(InvalidState): stage_legacy_import(plan, target, collection='c_test')
        with self.assertRaises(UnsafePath): stage_legacy_import(plan, root/'nested', collection='c_test')
        self.assertFalse((root/'nested').exists())

    def test_metadata_changed_after_plan_refuses_stage(self):
        root = self.legacy(); plan = inspect_legacy(root)
        (root/'index.json').write_text('{}', encoding='utf-8')
        stage = self.base/'changed-stage'
        with self.assertRaises(IntegrityError): stage_legacy_import(plan, stage, collection='c_test')
        self.assertFalse(stage.exists())

    def test_bad_source_does_not_publish_a_successful_receipt(self):
        root = self.legacy(); (root/'b.webp').write_bytes(b'not a valid image')
        stage = self.base/'failed-stage'
        with self.assertRaises(Exception): stage_legacy_import(inspect_legacy(root), stage, collection='c_test')
        self.assertEqual('failed', json.loads((stage/'legacy-migration.json').read_text())['status'])
        with self.assertRaises(InvalidState): verify_staged_import(stage)
        with self.assertRaises(InvalidState): stage_legacy_import(inspect_legacy(root), stage, collection='c_test')

    def test_path_injection_refused_even_with_allow_missing(self):
        root = self.legacy(); index=root/'index.json'; rows=json.loads(index.read_text())
        rows['escape']={'file':'../outside.gif','desc':'unsafe'}
        index.write_text(json.dumps(rows))
        plan=inspect_legacy(root)
        self.assertEqual(1, plan.summary()['issue_counts']['unsafe_or_invalid_entry'])
        with self.assertRaises(InvalidState): stage_legacy_import(plan,self.base/'no-stage',collection='c_test',allow_missing=True)

    def test_unindexed_files_and_empty_descriptions_remain_pending(self):
        root=self.legacy(); (root/'orphan.gif').write_bytes(gif(1))
        rows=json.loads((root/'index.json').read_text()); rows['c']['desc']=''
        (root/'index.json').write_text(json.dumps(rows))
        summary=inspect_legacy(root).summary()
        self.assertEqual(3,summary['expected_kept']); self.assertEqual(3,summary['expected_pending'])

    def test_empty_plan_and_empty_binding_cannot_claim_recovery(self):
        root=self.base/'empty-legacy'; root.mkdir(); (root/'index.json').write_text('{}')
        with self.assertRaises(InvalidState): stage_legacy_import(inspect_legacy(root),self.base/'empty-stage',collection='c_test')
        missing=self.base/'missing-runtime'
        self.assertEqual('missing_root',inspect_binding(missing,'c_test')['status'])
        with self.assertRaises(InvalidState): MediaLibrary(missing,'c_test',require_existing=True)
        self.assertFalse(missing.exists())

    def test_legacy_root_and_double_features_diagnosed_without_mkdir(self):
        root=self.legacy()
        with self.assertRaises(InvalidState): MediaLibrary(root,'default')
        self.assertFalse((root/'default').exists())
        self.assertEqual('direct_index_requires_schema_or_root_adapter',inspect_binding(root,'default')['status'])
        wrong=self.base/'features'/'features'/'media'
        self.assertTrue(inspect_binding(wrong,'c_test')['repeated_features_component'])
        self.assertFalse(wrong.exists())

    def test_modified_plan_cannot_promote_inbox_to_kept(self):
        from dataclasses import replace
        plan=inspect_legacy(self.legacy())
        forged=replace(plan,entries=tuple(replace(e,status='kept') for e in plan.entries))
        result=stage_legacy_import(forged,self.base/'stage',collection='c_test')
        self.assertEqual(1,result['verified_pending'])
        self.assertEqual(4,result['verified_kept'])

    def test_legacy_sticker_named_records_is_not_misclassified(self):
        root=self.legacy(); index=root/'index.json'; rows=json.loads(index.read_text())
        rows['records']=rows.pop('a'); index.write_text(json.dumps(rows))
        self.assertEqual(5,len(inspect_legacy(root).entries))

    def test_verification_detects_lost_labels_state_or_bytes(self):
        stage=self.base/'stage'; stage_legacy_import(inspect_legacy(self.legacy()),stage,collection='c_test')
        lib=MediaLibrary(stage,'c_test',require_existing=True); row=lib.catalog()[0]
        lib.set_description(row.media_id,'changed label')
        with self.assertRaises(IntegrityError): verify_staged_import(stage)


if __name__ == '__main__': unittest.main(verbosity=2)
