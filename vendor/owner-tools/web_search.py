"""Public web search for the owner: several queries x several engines in one call.

Why this shape (measured on the reference server, 2026-11-12):
- DuckDuckGo/Brave are unreachable there, Baidu/Yandex answer with a verification page.  What answers is
  Bing's domestic index, Bing's international index and Sogou (which also carries WeChat articles).
- Bing ignores `site:` and its freshness filter for cookieless requests and now and then returns a page of
  unrelated results.  So operators, freshness and relevance are enforced HERE, after parsing.
- A single engine with five bare titles gave the model nothing to judge by.  Every result now carries a
  snippet, a parsed date and the engines that returned it, and the answer says what was dropped and why.

No cookies, no paid API, no retry around a verification page.  The clock is a parameter so tests are fixed.
"""
import base64
import datetime
import html as html_lib
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = 'XiaoqianPublicSearch/1.0'
MAX_HTML = 1536 * 1024
MAX_QUERIES = 4
DEADLINE_SECONDS = 11.0
ENGINES = {
    'bing': 'https://cn.bing.com/search?q=',
    'bing_intl': 'https://cn.bing.com/search?ensearch=1&q=',
    'sogou': 'https://www.sogou.com/web?query=',
}
REDIRECT_HOSTS = ('cn.bing.com', 'www.bing.com', 'www.sogou.com')
SOGOU_FRESHNESS = {'day': '&tsn=1&sourceid=inttime_day', 'week': '&tsn=2&sourceid=inttime_week',
                   'month': '&tsn=3&sourceid=inttime_month', 'year': '&tsn=4&sourceid=inttime_year'}
FRESHNESS_DAYS = {'day': 2, 'week': 8, 'month': 32, 'year': 367}
CHALLENGE_MARKS = ('anomaly-modal', 'captcha', 'verify you are human', 'unusual traffic', 'antispider')
MONTHS = {name: index + 1 for index, name in enumerate(
    ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'))}
TRACKING = re.compile(r'^(utm_\w+|spm|from|source|ref|refer|scene|share_token|fbclid|gclid)$', re.I)


class SearchError(Exception):
    pass


# ---------------------------------------------------------------- text helpers
def plain(fragment, limit):
    text = re.sub(r'<!--.*?-->', '', fragment, flags=re.S)
    text = re.sub(r'<(script|style)\b.*?</\1>', ' ', text, flags=re.S | re.I)
    text = html_lib.unescape(re.sub(r'<[^>]+>', '', text))
    return re.sub(r'\s+', ' ', text).strip()[:limit]


def parse_date(text, today):
    """First date mentioned in a short label, as ISO text, or None.

    Relative ages count back from `today`; pass a datetime and '16 hours ago' lands on the right day.
    """
    if not text:
        return None
    low = text.lower()
    moment = today if isinstance(today, datetime.datetime) else None
    today = moment.date() if moment else today

    def back(amount, unit):
        if unit in ('分钟', 'minute', 'min'):
            return (moment - datetime.timedelta(minutes=amount)).date() if moment else today
        if unit in ('小时', 'hour'):
            return (moment - datetime.timedelta(hours=amount)).date() if moment else today
        return today - datetime.timedelta(days=amount * {'天': 1, '周': 7, '个月': 30, '年': 365, 'day': 1, 'week': 7, 'month': 30, 'year': 365}[unit])
    try:
        m = re.search(r'(\d+)\s*(分钟|小时|天|周|个月|年)\s*之?前', low)
        if m:
            return back(int(m.group(1)), m.group(2)).isoformat()
        m = re.search(r'(\d+)\s*(minute|min|hour|day|week|month|year)s?\s+ago', low)
        if m:
            return back(int(m.group(1)), m.group(2)).isoformat()
        for word, days in (('前天', 2), ('昨天', 1), ('yesterday', 1), ('今天', 0), ('刚刚', 0)):
            if word in low:
                return (today - datetime.timedelta(days=days)).isoformat()
        m = re.search(r'(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})', low)
        if m:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        m = re.search(r'\b([a-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(20\d{2})', low)
        if m and m.group(1) in MONTHS:
            return datetime.date(int(m.group(3)), MONTHS[m.group(1)], int(m.group(2))).isoformat()
        m = re.search(r'(?<!\d)(\d{1,2})月(\d{1,2})日', low)
        if m:
            day = datetime.date(today.year, int(m.group(1)), int(m.group(2)))
            if day > today + datetime.timedelta(days=1):
                day = day.replace(year=today.year - 1)
            return day.isoformat()
    except (ValueError, KeyError):
        return None
    return None


def split_dated_snippet(snippet, today):
    """Bing prefixes captions with '3 天之前 · ' or 'Nov 3, 2026 · '."""
    m = re.match(r'^(.{3,24}?)\s*·\s*(.+)$', snippet, flags=re.S)
    if m:
        date = parse_date(m.group(1), today)
        if date:
            return date, m.group(2).strip()
    return None, snippet


def public_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        return None
    return value[:2000]


def unwrap_bing(url):
    """International Bing wraps targets as /ck/a?...&u=a1<base64url>."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname in ('www.bing.com', 'cn.bing.com') and parsed.path.startswith('/ck/'):
        token = urllib.parse.parse_qs(parsed.query).get('u', [''])[0]
        if token.startswith('a1'):
            try:
                raw = token[2:] + '=' * (-len(token[2:]) % 4)
                return base64.urlsafe_b64decode(raw).decode('utf-8')
            except Exception:
                return None
        return None
    return url


def host_of(url):
    host = (urllib.parse.urlsplit(url).hostname or '').lower()
    return host[4:] if host.startswith('www.') else host


def url_key(url):
    parsed = urllib.parse.urlsplit(url)
    query = '&'.join(part for part in parsed.query.split('&') if part and not TRACKING.match(part.split('=')[0]))
    return host_of(url) + parsed.path.rstrip('/') + ('?' + query if query else '')


def title_key(title):
    head = re.split(r'\s[-_|–—]\s|_', title)[0]
    key = re.sub(r'[\W_]+', '', head.lower())
    return key if len(key) >= 8 else ''


# ---------------------------------------------------------------- parsers
def parse_bing(page, today):
    rows = []
    for block in page.split('<li class="b_algo"')[1:]:
        block = block.split('<li class="b_', 1)[0]
        m = re.search(r'<h2[^>]*>\s*<a[^>]*?href="([^"]+)"[^>]*>(.*?)</a>', block, flags=re.S)
        if not m:
            continue
        url = public_url(unwrap_bing(html_lib.unescape(m.group(1))) or '')
        title = plain(m.group(2), 200)
        if not url or not title:
            continue
        p = re.search(r'<p\b[^>]*>(.*?)</p>', block[m.end():], flags=re.S)
        date, snippet = split_dated_snippet(plain(p.group(1), 400) if p else '', today)
        rows.append({'title': title, 'url': url, 'site': host_of(url), 'date': date, 'snippet': snippet[:300]})
    return rows


def parse_sogou(page, today):
    rows = []
    for block in re.split(r'<div[^>]*class="[^"]*(?:\bvrwrap\b|\brb\b)[^"]*"', page)[1:]:
        m = re.search(r'<h3[^>]*>\s*<a[^>]*?href="([^"]+)"[^>]*>(.*?)</a>', block, flags=re.S) or \
            re.search(r'<a[^>]*?id="[^"]*title[^"]*"[^>]*?href="([^"]+)"[^>]*>(.*?)</a>', block, flags=re.S) or \
            re.search(r'<a[^>]*?href="([^"]+)"[^>]*?id="[^"]*title[^"]*"[^>]*>(.*?)</a>', block, flags=re.S)
        if not m:
            continue
        url = public_url(urllib.parse.urljoin('https://www.sogou.com/', html_lib.unescape(m.group(1))))
        title = plain(m.group(2), 200)
        if not url or not title:
            continue
        rest = block[m.end():]
        s = re.search(r'<(p|div)[^>]*class="[^"]*(?:star-wiki|space-txt|fz-mid|text-layout|str_info|str-text)[^"]*"[^>]*>(.*?)</\1>', rest, flags=re.S)
        snippet = plain(s.group(2), 300) if s else ''
        cite = re.search(r'class="citeLinkClass[^"]*"[^>]*>(.*?)</a>', rest, flags=re.S)
        site, date = '', None
        if cite:
            spans = [plain(x, 80) for x in re.findall(r'<span[^>]*>(.*?)</span>', cite.group(1), flags=re.S)]
            d = re.search(r'class="cite-date"[^>]*>(.*?)</span>', cite.group(1), flags=re.S)
            date = parse_date(plain(d.group(1), 40), today) if d else None
            shown = next((x for x in spans if re.match(r'https?://', x)), '')
            site = host_of(shown.rstrip('.')) if shown else (spans[0] if spans else '')
        if host_of(url) != 'sogou.com':
            site = host_of(url)
        rows.append({'title': title, 'url': url, 'site': site, 'date': date, 'snippet': snippet})
    return rows


PARSERS = {'bing': parse_bing, 'bing_intl': parse_bing, 'sogou': parse_sogou}


def challenged(page):
    low = page.lower()
    return any(mark in low for mark in CHALLENGE_MARKS)


# ---------------------------------------------------------------- query understanding
def analyse(query):
    """Split one query into what the engines get and what we verify ourselves."""
    sites = [s.lower().lstrip('.') for s in re.findall(r'(?<!\S)site:([\w.\-]+)', query, flags=re.I)]
    phrases = [p.strip() for p in re.findall(r'"([^"]{2,80})"', query) if p.strip()]
    bare = re.sub(r'(?<!\S)(?:site|inurl|intitle|filetype):\S+', ' ', query, flags=re.I)
    bare = re.sub(r'(?<!\S)-\S+', ' ', bare)
    bare = re.sub(r'\b(?:OR|AND)\b', ' ', bare).replace('"', ' ')
    units = []
    for word in re.findall(r'[a-z0-9][a-z0-9.+#\-]*', bare.lower()):
        word = word.strip('.-')
        if len(word) >= 2 and word not in units:
            units.append(word)
    for run in re.findall(r'[㐀-鿿]+', bare):
        if len(run) >= 2 and run not in units:
            units.append(run)
    return {'query': query, 'sites': sites, 'phrases': phrases, 'units': units}


def unit_hit(unit, haystack):
    if unit in haystack:
        return True
    if not re.match(r'[㐀-鿿]', unit) or len(unit) < 3:
        return False
    pairs = [unit[i:i + 2] for i in range(len(unit) - 1)]
    return sum(1 for pair in pairs if pair in haystack) * 2 >= len(pairs)


def coverage(row, meaning):
    """Share of the query's words that the title, snippet or address actually contains."""
    if not meaning['units']:
        return 1.0
    haystack = (row['title'] + ' ' + row['snippet'] + ' ' + urllib.parse.unquote(row['url'])).lower()
    return sum(1 for unit in meaning['units'] if unit_hit(unit, haystack)) / len(meaning['units'])


def on_site(row, sites):
    host = host_of(row['url'])
    return any(host == site or host.endswith('.' + site) for site in sites)


# ---------------------------------------------------------------- network
class _Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != 'https' or parsed.hostname not in REDIRECT_HOSTS:
            raise SearchError('SEARCH_REDIRECT_DENIED')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_fetch(url, timeout):
    opener = urllib.request.build_opener(_Redirects())
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'text/html',
                                                   'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'})
    with opener.open(request, timeout=timeout) as response:
        raw = response.read(MAX_HTML + 1)
    if len(raw) > MAX_HTML:
        raise SearchError('SEARCH_RESPONSE_TOO_LARGE')
    return raw.decode('utf-8', 'replace')


def engine_url(engine, query, freshness):
    url = ENGINES[engine] + urllib.parse.quote(query)
    if engine == 'sogou' and freshness in SOGOU_FRESHNESS:
        url += SOGOU_FRESHNESS[freshness]
    return url


def run_job(engine, meaning, freshness, fetch, moment, deadline):
    """One engine, one query.  Returns (status, rows).  A page of unrelated results is asked for once more."""
    status = 'no_results'
    for attempt in range(2):
        remaining = deadline - time.monotonic()
        if remaining <= 0.5:
            return 'timeout', []
        try:
            page = fetch(engine_url(engine, meaning['query'], freshness), min(6.0, remaining))
        except SearchError as error:
            return str(error).lower(), []
        except Exception:
            return 'network_failed', []
        if challenged(page):
            return 'challenge', []  # never retried, never routed around
        rows = PARSERS[engine](page, moment)
        if not rows:
            return 'no_results', []
        for row in rows:
            row['coverage'] = coverage(row, meaning)
        related = sum(1 for row in rows if row['coverage'] > 0)
        if related * 3 >= len(rows):
            return 'ok', rows
        status = 'off_topic'
        if engine == 'sogou':
            break  # one request per call to Sogou
    return status, []


# ---------------------------------------------------------------- merge
def merge(jobs, meanings, freshness, count, today):
    """jobs: [(engine, query_index, status, rows)] -> ranked results + what was dropped."""
    dropped = {'off_site': 0, 'stale': 0, 'unrelated': 0}
    limit = today - datetime.timedelta(days=FRESHNESS_DAYS[freshness]) if freshness in FRESHNESS_DAYS else None
    merged, by_title = {}, {}
    for engine, index, status, rows in jobs:
        meaning = meanings[index]
        rank = 0
        for row in rows:
            if meaning['sites'] and not on_site(row, meaning['sites']):
                dropped['off_site'] += 1
                continue
            if limit and row['date'] and row['date'] < limit.isoformat():
                dropped['stale'] += 1
                continue
            rank += 1
            weight = 1.0 / (10 + rank)
            key = url_key(row['url'])
            tkey = title_key(row['title'])
            if key not in merged and tkey and tkey in by_title:
                key = by_title[tkey]
            item = merged.get(key)
            if item is None:
                item = merged[key] = {**row, 'engines': [], 'queries': [], 'score': 0.0, 'phrase': False}
                if tkey:
                    by_title[tkey] = key
            else:
                if host_of(item['url']) == 'sogou.com' and host_of(row['url']) != 'sogou.com':
                    item['url'], item['site'] = row['url'], row['site']  # prefer the direct address
                if not item['date'] and row['date']:
                    item['date'] = row['date']
                if len(row['snippet']) > len(item['snippet']):
                    item['snippet'] = row['snippet']
                item['coverage'] = max(item['coverage'], row['coverage'])
            if engine not in item['engines']:
                item['engines'].append(engine)
            if index not in item['queries']:
                item['queries'].append(index)
            item['score'] += weight
            haystack = (row['title'] + ' ' + row['snippet']).lower()
            if meaning['phrases'] and any(p.lower() in haystack for p in meaning['phrases']):
                item['phrase'] = True
    ranked = []
    for item in merged.values():
        score = item['score'] * (0.4 + item['coverage'])
        if item['phrase']:
            score *= 1.5
        if item['date']:
            age = (today - datetime.date.fromisoformat(item['date'])).days
            score *= 1.25 if age <= 7 else 1.1 if age <= 31 else 1.0
        elif limit:
            score *= 0.6  # asked for recent pages; an undated one may be anything
        item['score'] = score
        ranked.append(item)
    ranked.sort(key=lambda item: -item['score'])
    related = [item for item in ranked if item['coverage'] > 0]
    dropped['unrelated'] = len(ranked) - len(related)
    return related[:count], dropped


def search(queries, freshness=None, count=8, skip=(), fetch=http_fetch, now=None):
    if isinstance(queries, str):
        queries = [queries]
    if not isinstance(queries, list) or not queries or len(queries) > MAX_QUERIES:
        raise SearchError('SEARCH_QUERY_INVALID')
    cleaned = []
    for query in queries:
        if not isinstance(query, str) or not query.strip() or len(query) > 300:
            raise SearchError('SEARCH_QUERY_INVALID')
        query = re.sub(r'\s+', ' ', query).strip()
        if query not in cleaned:
            cleaned.append(query)
    if freshness not in (None, '', 'any', 'day', 'week', 'month', 'year'):
        raise SearchError('SEARCH_FRESHNESS_INVALID')
    freshness = freshness if freshness in FRESHNESS_DAYS else None
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 15:
        raise SearchError('SEARCH_COUNT_INVALID')
    now = now or datetime.datetime.now().astimezone()
    today = now.date()
    meanings = [analyse(query) for query in cleaned]
    plan = []
    for index, meaning in enumerate(meanings):
        for engine in ('bing', 'bing_intl'):
            if engine not in skip:
                plan.append((engine, index))
    # Sogou tolerates few requests: one per call, for the first query it can serve (it cannot be site-filtered).
    sogou_index = next((i for i, meaning in enumerate(meanings) if not meaning['sites']), None)
    statuses = {}
    if 'sogou' in skip:
        statuses['sogou'] = 'cooldown'
    elif sogou_index is not None:
        plan.append(('sogou', sogou_index))
    deadline = time.monotonic() + DEADLINE_SECONDS
    gate = threading.Semaphore(4)

    def work(job):
        with gate:
            status, rows = run_job(job[0], meanings[job[1]], freshness, fetch, now, deadline)
        return job[0], job[1], status, rows

    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = list(pool.map(work, plan))
    order = ('ok', 'challenge', 'off_topic', 'no_results', 'timeout', 'network_failed')
    for engine, _index, status, _rows in jobs:
        known = statuses.get(engine)
        if known is None or (status in order and (known not in order or order.index(status) < order.index(known))):
            statuses[engine] = status
    results, dropped = merge(jobs, meanings, freshness, count, today)
    dates = sorted(item['date'] for item in results if item['date'])
    notes = []
    if any(meaning['sites'] for meaning in meanings) and dropped['off_site']:
        notes.append('搜索引擎没有遵守 site: 限定，已按站点过滤掉 %d 条站外结果%s。' % (
            dropped['off_site'], '' if results else '；该站点没有搜到相关页面，可以直接用 owner_fetch 读它的首页或栏目页'))
    if dropped['stale']:
        notes.append('按时间范围过滤掉 %d 条较旧的结果。' % dropped['stale'])
    if dropped['unrelated']:
        notes.append('过滤掉 %d 条与搜索词无关的结果。' % dropped['unrelated'])
    phrases = [p for meaning in meanings for p in meaning['phrases']]
    if phrases and results and not any(item['phrase'] for item in results):
        notes.append('没有任何结果的标题或摘要包含引号里的原词，下面是近似结果。')
    if any(status == 'off_topic' for status in statuses.values()):
        notes.append('有引擎返回了整页无关内容，已丢弃。')
    if statuses and all(status in ('challenge', 'cooldown') for status in statuses.values()):
        notes.append('搜索引擎要求人机验证，已停止；过一段时间再试。')
    elif not results:
        notes.append('没有搜到相关结果：这只说明这些搜索引擎没收录，不代表事情不存在。换关键词（中文/英文、官方名称/俗称）再搜一次，或直接读官方页面。')
    elif freshness is None and dates and (today - datetime.date.fromisoformat(dates[-1])).days > 30:
        notes.append('最新的一条结果也是 %s 的，如果问的是近况，这些结果可能已经过时。' % dates[-1])
    return {
        'as_of': now.strftime('%Y-%m-%d %H:%M %z'),
        'queries': cleaned,
        'results': [{'title': item['title'], 'url': item['url'], 'site': item['site'], 'date': item['date'],
                     'snippet': item['snippet'], 'engines': item['engines'],
                     **({'matched_queries': [i + 1 for i in sorted(item['queries'])]} if len(cleaned) > 1 else {})}
                    for item in results],
        'newest_date': dates[-1] if dates else None,
        'engines': statuses,
        'notes': notes,
        'trust': 'untrusted_web_content',
    }
