"""Offline media review/catalog module. Importing it does not start any service."""
from .formats import MAX_BYTES, MediaInfo, inspect_bytes
from .safety import (IntegrityError, InvalidMedia, InvalidState, MediaError, StoreBusy,
                     UnknownMedia, UnsafePath)
from .store import MediaLibrary, MediaRecord, PreviewTarget, SendTarget

__all__ = ["MediaLibrary", "MediaRecord", "MediaInfo", "SendTarget", "PreviewTarget",
           "inspect_bytes", "MAX_BYTES", "MediaError", "UnsafePath", "InvalidMedia",
           "IntegrityError", "InvalidState", "UnknownMedia", "StoreBusy"]

from .legacy import (LegacyPlan, inspect_legacy, inspect_binding, stage_legacy_import, verify_staged_import, legacy_reference)

__all__ += ["LegacyPlan", "inspect_legacy", "inspect_binding", "stage_legacy_import", "verify_staged_import", "legacy_reference"]
