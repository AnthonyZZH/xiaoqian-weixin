"""Bind exact raw UIA objects to canonical complete messages from the same read."""
import json
from .protocol import digest, DriverError


def bind_current_read(state, chat, rows, receipt):
    if not isinstance(receipt, dict) or not receipt.get('readId') or type(receipt.get('generation')) is not int:
        raise DriverError('NATIVE_READ_RECEIPT_REQUIRED')
    with state.lock:
        saved = state.db.execute('SELECT items FROM snapshot_identity WHERE chat=?', (chat.key,)).fetchone()
        items = json.loads(saved[0]) if saved else []
        result = []
        for raw in rows:
            if raw.get('role') != 'user' or raw.get('text_complete') is not True:
                continue
            matches = [item for item in items if item.get('raw') == raw['key']]
            if len(matches) != 1:
                continue
            item = matches[0]
            mid = digest([chat.key, item['key']])
            known = state.db.execute('SELECT 1 FROM inbox WHERE chat_key=? AND message_id=?', (chat.key, mid)).fetchone()
            if known:
                result.append(dict(id=mid, sourceKey=raw['key'], role='user', text=raw['text'],
                                   nativeRef=raw.get('native_ref'), rawToken=item['token'],
                                   readId=receipt['readId'], generation=receipt['generation']))
        return result
