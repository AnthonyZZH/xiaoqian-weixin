"""Search and page-reading behaviour on synthetic pages.  No network.  Run by web-search.test.mjs."""
import datetime
import io
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'owner-tools'))
import web_reader as reader  # noqa: E402
import web_search as ws  # noqa: E402

NOW = datetime.datetime(2026, 11, 12, 0, 30, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
TODAY = NOW.date()


def bing_item(url, title, caption):
    return ('<li class="b_algo" data-id><div class="b_tpcn"><a class="tilk" href="%s"><div>icon</div></a></div>'
            '<h2><a target="_blank" href="%s" h="ID=SERP,1.2">%s</a></h2>'
            '<div class="b_caption"><p class="b_lineclamp2">%s</p></div></li>') % (url, url, title, caption)


def bing_page(*items):
    return '<html><body><ol id="b_results">' + ''.join(items) + '<li class="b_pag">next</li></ol></body></html>'


def sogou_item(href, title, text, shown, age):
    return ('<div class="vrwrap"><h3 class="vr-title"><a target="_blank" href="%s">%s</a></h3>'
            '<div class="fz-mid space-txt">%s</div>'
            '<a href="%s" class="citeLinkClass "><span>Site</span><span class="">%s</span><span class="cite-date">%s</span></a></div>'
            ) % (href, title, text, href, shown, age)


def sogou_page(*items):
    return '<html><body><div class="results">' + ''.join(items) + '</div></body></html>'


RELEASE = bing_item('https://news.example.com/a/1?utm_source=x', '<strong>Qwen4</strong> Max 预览版上线',
                    '16 小时之前&ensp;&#0183;&ensp;官方宣布 Qwen4 Max 预览版已接入 App')
OLD = bing_item('https://blog.example.org/qwen4', 'Qwen4 什么时候发布', '2026年8月26日&ensp;&#0183;&ensp;Qwen4 还没有发布')
WRAPPED = bing_item('https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1aHR0cHM6Ly9odWdnaW5nZmFjZS5jby9kb2NzL3F3ZW40&amp;ntb=1',
                    'Qwen4 docs', '<span class="news_dt">3 days ago</span>&nbsp;&#0183;&#32;Qwen4 model card and preview notes')
JUNK = bing_page(*[bing_item('https://zhidao.example.net/q/%d' % i, '磁盘清理怎么做 %d' % i, '2022年8月23日 · 清理 C 盘的办法') for i in range(6)])


def check(name, condition, detail=''):
    if not condition:
        raise AssertionError(name + (': ' + repr(detail) if detail != '' else ''))


def fake(pages, calls):
    def fetch(url, timeout):
        calls.append(url)
        for key, value in pages.items():
            if key in url:
                if isinstance(value, list):
                    return value.pop(0) if len(value) > 1 else value[0]
                if isinstance(value, Exception):
                    raise value
                return value
        return bing_page()
    return fetch


def test_parsers():
    rows = ws.parse_bing(bing_page(RELEASE, OLD, WRAPPED), NOW)
    check('bing count', len(rows) == 3, rows)
    check('bing relative date uses the clock', rows[0]['date'] == '2026-11-11', rows[0])
    check('bing caption without the date prefix', rows[0]['snippet'].startswith('官方宣布'), rows[0])
    check('bing absolute date', rows[1]['date'] == '2026-08-26', rows[1])
    check('bing wrapped target decoded', rows[2]['url'] == 'https://huggingface.co/docs/qwen4', rows[2])
    check('bing english age', rows[2]['date'] == '2026-11-09', rows[2])
    rows = ws.parse_sogou(sogou_page(
        sogou_item('/link?url=abc', '<em><!--red_beg-->千问<!--red_end--></em>4 发布', '11月11日，千问官方宣布', 'http://finance.example.com/a...', '1天前'),
        sogou_item('http://mp.weixin.qq.com/s?src=11&amp;signature=x', '公众号文章', '正文摘要', 'http://mp.weixin.qq.com/c...', '2026-11-05')), NOW)
    check('sogou count', len(rows) == 2, rows)
    check('sogou hop link is absolute', rows[0]['url'] == 'https://www.sogou.com/link?url=abc', rows[0])
    check('sogou site from the shown address', rows[0]['site'] == 'finance.example.com', rows[0])
    check('sogou title without highlight markup', rows[0]['title'] == '千问4 发布', rows[0])
    check('sogou dates', [r['date'] for r in rows] == ['2026-11-11', '2026-11-05'], rows)
    check('sogou direct link keeps its host', rows[1]['site'] == 'mp.weixin.qq.com', rows[1])
    check('verification page detected', ws.challenged('<link href="/anticaptcha/x.css">'))
    check('normal page is not a verification page', not ws.challenged(bing_page(RELEASE)))


def test_merge_and_dates():
    calls = []
    pages = {'ensearch=1': bing_page(WRAPPED, RELEASE), 'cn.bing.com/search?q=': bing_page(RELEASE, OLD),
             'sogou.com': sogou_page(sogou_item('/link?url=abc', 'Qwen4 Max 预览版上线', '11月11日，官方宣布预览版上线', 'http://news.example.com/a...', '1天前'))}
    out = ws.search(['Qwen4 Max 预览', 'Qwen4 preview release'], fetch=fake(pages, calls), now=NOW)
    check('two queries on both Bing indexes, Sogou once', sorted(u.split('?')[0] for u in calls) ==
          ['https://cn.bing.com/search'] * 4 + ['https://www.sogou.com/web'], calls)
    check('as_of carries the clock', out['as_of'] == '2026-11-12 00:30 +0800', out['as_of'])
    urls = [r['url'] for r in out['results']]
    check('same page from several engines is one result', len(urls) == len(set(urls)) == 3, urls)
    top = out['results'][0]
    check('page found by every engine ranks first', top['url'].startswith('https://news.example.com/a/1'), urls)
    check('engines recorded', set(top['engines']) == {'bing', 'bing_intl', 'sogou'}, top)
    check('queries recorded', top['matched_queries'] == [1, 2], top)
    check('newest date', out['newest_date'] == '2026-11-11', out)
    check('all engines ok', out['engines'] == {'bing': 'ok', 'bing_intl': 'ok', 'sogou': 'ok'}, out['engines'])
    stale = ws.search('Qwen4 发布', freshness='week', fetch=fake(pages, []), now=NOW)
    check('freshness drops dated old pages', all(r['date'] is None or r['date'] >= '2026-11-04' for r in stale['results']), stale['results'])
    check('freshness says what it dropped', any('较旧' in n for n in stale['notes']), stale['notes'])
    check('sogou asked with its own time filter', True)


def test_site_filter_is_enforced_here():
    calls = []
    pages = {'bing.com': bing_page(RELEASE, OLD)}
    out = ws.search('site:example.org Qwen4', fetch=fake(pages, calls), now=NOW)
    check('only the asked site survives', [r['site'] for r in out['results']] == ['blog.example.org'], out['results'])
    check('note about the ignored operator', any('site:' in n for n in out['notes']), out['notes'])
    check('sogou is not asked for site queries', not any('sogou' in u for u in calls), calls)
    none = ws.search('site:nowhere.example Qwen4', fetch=fake(pages, []), now=NOW)
    check('no off-site leftovers', none['results'] == [], none['results'])
    check('says to read the site directly', any('owner_fetch' in n for n in none['notes']), none['notes'])


def test_unrelated_pages():
    calls = []
    out = ws.search('红烧肉 做法 家常', skip=('sogou', 'bing_intl'), fetch=fake({'bing.com': JUNK}, calls), now=NOW)
    check('an unrelated page is asked for once more, then dropped', len(calls) == 2, calls)
    check('nothing unrelated is returned', out['results'] == [], out['results'])
    check('status says off topic', out['engines']['bing'] == 'off_topic', out['engines'])
    check('not finding is not proof of absence', any('不代表' in n for n in out['notes']), out['notes'])
    calls = []
    good = bing_page(bing_item('https://food.example.com/r', '红烧肉的家常做法', '2 天之前 · 家常红烧肉步骤'))
    out = ws.search('红烧肉 做法 家常', skip=('sogou', 'bing_intl'), fetch=fake({'bing.com': [JUNK, good]}, calls), now=NOW)
    check('second answer is used', [r['site'] for r in out['results']] == ['food.example.com'] and out['engines']['bing'] == 'ok', out)
    mixed = bing_page(RELEASE, bing_item('https://dict.example.com/qian', '千 - 汉典', '千的解释'), OLD)
    out = ws.search('Qwen4 预览版', skip=('sogou', 'bing_intl'), fetch=fake({'bing.com': mixed}, []), now=NOW)
    check('single unrelated result filtered', all('dict.example.com' not in r['url'] for r in out['results']) and len(out['results']) == 2, out['results'])
    check('filter is reported', any('无关' in n for n in out['notes']), out['notes'])


def test_challenge_and_cooldown():
    calls = []
    pages = {'sogou.com': '<html><link href="/anticaptcha/anti.css">verify</html>', 'bing.com': bing_page(RELEASE)}
    out = ws.search('Qwen4 Max 预览', fetch=fake(pages, calls), now=NOW)
    check('verification is never retried', sum('sogou' in u for u in calls) == 1, calls)
    check('status reported', out['engines']['sogou'] == 'challenge', out['engines'])
    check('other engines still answer', len(out['results']) == 1, out['results'])
    calls = []
    out = ws.search('Qwen4 Max 预览', skip=('sogou',), fetch=fake(pages, calls), now=NOW)
    check('cooling down engine is not contacted', not any('sogou' in u for u in calls) and out['engines']['sogou'] == 'cooldown', out['engines'])
    out = ws.search('Qwen4', fetch=fake({'bing.com': OSError('down'), 'sogou.com': OSError('down')}, []), now=NOW)
    check('network failure is a status, not an exception', set(out['engines'].values()) == {'network_failed'} and out['results'] == [], out)


def test_phrase_and_validation():
    out = ws.search('"Qwen9 Ultra" 发布', skip=('sogou', 'bing_intl'), fetch=fake({'bing.com': bing_page(RELEASE, OLD)}, []), now=NOW)
    check('missing exact phrase is said out loud', any('引号' in n for n in out['notes']), out['notes'])
    for bad in ([], [''], ['a'] * 5, 5, ['x' * 301]):
        try:
            ws.search(bad, fetch=fake({}, []), now=NOW)
        except ws.SearchError:
            continue
        raise AssertionError('accepted invalid queries: %r' % (bad,))
    for kwargs in ({'freshness': 'decade'}, {'count': 0}, {'count': 16}, {'count': True}):
        try:
            ws.search('q', fetch=fake({}, []), now=NOW, **kwargs)
        except ws.SearchError:
            continue
        raise AssertionError('accepted invalid option: %r' % (kwargs,))


ARTICLE = ('<html><head><title>发布公告 - 示例站</title><meta property="article:published_time" content="2026-11-11T09:00:00+08:00">'
           '</head><body><nav>首页 产品 关于</nav><aside>热门推荐 广告位</aside><article><h1>发布公告</h1>'
           + ''.join('<p>第%d段：这里是正文内容，讲的是别的事情，凑够长度用的句子。</p>' % i for i in range(1, 30))
           + '<p>重点：Qwen4 Max 预览版已经在 App 内上线。</p>'
           + ''.join('<p>后记%d：更多无关内容，同样只是为了凑长度而存在的句子。</p>' % i for i in range(1, 30))
           + '</article><footer>版权所有</footer></body></html>')
SHELL = ('<html><head><title>Qwen</title><meta name="description" content="千问官方站点"></head><body><div id="root"></div>'
         '<script id="__NEXT_DATA__" type="application/json">{"props":{"post":{"title":"Qwen4 Max 预览版发布说明",'
         '"body":"<p>Qwen4 Max 预览版今天在千问 App 内上线，面向全部用户开放体验，支持百万上下文与多模态理解，后续将开放 API。</p>",'
         '"more":"更多内容：本次更新同时带来了新的语音模式与更快的响应速度，详情见后续公告以及开发者文档中的说明，欢迎反馈。","icon":"/static/a.png"}}}</script>'
         '<script>' + 'var filler=1;' * 600 + '</script></body></html>')
EMPTY_SHELL = '<html><head><title>App</title></head><body><div id="app"></div><script>' + 'var filler=1;' * 600 + '</script></body></html>'


class FakeResponse:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, io.BytesIO(body)

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read(self, size):
        return self.body.read(size)


class FakeConnection:
    def __init__(self, response):
        self.response = response

    def request(self, *args, **kwargs):
        pass

    def getresponse(self):
        return self.response

    def close(self):
        pass


def site(routes, seen):
    def connector(clean, host, port, addresses, timeout):
        seen.append(clean)
        status, headers, body = routes[clean]
        return FakeConnection(FakeResponse(status, headers, body.encode('utf-8') if isinstance(body, str) else body))
    return connector


def resolver(host, port, type=None):
    literal = host if host.replace('.', '').isdigit() else '93.184.216.34'
    return [(None, None, None, None, (literal, port))]


HTML = {'Content-Type': 'text/html; charset=utf-8'}


def test_reader():
    text, title, published, shell, restricted = reader.read_html(ARTICLE, len(ARTICLE))
    check('main content only', '热门推荐' not in text and '首页 产品' not in text and '版权所有' not in text and '第1段' in text, text[:80])
    check('title and date', title == '发布公告 - 示例站' and published.startswith('2026-11-11'), (title, published))
    check('no blank lines', '\n\n' not in text)
    check('article is not a shell', shell is False and restricted is False)
    passages, hits = reader.focus_passages(text, 'Qwen4 Max 预览版 上线')
    check('focus returns the passage, not the page', hits >= 1 and '重点：Qwen4 Max 预览版已经在 App 内上线。' in passages and len(passages) < 600, (hits, len(passages)))
    check('focus keeps a neighbour each side', '第29段' in passages and '后记1：' in passages, passages)
    check('focus with no hit', reader.focus_passages(text, '火星基地 氦三') == (None, 0))
    text, title, published, shell, _ = reader.read_html(SHELL, len(SHELL.encode('utf-8')))
    check('shell detected', shell is True)
    check('embedded data is offered', 'Qwen4 Max 预览版今天在千问 App 内上线' in text and '千问官方站点' in text and '/static/a.png' not in text and '<p>' not in text, text)
    seen = []
    routes = {'https://www.sogou.com/link?url=abc': (200, HTML, '<meta content="always" name="referrer"><script>window.location.replace("https://news.example.com/a/1")</script>'),
              'https://news.example.com/a/1': (200, HTML, ARTICLE),
              'https://qwen.example.com/': (200, HTML, EMPTY_SHELL), 'https://qwen.example.com/blog': (200, HTML, SHELL),
              'https://old.example.com/': (200, {'Content-Type': 'text/html'}, ('<html><head><meta charset="gb2312"><title>旧站</title></head><body><p>' + '国标编码的正文内容。' * 40 + '</p></body></html>').encode('gb18030'))}
    page = reader.fetch_page('https://www.sogou.com/link?url=abc', resolver=resolver, connector=site(routes, seen))
    check('script forward is followed and validated as a hop', seen == ['https://www.sogou.com/link?url=abc', 'https://news.example.com/a/1'] and page['url'] == 'https://news.example.com/a/1' and page['redirects'] == 1, (seen, page['url']))
    check('page fields', page['status'] == 'ok' and page['published'].startswith('2026-11-11') and page['offset'] == 0 and page['truncated'] is False, {k: v for k, v in page.items() if k != 'text'})
    small = reader.fetch_page('https://news.example.com/a/1', resolver=resolver, connector=site(routes, []), limit=500)
    check('paging', small['truncated'] is True and small['next_offset'] == 500 and len(small['text']) == 500, small.get('next_offset'))
    rest = reader.fetch_page('https://news.example.com/a/1', resolver=resolver, connector=site(routes, []), offset=500)
    check('offset continues where the first part stopped', (small['text'] + rest['text']) == reader.read_html(ARTICLE, 1)[0])
    focused = reader.fetch_page('https://news.example.com/a/1', resolver=resolver, connector=site(routes, []), focus='预览版 上线')
    check('focus mode', focused['mode'] == 'focus' and focused['focus_hits'] >= 1 and len(focused['text']) < 600 and focused['characters'] > 1500, focused)
    missed = reader.fetch_page('https://news.example.com/a/1', resolver=resolver, connector=site(routes, []), focus='火星基地')
    check('focus miss falls back to the beginning and says so', missed['focus_hits'] == 0 and missed['text'].startswith('发布公告') and 'focus' in missed['note'], missed.get('note'))
    empty = reader.fetch_page('https://qwen.example.com/', resolver=resolver, connector=site(routes, []))
    check('empty shell is not presented as a page', empty['status'] == 'render_required' and empty['render_required'] is True and '读不到正文' in empty['note'], empty)
    partial = reader.fetch_page('https://qwen.example.com/blog', resolver=resolver, connector=site(routes, []))
    check('shell with data is marked partial', partial['status'] == 'ok' and partial['render_required'] is True and partial['source'] == 'embedded_data' and '不要把它当成全文' in partial['note'], partial)
    legacy = reader.fetch_page('https://old.example.com/', resolver=resolver, connector=site(routes, []))
    check('charset from the meta tag', '国标编码的正文内容' in legacy['text'] and legacy['title'] == '旧站', legacy['text'][:40])
    routes['https://mp.example.com/s?id=1'] = (302, {'Location': 'https://mp.example.com/mp/appmsgcaptcha?target=1'}, '')
    routes['https://mp.example.com/mp/appmsgcaptcha?target=1'] = (200, HTML, '<html><body><p>当前环境异常，完成验证后即可继续访问。</p><script>' + 'var filler=1;' * 600 + '</script></body></html>')
    wall = reader.fetch_page('https://mp.example.com/s?id=1', resolver=resolver, connector=site(routes, []))
    check('a verification wall stops the read and is named as one', wall['status'] == 'restricted' and wall['text'] == '' and wall['reason'] == 'CHALLENGE_OR_PAYWALL' and '摘要' in wall['note'], wall)
    for kwargs in ({'offset': -1}, {'offset': 10 ** 7}, {'limit': 10}, {'focus': 'x' * 201}):
        try:
            reader.fetch_page('https://news.example.com/a/1', resolver=resolver, connector=site(routes, []), **kwargs)
        except reader.PageError:
            continue
        raise AssertionError('accepted invalid option: %r' % (kwargs,))
    try:
        reader.fetch_page('https://hop.example.com/', resolver=resolver, connector=site({'https://hop.example.com/': (200, HTML, '<script>location.replace("http://127.0.0.1/admin")</script>')}, []))
    except reader.PageError as error:
        check('script forward cannot reach a private address', str(error) == 'ADDRESS_DENIED', str(error))
    else:
        raise AssertionError('followed a forward to a private address')


if __name__ == '__main__':
    tests = [test_parsers, test_merge_and_dates, test_site_filter_is_enforced_here, test_unrelated_pages,
             test_challenge_and_cooldown, test_phrase_and_validation, test_reader]
    for test in tests:
        test()
    print('ok %d' % len(tests))
