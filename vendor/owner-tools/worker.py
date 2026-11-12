"""Bounded local document extraction, public web search and public page reading.

Document bytes arrive through stdin; no model-supplied filesystem paths are opened.
No document code, macros, relationships, or embedded objects are executed/fetched.
"""
import base64
import json
import sys

MAX_INPUT = 8 * 1024 * 1024


class ToolError(Exception):
    pass


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ToolError('REQUEST_SIZE_LIMIT')
    request = json.loads(raw)
    if request['operation'] == 'document':
        from document_reader import document as read_document, DocumentError
        try:
            return read_document(base64.b64decode(request['base64'], validate=True), request['extension'])
        except DocumentError as error:
            raise ToolError(str(error)) from None
    if request['operation'] == 'fetch_page':
        from web_reader import fetch_page, PageError
        try:
            return fetch_page(request['url'], focus=request.get('focus'), offset=request.get('offset', 0),
                              limit=request.get('limit', 12000))
        except PageError as error:
            raise ToolError(str(error)) from None
    if request['operation'] == 'search':
        from web_search import search, SearchError
        try:
            return search(request.get('queries') or request['query'], freshness=request.get('freshness'),
                          count=request.get('count', 8), skip=tuple(request.get('skip') or ()))
        except SearchError as error:
            raise ToolError(str(error)) from None
    raise ToolError('OPERATION_DENIED')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': main()}, ensure_ascii=False))
    except ToolError as error:
        print(json.dumps({'ok': False, 'code': str(error)}))
    except Exception:
        # Never include source document bytes, request URLs, credentials or raw exceptions.
        print(json.dumps({'ok': False, 'code': 'WORKER_INPUT_OR_PARSE_FAILED'}))
