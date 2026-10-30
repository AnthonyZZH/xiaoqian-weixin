"""Explicit, non-destructive legacy sticker migration. Inspection reads metadata only."""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

from .formats import MAX_BYTES
from .safety import IntegrityError, InvalidState, UnsafePath, checked_path, child, plain_path, read_regular
from .store import MediaLibrary, _tags, _text

_EXTENSIONS = {'.png', '.apng', '.gif', '.webp', '.jpg', '.jpeg'}


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise IntegrityError('duplicate legacy index key')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique)
    except (ValueError, UnicodeError) as exc:
        raise IntegrityError('legacy index is not valid JSON') from exc


def legacy_reference(area, key):
    """Opaque stable reference: safe for receipts without disclosing old names."""
    return _hash(json.dumps([area, key], ensure_ascii=True).encode())


@dataclass(frozen=True)
class LegacyEntry:
    area: str
    key: str
    filename: str
    description: str
    tags: tuple[str, ...]
    status: str
    source_kind: str
    stat_signature: tuple[int, ...]

    @property
    def reference(self):
        return legacy_reference(self.area, self.key)


@dataclass(frozen=True)
class LegacyPlan:
    root: Path
    entries: tuple[LegacyEntry, ...]
    issues: tuple[tuple[str, str], ...]  # opaque reference, reason; never private text
    index_hashes: tuple[tuple[str, str], ...]
    library_rows: int
    inbox_rows: int
    digest: str

    def summary(self):
        return {'library_index_rows': self.library_rows, 'inbox_index_rows': self.inbox_rows,
                'available_entries': len(self.entries),
                'expected_kept': sum(e.status == 'kept' for e in self.entries),
                'expected_pending': sum(e.status == 'pending' for e in self.entries),
                'missing_files': sum(reason == 'missing_file' for _, reason in self.issues),
                'issue_counts': dict(Counter(reason for _, reason in self.issues)),
                'extensions': dict(Counter(Path(e.filename).suffix.lower() for e in self.entries)),
                'total_entry_bytes': sum(e.stat_signature[2] for e in self.entries),
                'metadata_only': True, 'digest': self.digest}


def inspect_legacy(stickers_root: str | Path) -> LegacyPlan:
    """No creation and no image reads. Source is the actual stickers directory, not DATA."""
    root = checked_path(plain_path(stickers_root))
    if not root.is_dir():
        raise UnsafePath('legacy stickers root must be an existing directory')
    entries, issues, hashes, counts = [], [], [], {}
    for area, folder in (('library', root), ('inbox', root / '_inbox')):
        if not folder.exists():
            if area == 'library':
                raise InvalidState('legacy library is missing')
            counts[area] = 0
            hashes.append((area, 'absent'))
            continue
        checked_path(folder)
        index = child(folder, 'index.json', missing=True)
        if not index.exists():
            if area == 'library':
                raise InvalidState('legacy index is missing; refusing to infer an empty library')
            rows = {}
            hashes.append((area, 'absent'))
        else:
            raw = read_regular(index, 8 * 1024 * 1024)
            hashes.append((area, _hash(raw)))
            rows = _json(raw)
            if (not isinstance(rows, dict) or isinstance(rows.get('schema_version'), int)
                    or isinstance(rows.get('items'), list)):
                raise InvalidState('expected legacy {id: {file, desc}} index, not another media schema')
            if len(rows) > 10000:
                raise InvalidState('legacy index exceeds migration capacity')
        counts[area] = len(rows)
        indexed_names = set()

        def add(key, row, filename, unindexed=False):
            ref = legacy_reference(area, key)
            try:
                if not isinstance(row, dict) or not isinstance(filename, str):
                    raise ValueError('invalid legacy row')
                candidate = child(folder, filename, missing=True)
                if candidate.suffix.lower() not in _EXTENSIONS:
                    raise ValueError('unsupported extension')
                description = row.get('desc', '')
                _text(description, 1000)  # preflight the runtime's metadata constraints
                tags = row.get('tags', [])
                _tags(tags)
                if not candidate.exists():
                    issues.append((ref, 'missing_file'))
                    return
                checked_path(candidate, file=True)
                info = candidate.stat()
                if not 0 < info.st_size <= MAX_BYTES:
                    raise ValueError('invalid size')
                entries.append(LegacyEntry(area, key, filename, description, tuple(tags),
                    'kept' if area == 'library' and not unindexed and description.strip() else 'pending',
                    'static_capture' if area == 'inbox' else 'original_file',
                    (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)))
            except (OSError, ValueError, UnsafePath):
                issues.append((ref, 'unsafe_or_invalid_entry'))

        for key, row in rows.items():
            filename = row.get('file') if isinstance(row, dict) and area == 'library' else str(key) + '.png'
            if isinstance(filename, str):
                indexed_names.add(filename)
            add(key, row, filename)
        # Never auto-approve previously unindexed files, including orphaned inbox crops.
        for candidate in sorted(folder.iterdir()):
            if candidate.suffix.lower() in _EXTENSIONS and candidate.name not in indexed_names:
                add('@unindexed:' + candidate.name, {}, candidate.name, unindexed=True)
    if len(entries) > 10000:
        raise InvalidState('legacy migration exceeds catalog capacity')
    body = {'root': str(root), 'entries': [asdict(e) for e in entries], 'issues': issues, 'indexes': hashes}
    digest = _hash(json.dumps(body, ensure_ascii=True, sort_keys=True).encode())
    return LegacyPlan(root, tuple(entries), tuple(issues), tuple(hashes), counts['library'], counts['inbox'], digest)


def inspect_binding(root: str | Path, collection: str) -> dict:
    """Diagnose configured media paths without creating an empty replacement library."""
    from .safety import collection_id
    root, collection = plain_path(root), collection_id(collection)
    result = {'collection_id': collection,
              'repeated_features_component': sum(p.casefold() == 'features' for p in root.parts) > 1}
    if not root.exists():
        return dict(result, status='missing_root', record_count=0)
    checked_path(root)
    if child(root, 'index.json', missing=True).exists():
        return dict(result, status='direct_index_requires_schema_or_root_adapter', record_count=None)
    folder = child(root, collection, missing=True)
    if not folder.exists() or not child(folder, 'index.json', missing=True).exists():
        return dict(result, status='missing_collection_index', record_count=0)
    library = MediaLibrary(root, collection, require_existing=True)
    with library._operation():
        rows = library._load()
    kept = sum(r.status == 'kept' for r in rows.values())
    return dict(result, status='ready' if kept else 'no_approved_media', record_count=len(rows), kept_count=kept)


def stage_legacy_import(plan: LegacyPlan, target_root: str | Path, *, collection: str,
                        allow_missing: bool = False) -> dict:
    """Write only a NEW, disjoint staging root. Never attach/switch/update a runtime root.

    Do not call on real media until the integration owner chooses an isolated destination.
    Failed stages remain marked failed and cannot be overwritten by a retry.
    """
    from .safety import collection_id
    collection_id(collection)
    target = plain_path(target_root)
    checked_path(target, missing=True)
    if target.exists():
        raise InvalidState('migration target must not exist; existing/live libraries are never overwritten')
    if target.is_relative_to(plan.root) or plan.root.is_relative_to(target):
        raise UnsafePath('migration destination and source must be disjoint')
    current = inspect_legacy(plan.root)
    if current.digest != plan.digest:
        raise IntegrityError('legacy metadata changed since inspection; re-plan before import')
    plan = current  # never trust caller-modified dataclass fields paired with an old digest
    if not plan.entries:
        raise InvalidState('no available legacy media; empty catalog is not a migration success')
    if any(reason != 'missing_file' or not allow_missing for _, reason in plan.issues):
        raise InvalidState('legacy plan has unresolved issues; only explicitly acknowledged missing files may be skipped')
    target.mkdir(parents=True, exist_ok=False)
    library = MediaLibrary(target, collection, max_pending=max(300, len(plan.entries)))
    receipt = {'version': 1, 'status': 'building', 'collection_id': collection,
               'plan_digest': plan.digest, 'source_indexes': dict(plan.index_hashes),
               'summary': plan.summary(), 'mappings': []}

    def save():
        library._atomic_write(library.root, 'legacy-migration.json',
                              json.dumps(receipt, ensure_ascii=True, indent=2).encode())

    save()
    try:
        for entry in plan.entries:
            folder = plan.root if entry.area == 'library' else child(plan.root, '_inbox')
            source = child(folder, entry.filename, file=True)
            info = source.stat()
            if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != entry.stat_signature:
                raise IntegrityError('legacy file metadata changed during migration')
            data = read_regular(source, MAX_BYTES)
            row = library.import_bytes(data, description=entry.description, tags=entry.tags,
                source_kind=entry.source_kind, source_label='legacy-' + entry.area, deduplicate=False)
            if entry.status == 'kept':
                row = library.keep(row.media_id)
            if row.sha256 != _hash(data) or library._payload(row)[1] != data:
                raise IntegrityError('legacy bytes were not preserved')
            receipt['mappings'].append({'legacy_reference': entry.reference, 'media_id': row.media_id,
                'status': row.status, 'sha256': row.sha256, 'original_description': entry.description,
                'original_tags': list(entry.tags)})
        receipt['status'] = 'complete'
        receipt['verified_kept'] = sum(r['status'] == 'kept' for r in receipt['mappings'])
        receipt['verified_pending'] = sum(r['status'] == 'pending' for r in receipt['mappings'])
        receipt['source_complete'] = not plan.issues
        save()
        verify_staged_import(target)
        # Return only non-private counts; detailed mappings remain in the stage receipt.
        return {key: receipt[key] for key in ('status', 'collection_id', 'summary', 'verified_kept',
                                              'verified_pending', 'source_complete')}
    except BaseException:
        receipt['status'] = 'failed'
        save()
        raise


def verify_staged_import(root: str | Path) -> dict:
    """Verify every copied original against the receipt before an external bind/switch."""
    root = checked_path(plain_path(root))
    receipt = _json(read_regular(child(root, 'legacy-migration.json', file=True), 16 * 1024 * 1024))
    if receipt.get('status') != 'complete' or not receipt.get('mappings'):
        raise InvalidState('migration is absent, failed, incomplete, or empty')
    library = MediaLibrary(root, receipt['collection_id'], require_existing=True)
    with library._operation():
        rows = library._load()
        if len(rows) != len(receipt['mappings']) or len(rows) != receipt['summary']['available_entries']:
            raise IntegrityError('migrated item counts disagree')
        mapped = set()
        for mapping in receipt['mappings']:
            key = mapping['media_id']
            if key in mapped or key not in rows:
                raise IntegrityError('duplicate or missing migrated ID')
            mapped.add(key)
            row = rows[key]
            if (row.status != mapping['status'] or row.sha256 != mapping['sha256']
                    or row.description != _text(mapping['original_description'], 1000)
                    or row.tags != _tags(mapping['original_tags'])):
                raise IntegrityError('migrated review state or labels disagree')
            library._payload(row)
        kept = sum(row.status == 'kept' for row in rows.values())
        pending = sum(row.status == 'pending' for row in rows.values())
        if kept != receipt['summary']['expected_kept'] or pending != receipt['summary']['expected_pending']:
            raise IntegrityError('migrated review counts disagree')
    return {'status': 'verified', 'kept': kept, 'pending': pending,
            'source_complete': receipt['source_complete'], 'missing_files': receipt['summary']['missing_files']}
