// API と認証のテスト（架空の値だけを使う）。実行： node tests/api.test.js
// Apps Script のソース（gas/）は公開していないので、手元に gas/ があるときだけ動く。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const GAS = path.join(__dirname, '../gas');
if (!fs.existsSync(path.join(GAS, 'kw_api.js'))) { console.log('gas/ が手元にないので、テストを飛ばしました。'); process.exit(0); }

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const props = {
  OAUTH_CLIENT_ID: CLIENT_ID, SESSION_SECRET: 'test-secret-1', ALLOWED_EMAILS: 'taro@example.com, hanako@example.com, guest@example.com',
  USER_MAP: JSON.stringify({ 'Taro@example.com': 'たろう', 'hanako@example.com': 'はなこ' })
};
let tokeninfo = null; // 次の tokeninfo の返事 { code, body }

const signed = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const b64 = x => Buffer.from(typeof x === 'string' ? x : x.map(b => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const ctx = {
  console: { error() {}, log() {} },
  Utilities: {
    Charset: { UTF_8: 'UTF_8' },
    getUuid: () => crypto.randomUUID(),
    base64EncodeWebSafe: b64,
    base64DecodeWebSafe: s => signed(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes.map(b => b & 255)).toString('utf8') }),
    computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', k).update(v).digest())
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => tokeninfo.code, getContentText: () => JSON.stringify(tokeninfo.body) }) },
  ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) }
};
vm.createContext(ctx);
['kyodo_webapp.js', 'kw_api.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(GAS, f), 'utf8'), ctx, { filename: f }));

// シートは読まず、呼ばれた内容を覚えて架空のデータを返す
const FAKE = { month: '2026/01', data: { total: 12345, entries: [] } };
let calls = [];
const fake = name => (...args) => { calls.push([name, ...args]); return Object.assign({ via: name }, FAKE); };
['kw_getMonth', 'kw_deleteEntry', 'kw_saveSettlement', 'kw_deleteSettlement', 'kw_saveSettings'].forEach(n => { ctx[n] = fake(n); });
ctx.kw_init = () => { calls.push(['kw_init']); return Object.assign({ names: { p1: 'たろう', p2: 'はなこ' } }, FAKE); };
ctx.kw_saveEntry = p => {
  calls.push(['kw_saveEntry', p]);
  if (p.id === 'none') throw new Error('この記録が見つかりませんでした。削除された可能性があります。画面を開き直してください。');
  if (!p.category) throw new Error('カテゴリを選んでください。');
  if (p.id === 'boom') { const e = new Error('内部の詳しい情報'); e.name = 'Exception'; throw e; }
  if (p.id === 'bug') return undefined.x;
  return Object.assign({ savedId: 'abc123' }, FAKE);
};

const post = body => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
const plain = x => JSON.parse(JSON.stringify(x));
const future = () => String(Math.floor(Date.now() / 1000) + 3000);
const goodInfo = over => ({ code: 200, body: Object.assign({ aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: future(), email_verified: 'true', email: 'Taro@example.com' }, over) });
const login = info => { tokeninfo = info; return post({ action: 'auth.login', payload: { idToken: 'x.y.z' } }); };
const sessionOf = email => login(goodInfo({ email })).data.session;

const tests = {
  '正しいログインでセッションと名前が返り、データが読める'() {
    const r = login(goodInfo());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.email, 'taro@example.com');
    assert.strictEqual(r.data.name, 'たろう');
    const p = post({ action: 'month.get', session: r.data.session, payload: { month: '2026/01' } });
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.data.data.total, 12345);
  },
  '起動：ログインした人の名前が付く（2人とも同じ扱い）'() {
    const a = post({ action: 'app.init', session: sessionOf('taro@example.com') }).data;
    const b = post({ action: 'app.init', session: sessionOf('HANAKO@example.com') }).data;
    assert.deepStrictEqual([a.me, a.email], ['たろう', 'taro@example.com']);
    assert.deepStrictEqual([b.me, b.email], ['はなこ', 'hanako@example.com']);
  },
  '名前が決まっていない人は、名前が空で返る'() {
    assert.strictEqual(post({ action: 'app.init', session: sessionOf('guest@example.com') }).data.me, '');
  },
  '画面の操作が、今の関数に同じ値で渡る'() {
    const s = sessionOf('taro@example.com');
    const entry = { id: '', date: '2026-01-09', payer: 'はなこ', amount: 1200, category: '食費', content: 'テスト商店', burden: '6:4', means: '現金', memo: '' };
    const settlement = { date: '2026-01-31', month: '2026/01', payer: 'はなこ', amount: 3000, means: '現金', memo: '' };
    const settings = { budgets: { '食費': 40000 }, recurringOn: { r2: true } };
    calls = [];
    assert.strictEqual(post({ action: 'entry.save', session: s, payload: { entry } }).data.savedId, 'abc123');
    post({ action: 'entry.delete', session: s, payload: { id: 'a1', month: '2026/01' } });
    post({ action: 'settle.save', session: s, payload: { settlement } });
    post({ action: 'settle.delete', session: s, payload: { id: 'p1', month: '2026/01' } });
    post({ action: 'settings.save', session: s, payload: { settings, month: '2026/01' } });
    post({ action: 'month.get', session: s, payload: { month: '2025/12' } });
    assert.deepStrictEqual(plain(calls), [
      ['kw_saveEntry', entry], ['kw_deleteEntry', 'a1', '2026/01'], ['kw_saveSettlement', settlement],
      ['kw_deleteSettlement', 'p1', '2026/01'], ['kw_saveSettings', settings, '2026/01'], ['kw_getMonth', '2025/12']
    ]);
  },
  '入力チェックの文はそのまま返り、内部のエラーの中身は返らない'() {
    const s = sessionOf('taro@example.com');
    const bad = post({ action: 'entry.save', session: s, payload: { entry: { id: '' } } });
    assert.deepStrictEqual(bad.error, { code: 'BAD_REQUEST', message: 'カテゴリを選んでください。' });
    assert.strictEqual(post({ action: 'entry.save', session: s, payload: { entry: { id: 'none', category: '食費' } } }).error.code, 'CONFLICT');
    ['boom', 'bug'].forEach(id => {
      const r = post({ action: 'entry.save', session: s, payload: { entry: { id, category: '食費' } } });
      assert.strictEqual(r.error.code, 'INTERNAL');
      assert.ok(!/内部|undefined/.test(r.error.message));
    });
    assert.strictEqual(post({ action: 'entry.save', session: s, payload: 'x' }).error.code, 'BAD_REQUEST');
  },
  'ログインなしでは読むことも書くこともできない'() {
    calls = [];
    ['app.init', 'month.get', 'entry.save', 'entry.delete', 'settle.save', 'settle.delete', 'settings.save'].forEach(action => {
      assert.strictEqual(post({ action, payload: { month: '2026/01', entry: { category: '食費' } } }).error.code, 'AUTH_REQUIRED');
      assert.strictEqual(post({ action, session: 'abc', payload: {} }).error.code, 'AUTH_EXPIRED');
    });
    assert.deepStrictEqual(calls, []);
  },
  '書き換えたセッションは AUTH_EXPIRED'() {
    const s = sessionOf('taro@example.com');
    const forged = b64(JSON.stringify({ email: 'hanako@example.com', exp: Number(future()), ver: 1 })).replace(/=+$/, '') + '.' + s.split('.')[1];
    assert.strictEqual(post({ action: 'month.get', session: forged }).error.code, 'AUTH_EXPIRED');
    assert.strictEqual(post({ action: 'month.get', session: s.slice(0, -2) + 'AA' }).error.code, 'AUTH_EXPIRED');
  },
  '期限切れのセッションは AUTH_EXPIRED'() {
    const old = ctx.kwApiSign_({ email: 'taro@example.com', exp: Math.floor(Date.now() / 1000) - 10, ver: 1 });
    assert.strictEqual(post({ action: 'month.get', session: old }).error.code, 'AUTH_EXPIRED');
  },
  '許可していないメールは FORBIDDEN'() {
    assert.strictEqual(login(goodInfo({ email: 'other@example.com' })).error.code, 'FORBIDDEN');
  },
  '許可一覧から外すと、手元のセッションも FORBIDDEN'() {
    const s = sessionOf('taro@example.com');
    const keep = props.ALLOWED_EMAILS;
    props.ALLOWED_EMAILS = 'hanako@example.com';
    assert.strictEqual(post({ action: 'month.get', session: s }).error.code, 'FORBIDDEN');
    props.ALLOWED_EMAILS = keep;
  },
  'IDトークンの不備はどれも AUTH_EXPIRED'() {
    const bad = [
      goodInfo({ aud: 'someone-else.apps.googleusercontent.com' }),
      goodInfo({ iss: 'https://evil.example.com' }),
      goodInfo({ exp: String(Math.floor(Date.now() / 1000) - 1) }),
      goodInfo({ email_verified: 'false' }),
      { code: 400, body: { error: 'invalid_token' } }
    ];
    bad.forEach(info => assert.strictEqual(login(info).error.code, 'AUTH_EXPIRED'));
  },
  'クライアントID未設定ならログインできない'() {
    const keep = props.OAUTH_CLIENT_ID;
    props.OAUTH_CLIENT_ID = '';
    assert.strictEqual(login(goodInfo({ aud: '' })).ok, false);
    props.OAUTH_CLIENT_ID = keep;
  },
  '形のおかしいリクエストと知らない操作は BAD_REQUEST'() {
    assert.strictEqual(post('こんにちは').error.code, 'BAD_REQUEST');
    assert.strictEqual(post({}).error.code, 'BAD_REQUEST');
    const s = sessionOf('taro@example.com');
    ['toString', 'kw_init', 'init', 'kwApiNewSecret'].forEach(action => assert.strictEqual(post({ action, session: s }).error.code, 'BAD_REQUEST'));
  },
  'doGet は画面もデータも出さない'() {
    assert.strictEqual(ctx.doGet().text, 'このURLはアプリのデータ用です。');
  },
  '前の方式（専用リンク）の名残がない'() {
    const all = ['kyodo_webapp.js', 'kw_api.js'].map(f => fs.readFileSync(path.join(GAS, f), 'utf8')).join('\n') +
      ['index.html', 'assets/app.js', 'config.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    assert.ok(!/kw_issueKeys|kw_whoByKey|[?&]key=|futariKakeiboKey|google\.script\.run/.test(all.replace(/p\.deleteProperty\('KW_KEYS'\);.*/, '')));
    assert.ok(!/KW_KEYS/.test(all.replace(/p\.deleteProperty\('KW_KEYS'\)/, '')));
  },
  '鍵を作り直すと、前のセッションは AUTH_EXPIRED'() {
    const s = sessionOf('taro@example.com');
    ctx.kwApiNewSecret();
    assert.strictEqual(post({ action: 'month.get', session: s }).error.code, 'AUTH_EXPIRED');
  }
};

let failed = 0;
Object.keys(tests).forEach(name => {
  try { tests[name](); console.log('OK  ' + name); } catch (e) { failed++; console.log('NG  ' + name + '\n    ' + e.message); }
});
console.log(failed ? failed + ' 件失敗' : 'すべて成功（' + Object.keys(tests).length + ' 件）');
process.exit(failed ? 1 : 0);
