// 画面のテスト（架空の値だけを使う）。実行： node tests/screen.test.js
// 手元にサーバーを立て、にせの API（架空のデータ）につないだ画面を Chrome で開いて、描けているかを確かめる。
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.log('Chrome が見つからないので、テストを飛ばしました。'); process.exit(0); }

/* ---------- 架空のデータ ---------- */
const NAMES = { p1: 'たろう', p2: 'はなこ' };
const entry = (id, date, payer, amount, category, content, burden, share1) => ({
  row: 2, id, date, payer, amount, category, content, burden, means: '現金', memo: '', created: date + 'T03:00:00.000Z', month: date.slice(0, 7).replace('-', '/'), share1, share2: amount - share1
});
const ENTRIES = [
  entry('e1', '2026-01-09', 'たろう', 4321, '食費', 'テスト商店', '折半', 2161),
  entry('e2', '2026-01-08', 'はなこ', 1500, '日用品', 'テスト薬局', '6:4', 900),
  entry('e3', '2026-01-05', 'たろう', 70000, '住居費', 'テスト家賃', '折半', 35000)
];
const monthData = (month, entries) => {
  const paid1 = entries.filter(e => e.payer === NAMES.p1).reduce((a, e) => a + e.amount, 0);
  const total = entries.reduce((a, e) => a + e.amount, 0), share1 = entries.reduce((a, e) => a + e.share1, 0);
  return { month, paid1, paid2: total - paid1, total, share1, share2: total - share1, due: paid1 - share1, settled: 0, remaining: paid1 - share1, categories: [], entries, settlements: [] };
};
const overview = month => {
  const data = monthData(month, month === '2026/01' ? ENTRIES : []);
  return {
    month, data, prev: monthData('2025/12', []), feed: ENTRIES.slice(0, 2),
    trend: ['2025/08', '2025/09', '2025/10', '2025/11', '2025/12', '2026/01'].map(m => ({ month: m, total: m === '2026/01' ? data.total : 0, fixed: m === '2026/01' ? 70000 : 0, variable: 0 })),
    months: [{ month: '2026/01', due: data.due, settled: 0, remaining: data.remaining, total: data.total }],
    budgets: { '食費': 40000 },
    recurring: [{ id: 'r2', name: 'テスト家賃', payer: 'たろう', amount: 70000, category: '住居費', burden: '折半', means: '現金', day: 27, on: true, note: '' }]
  };
};
const init = me => Object.assign(overview('2026/01'), {
  names: NAMES, means: ['現金', 'カード'], today: '2026-01-10', now: '2026-01-10T03:00:00.000Z', me, email: 'test@example.com',
  categories: [{ name: '食費', g: '食', fixed: false }, { name: '日用品', g: '日', fixed: false }, { name: '住居費', g: '住', fixed: true }]
});

/* ---------- にせの API と、画面を配るサーバー ---------- */
let posts = [];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const q = JSON.parse(body); posts.push(q);
      let out;
      if (q.session === 'bad') out = { ok: false, error: { code: 'FORBIDDEN', message: 'このアカウントでは使えません。' } };
      else if (!q.session) out = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'ログインしてください。' } };
      else if (q.action === 'app.init') out = { ok: true, data: init(q.session === 'p2' ? 'はなこ' : q.session === 'noname' ? '' : 'たろう') };
      else if (q.action === 'month.get') out = { ok: true, data: overview(q.payload.month) };
      else out = { ok: true, data: overview('2026/01') };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
    return;
  }
  // テスト用の入口：ログイン済みの状態を作ってから画面へ移る
  if (url.pathname === '/start') {
    const s = url.searchParams.get('session'), run = url.searchParams.get('run') || '', hash = url.searchParams.get('hash') || '';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<script>localStorage.clear();${s ? `localStorage.setItem('kkSession', ${JSON.stringify(s)});` : ''}location.replace('/index.html?run=' + ${JSON.stringify(encodeURIComponent(run))} + ${JSON.stringify(hash)});</script>`);
    return;
  }
  if (url.pathname === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(`window.APP_CONFIG = { OAUTH_CLIENT_ID: 'test', API_URL: '/api' };`); return; }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  let buf = fs.readFileSync(file);
  if (url.pathname === '/index.html') {
    // エラーを拾い、読み込みが済んだら ?run= の操作（押す場所を , 区切りで）を順に行う
    const hook = `<script>window.onerror = m => { document.documentElement.setAttribute('data-err', m); };
      window.addEventListener('unhandledrejection', e => document.documentElement.setAttribute('data-err', String(e.reason && e.reason.message || e.reason)));
      const steps = (new URLSearchParams(location.search).get('run') || '').split(',').filter(Boolean);
      const tick = setInterval(() => { if (!document.getElementById('boot').hidden) return; clearInterval(tick);
        steps.forEach((sel, i) => setTimeout(() => { const el = document.querySelector(sel); if (el) el.click(); else document.documentElement.setAttribute('data-err', '見つからない：' + sel); }, 100 * (i + 1))); }, 50);</script>`;
    buf = Buffer.from(buf.toString('utf8').replace('<script src="config.js">', hook + '<script src="config.js">'));
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(buf);
});

const text = html => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const part = (html, id) => { const i = html.indexOf(`id="${id}"`); return i < 0 ? '' : text(html.slice(i, i + 6000)); };
function open(port, query) {
  posts = [];
  return new Promise((resolve, reject) => execFile(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=390,844', '--virtual-time-budget=6000', '--dump-dom', `http://127.0.0.1:${port}/start?${query}`],
    { maxBuffer: 20 * 1024 * 1024, timeout: 60000 }, (err, out) => (err ? reject(err) : resolve(out))));
}
const noErr = html => assert.ok(!/data-err=/.test(html), '画面でエラー：' + (html.match(/data-err="([^"]*)"/) || [])[1]);
const gateShown = html => !/<div class="gate" id="gate" hidden/.test(html);

const tests = {
  async 'ログインしていないと、ログイン画面だけが出て、API は呼ばれない'(port) {
    const html = await open(port, '');
    noErr(html);
    assert.ok(gateShown(html));
    assert.ok(/Googleアカウントでログインしてください。/.test(html));
    assert.ok(!/テスト商店/.test(html));
    assert.deepStrictEqual(posts, []);
  },
  async '使えないアカウントのときは、その旨が出てデータは出ない'(port) {
    const html = await open(port, 'session=bad');
    assert.ok(gateShown(html));
    assert.ok(/このアカウントでは使えません。/.test(part(html, 'gateMsg')));
    assert.ok(!/テスト商店/.test(html));
  },
  async 'ホーム：精算の見込み・予算・最近の記録が出る'(port) {
    const html = await open(port, 'session=p1');
    noErr(html);
    assert.ok(!gateShown(html));
    const hero = part(html, 'homeHero');
    assert.ok(/はなこ → たろう/.test(hero) && /36,260 円/.test(hero), hero.slice(0, 200)); // 払った額 74,321 − 負担額 38,061
    assert.ok(/5,821 円/.test(part(html, 'homeBudget')));                                  // 固定費（住居費）を除く
    assert.ok(/テスト商店/.test(part(html, 'homeFeed')));
    assert.deepStrictEqual(posts.map(p => p.action), ['app.init']);
  },
  async '記録・分析・精算の各タブが描ける'(port) {
    for (const [hash, id, word] of [['#records', 'recList', 'テスト薬局'], ['#analysis', 'anKpis', '75,821'], ['#settle', 'stCalc', '74,321']]) {
      const html = await open(port, 'session=p1&hash=' + encodeURIComponent(hash));
      noErr(html);
      assert.ok(part(html, id).includes(word), hash + ' に ' + word + ' がない');
    }
  },
  async '＋：「払った人」の最初の選択は、ログインした人（2人とも同じ扱い）'(port) {
    for (const [session, cls] of [['p1', 'p1 on'], ['p2', 'p2 on']]) {
      const html = await open(port, `session=${session}&run=${encodeURIComponent('#plusBtn')}`);
      noErr(html);
      const on = (html.match(/<div class="payer">.*?<\/div>/s) || [''])[0].match(/class="(p\d on)"/g) || [];
      assert.deepStrictEqual(on, [`class="${cls}"`]);
    }
    const html = await open(port, `session=noname&run=${encodeURIComponent('#plusBtn')}`);
    noErr(html);
    assert.ok(!/class="p\d on"/.test(html)); // 名前が決まっていない人は、どちらも選ばれていない
  },
  async '設定：「ログイン中」が出て、「この端末を使う人」はない。保存は settings.save で送る'(port) {
    const html = await open(port, `session=p2&run=${encodeURIComponent('#openSettings,[data-act="save-settings"]')}`);
    noErr(html);
    assert.ok(!/この端末を使う人/.test(html));
    assert.deepStrictEqual(posts.map(p => p.action), ['app.init', 'settings.save']);
    assert.deepStrictEqual(posts[1].payload, { settings: { budgets: { '食費': 40000 }, recurringOn: { r2: true } }, month: '2026/01' });
    const open2 = await open(port, `session=p2&run=${encodeURIComponent('#openSettings')}`);
    assert.ok(/ログイン中\s+はなこ\s+ログアウト/.test(text(open2)));
  },
  async '月の移動と削除が、決まった形で送られる'(port) {
    await open(port, `session=p1&run=${encodeURIComponent('#mPrev')}`);
    assert.deepStrictEqual(posts.map(p => [p.action, p.payload]), [['app.init', {}], ['month.get', { month: '2025/12' }]]);
    const html = await open(port, `session=p1&run=${encodeURIComponent('[data-edit="e1"],[data-act="del-ask"],[data-act="del-entry"]')}`);
    noErr(html);
    assert.deepStrictEqual(posts.map(p => [p.action, p.payload]), [['app.init', {}], ['entry.delete', { id: 'e1', month: '2026/01' }]]);
    assert.ok(posts.every(p => p.session === 'p1'));
  }
};

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  let failed = 0;
  for (const name of Object.keys(tests)) {
    try { await tests[name](port); console.log('OK  ' + name); } catch (e) { failed++; console.log('NG  ' + name + '\n    ' + e.message); }
  }
  console.log(failed ? failed + ' 件失敗' : 'すべて成功（' + Object.keys(tests).length + ' 件）');
  server.close();
  process.exit(failed ? 1 : 0);
});
