"""Bind the foreground Explorer selection to this account's file root."""
import ntpath
import re
from .saved_file_identity import relative_parts,require


def normalize_location(value, root, display_name):
    require(isinstance(root,str) and re.match(r'^[A-Za-z]:[\\/]',root), 'SAVED_FILE_PINNED_ROOT_REQUIRED')
    root=root.replace('/','\\').rstrip('\\')
    require(isinstance(value,str) and re.match(r'^[A-Za-z]:[\\/]',value), 'NATIVE_FILE_LOCATION_INVALID')
    value=value.replace('/','\\')
    # Shell.Item.Path supplies a filesystem path, never a URL or UI label.
    relative_parts(value[3:])
    try:relative=ntpath.relpath(value,root)
    except ValueError:raise ValueError('SAVED_FILE_ACCOUNT_OR_ROOT_MISMATCH') from None
    relative_parts(relative)
    require(ntpath.basename(value).casefold()==display_name.casefold(), 'NATIVE_FILE_NAME_MISMATCH')
    return relative
