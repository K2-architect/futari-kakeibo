/* =====================================================================
   データ層
   画面はすべて API を通してデータを読み書きする（中身は Apps Script の kw_ 関数。入口は kw_api.gs）。
   ===================================================================== */
const GLYPH_COLORS = ['#3B7F6B', '#5A86B5', '#7A6CB0', '#B0607A', '#D07A3E', '#C9953A', '#4E9A8E', '#8C7356', '#5C8A4A', '#B5584A', '#6A7FA8', '#A0606C', '#7D8B3F'];

const CFG = window.APP_CONFIG || {};
const SESSION_KEY = 'kkSession', NONCE_KEY = 'kkNonce';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

// API を1回呼ぶ。Content-Type は text/plain（事前確認を起こさないため）
function post(action, payload) {
  return fetch(CFG.API_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, session: store.get(SESSION_KEY) || '', payload: payload || {} })
  }).then(r => {
    if (!r.ok) throw { code: 'NETWORK', message: `通信に失敗しました（${r.status}）。しばらくしてからもう一度お試しください。` };
    return r.json();
  }, () => {
    throw { code: 'NETWORK', message: '通信できませんでした。電波の良い場所でもう一度お試しください。' };
  }).then(res => {
    if (!res || !res.ok) throw (res && res.error) || { code: 'INTERNAL', message: 'エラーが発生しました。' };
    return res.data;
  });
}
// API を呼ぶ。ログインが切れていたら、ログインし直してから1回だけやり直す
function call(action, payload) {
  const first = store.get(SESSION_KEY) ? post(action, payload) : Promise.reject({ code: 'AUTH_REQUIRED' });
  return first.catch(err => {
    if (!['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN'].includes(err.code)) throw err;
    store.del(SESSION_KEY);
    return relogin(err.code === 'FORBIDDEN' ? err.message : '').then(() => post(action, payload));
  });
}
const RAW_API = {
  init: () => call('app.init'),
  getMonth: m => call('month.get', { month: m }),
  saveEntry: p => call('entry.save', { entry: p }),
  deleteEntry: (id, m) => call('entry.delete', { id, month: m }),
  saveSettlement: p => call('settle.save', { settlement: p }),
  deleteSettlement: (id, m) => call('settle.delete', { id, month: m }),
  saveSettings: (p, m) => call('settings.save', { settings: p, month: m })
};

/* ---------- ログイン ---------- */
let gisReady = false, gisDrawn = false, checking = false, waiters = [];
const gateMsg = (text, isErr) => { const p = $('gateMsg'); p.textContent = text; p.className = isErr ? 'err' : ''; };
function relogin(msg) {
  return new Promise(resolve => {
    waiters.push(resolve);
    if (msg || !checking) gateMsg(msg || 'Googleアカウントでログインしてください。', !!msg);
    $('gateNote').hidden = !/Line\/|FBAN|FBAV|Instagram|GSA\//.test(navigator.userAgent);
    $('gate').hidden = false;
    drawGoogleButton();
  });
}
function drawGoogleButton() {
  if (!gisReady || gisDrawn || $('gate').hidden) return;
  google.accounts.id.renderButton($('gbtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
  gisDrawn = true;
}
// Google のログイン部品を読み込み終えたら呼ばれる
window.kkGisReady = () => {
  if (!(window.google && google.accounts && google.accounts.id)) return;
  google.accounts.id.initialize({ client_id: CFG.OAUTH_CLIENT_ID, callback: r => onIdToken(r.credential), ux_mode: 'popup', auto_select: false });
  gisReady = true;
  drawGoogleButton();
};
function onIdToken(idToken) {
  checking = true;
  gateMsg('ログインを確認中…');
  post('auth.login', { idToken }).then(d => {
    checking = false;
    store.set(SESSION_KEY, d.session);
    $('gate').hidden = true;
    const w = waiters; waiters = [];
    w.forEach(f => f());
  }, err => { checking = false; gateMsg(err.message, true); });
}
// 別の方法：小窓を使わず、ページごと Google に移動して戻ってくる
function loginByRedirect() {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => ('0' + b.toString(16)).slice(-2)).join('');
  store.set(NONCE_KEY, nonce);
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=id_token&scope=openid%20email&prompt=select_account' +
    '&client_id=' + encodeURIComponent(CFG.OAUTH_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(location.origin + location.pathname) + '&nonce=' + nonce;
}
// Google から戻ってきたとき、URL の # 以降に結果が付いている
function takeRedirectResult() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (!h.get('id_token') && !h.get('error')) return;
  history.replaceState(null, '', location.pathname + location.search);
  const nonce = store.get(NONCE_KEY); store.del(NONCE_KEY);
  let claims = {};
  try { claims = JSON.parse(atob(h.get('id_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) {}
  if (h.get('error') || !nonce || claims.nonce !== nonce) { checking = true; gateMsg('ログインできませんでした。もう一度お試しください。', true); return; }
  onIdToken(h.get('id_token'));
}
function logout() { store.del(SESSION_KEY); location.reload(); }
// 通信中は上に細いバーを出し、保存ボタンを押せなくする
let busyN = 0;
const API = new Proxy(RAW_API, { get: (o, k) => (...a) => {
  busyN++; document.body.classList.add('busy');
  return o[k](...a).finally(() => { if (--busyN === 0) document.body.classList.remove('busy'); });
} });

/* =====================================================================
   画面
   ===================================================================== */
const S = { cfg: null, ov: null, month: null, today: null, now: null, view: 'home', user: null, filter: { payer: 'all', cat: 'all', q: '' } };
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => Math.round(n).toLocaleString('ja-JP');
const P1 = () => S.cfg.names.p1, P2 = () => S.cfg.names.p2;
const pc = n => n === P1() ? 'p1' : n === P2() ? 'p2' : '';
const other = n => n === P1() ? P2() : P1();
const catInfo = name => { const i = S.cfg.categories.findIndex(c => c.name === name); const c = S.cfg.categories[i] || { name, g: (name || '？').slice(0, 1) }; return { ...c, color: GLYPH_COLORS[(i < 0 ? 12 : i) % GLYPH_COLORS.length] }; };
const glyph = name => { const c = catInfo(name); return `<span class="glyph" style="background:${c.color}" aria-hidden="true">${esc(c.g)}</span>`; };
const mLabel = m => `${+m.slice(0, 4) === 2026 ? '' : m.slice(0, 4) + '年'}${+m.slice(5)}月`;
const mdw = iso => { const [y, m, d] = iso.split('-').map(Number); return `${m}/${d}（${'日月火水木金土'[new Date(y, m - 1, d).getDay()]}）`; };
const pad = n => String(n).padStart(2, '0');
const shiftDate = (iso, k) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(y, m - 1, d + k); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
const shiftM = (m, k) => { let y = +m.slice(0, 4), mo = +m.slice(5) - 1 + k; y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12; return y + '/' + pad(mo + 1); };
const ago = isoTime => { const diff = (new Date(S.now) - new Date(isoTime)) / 60000; if (diff < 60) return `${Math.max(1, Math.round(diff))}分前`; if (diff < 1440) return `${Math.round(diff / 60)}時間前`; return `${Math.round(diff / 1440)}日前`; };
const ratioOf = b => { const t = String(b || '').normalize('NFKC').trim(); if (!t || t === '折半') return .5; if (t === P1() + 'だけ') return 1; if (t === P2() + 'だけ') return 0; const m = t.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/); return m && (+m[1] + +m[2]) > 0 ? +m[1] / (+m[1] + +m[2]) : null; };

let toastT;
function toast(msg, err) { const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast', err ? 4000 : 1800); }
function apply(ov) { S.ov = ov; if (ov.month) S.month = ov.month; render(); }
const fail = e => toast((e && e.message) || String(e), true);

/* ---------- ホーム ---------- */
function settleWords(d) {
  const r = d.remaining;
  if (d.total === 0 && d.settled === 0) return { dir: '', amt: 0, state: 'empty' };
  if (r > 0) return { from: P2(), to: P1(), amt: r, state: 'todo' };
  if (r < 0) return { from: P1(), to: P2(), amt: -r, state: 'todo' };
  return { amt: 0, state: 'done' };
}
function heroHTML(d, withButtons) {
  const w = settleWords(d), isCur = S.month === S.today.slice(0, 7).replace('-', '/');
  const moon = '<svg class="moon" viewBox="0 0 40 40" aria-hidden="true"><path d="M30 28a14 14 0 1 1-8-24 11 11 0 1 0 8 24z" fill="var(--window)"/></svg>';
  let body;
  if (w.state === 'empty') body = `<p class="eyebrow">${mLabel(S.month)}の精算</p><div class="amt num">0<span>円</span></div><div class="meta">この月の記録はまだありません</div>`;
  else if (w.state === 'done') body = `<p class="eyebrow">${mLabel(S.month)}の精算</p><div class="amt">精算済み</div><div class="meta">2人の支出 ${yen(d.total)}円・精算 ${yen(Math.abs(d.settled))}円</div>`;
  else body = `<p class="eyebrow">${mLabel(S.month)}の精算${isCur ? '見込み' : ''}</p>
      <div class="dir"><span class="who"><span class="dot ${pc(w.from)}"></span>${esc(w.from)}</span><span class="arrow">→</span><span class="who"><span class="dot ${pc(w.to)}"></span>${esc(w.to)}</span></div>
      <div class="amt num">${yen(w.amt)}<span>円</span></div>
      <div class="meta">${isCur ? '今日までの記録で計算しています。月末に確定します' : '精算がまだ済んでいません'}</div>`;
  const btns = withButtons ? `<div class="act"><button type="button" data-act="settle">精算を記録</button><button type="button" class="sub" data-act="go-settle">内訳を見る</button></div>` : '';
  return moon + body + (w.state === 'todo' ? btns : '');
}
function budgetCalc(d) {
  const b = S.ov.budgets, cats = Object.keys(b).filter(k => b[k] > 0);
  const spent = d.entries.filter(e => !catInfo(e.category).fixed).reduce((a, e) => a + e.amount, 0);
  const budget = cats.reduce((a, k) => a + b[k], 0);
  const [y, m] = S.month.split('/').map(Number), dim = new Date(y, m, 0).getDate();
  const isCur = S.month === S.today.slice(0, 7).replace('-', '/');
  const day = isCur ? +S.today.slice(8) : dim;
  return { spent, budget, dim, day, isCur, left: dim - day + 1, cats };
}
function renderHome() {
  const d = S.ov.data;
  $('homeHero').innerHTML = heroHTML(d, true);
  const bc = budgetCalc(d), pct = bc.budget ? bc.spent / bc.budget : 0, pace = bc.day / bc.dim;
  const cls = pct > 1 ? 'over' : pct > pace + .1 ? 'warn' : '';
  const perDay = bc.isCur && bc.budget > bc.spent ? Math.floor((bc.budget - bc.spent) / bc.left) : 0;
  const byCat = {}; d.entries.forEach(e => byCat[e.category] = (byCat[e.category] || 0) + e.amount);
  const rows = bc.cats.map(k => ({ k, v: byCat[k] || 0, b: S.ov.budgets[k] })).sort((a, b2) => b2.v / b2.b - a.v / a.b).slice(0, 4);
  if (!bc.budget) {
    $('homeBudget').innerHTML = `<h2 class="sec">やりくり費<small>家賃などの固定費を除く</small></h2>
      <div class="bud-top"><span class="big num">${yen(bc.spent)}<span style="font-size:15px">円</span></span></div>
      <p class="hint" style="margin:8px 0 10px">予算はまだ決めていません。右上の設定からカテゴリごとに入れると、残りと1日あたり使える額が出ます。</p>
      <button type="button" class="btn ghost" data-act="open-settings">予算を決める</button>`;
  } else
  $('homeBudget').innerHTML = `
    <h2 class="sec">やりくり費の予算<small>家賃などの固定費を除く</small></h2>
    <div class="bud-top"><span class="big num">${yen(bc.spent)}<span style="font-size:15px">円</span></span><span class="of num">予算 ${yen(bc.budget)}円</span></div>
    <div class="meter" role="img" aria-label="予算の${Math.round(pct * 100)}%を使用"><i class="${cls}" style="width:${Math.min(100, pct * 100)}%"></i>${bc.isCur ? `<span class="pace" style="left:${pace * 100}%" title="今日の目安"></span>` : ''}</div>
    <div class="bud-note num">${bc.budget >= bc.spent ? `<span>残り <b>${yen(bc.budget - bc.spent)}円</b></span>` : `<span style="color:var(--bad)">予算を <b style="color:var(--bad)">${yen(bc.spent - bc.budget)}円</b> 超えています</span>`}${bc.isCur ? `<span>あと${bc.left}日・1日 <b>${yen(perDay)}円</b> まで</span>` : ''}</div>
    <div class="cats">${rows.map(r => { const p = r.v / r.b, c = p > 1 ? 'over' : p > pace + .1 ? 'warn' : ''; return `
      <div class="crow">${glyph(r.k)}<div><div class="nm"><span>${esc(r.k)}${p > 1 ? ' <span class="pill over">超過</span>' : ''}</span><span class="num">${yen(r.v)} / ${yen(r.b)}円</span></div><div class="meter"><i class="${c}" style="width:${Math.min(100, p * 100)}%"></i></div></div><span class="v num">${Math.round(p * 100)}%</span></div>`; }).join('')}</div>
    <div style="margin-top:12px"><button type="button" class="link" data-act="go-analysis">すべてのカテゴリを見る ›</button></div>`;

  const day = +S.today.slice(8);
  const rec = S.ov.recurring.filter(r => r.on).map(r => ({ ...r, next: r.day >= day ? r.day : null })).filter(r => r.next).sort((a, b) => a.next - b.next);
  $('homeUpcoming').innerHTML = `<h2 class="sec">今月これからの定期の支払い<small>${rec.length}件</small></h2>` + (rec.length ? `<div class="list">${rec.map(r => `
      <div class="row" style="cursor:default">${glyph(r.category)}<div style="min-width:0"><div class="t">${esc(r.name)}</div><div class="s"><span class="who"><span class="dot ${pc(r.payer)}"></span>${esc(r.payer)}</span>・${esc(r.means)}・${esc(r.burden)}</div></div><div class="a num">${yen(r.amount)}円<small>${+S.month.slice(5)}/${r.next}</small></div></div>`).join('')}</div>` : '<div class="empty">今月の残りの定期の支払いはありません</div>');

  $('homeFeed').innerHTML = `<h2 class="sec">最近の記録<small>新しく登録した順</small></h2><div class="list feed">${S.ov.feed.map(e => `
      <button type="button" class="row" data-edit="${esc(e.id)}" data-month="${esc(e.month)}">${glyph(e.category)}<div style="min-width:0"><div class="t">${esc(e.content || e.category)}</div><div class="s"><span class="who"><span class="dot ${pc(e.payer)}"></span>${esc(e.payer)}</span>が支払い・${ago(e.created)}</div></div><div class="a num">${yen(e.amount)}円</div></button>`).join('')}</div>
    <div style="margin-top:8px"><button type="button" class="link" data-act="go-records">記録をすべて見る ›</button></div>`;
}

/* ---------- 記録 ---------- */
function renderRecords() {
  const f = S.filter, d = S.ov.data;
  const payerOpts = [['all', 'すべて'], [P1(), P1()], [P2(), P2()]];
  $('fPayer').innerHTML = payerOpts.map(([v, l]) => `<button type="button" class="chip${f.payer === v ? ' on' : ''}" data-fpayer="${esc(v)}">${v !== 'all' ? `<span class="dot ${pc(v)}"></span>` : ''}${esc(l)}が払った</button>`).join('').replace('すべてが払った', 'ふたりとも');
  const used = [...new Set(d.entries.map(e => e.category))];
  $('fCat').innerHTML = [`<button type="button" class="chip${f.cat === 'all' ? ' on' : ''}" data-fcat="all">全カテゴリ</button>`].concat(S.cfg.categories.filter(c => used.includes(c.name)).map(c => `<button type="button" class="chip${f.cat === c.name ? ' on' : ''}" data-fcat="${esc(c.name)}">${esc(c.name)}</button>`)).join('');
  const q = f.q.trim().toLowerCase();
  const list = d.entries.filter(e => (f.payer === 'all' || e.payer === f.payer) && (f.cat === 'all' || e.category === f.cat) && (!q || (e.content + ' ' + e.memo + ' ' + e.category).toLowerCase().includes(q)));
  const sum = list.reduce((a, e) => a + e.amount, 0);
  $('recSum').innerHTML = `<span>${list.length}件</span><span>合計 <b class="num">${yen(sum)}円</b></span>`;
  if (!list.length) { $('recList').innerHTML = `<div class="empty">${d.entries.length ? '条件に合う記録はありません' : 'この月の記録はまだありません。下の＋から追加できます'}</div>`; return; }
  let html = '', cur = '';
  list.forEach(e => {
    if (e.date !== cur) { cur = e.date; const daySum = list.filter(x => x.date === cur).reduce((a, x) => a + x.amount, 0); html += `<div class="dayh"><span>${mdw(cur)}</span><span class="num">${yen(daySum)}円</span></div>`; }
    const b = e.burden && e.burden !== '折半' ? `・${esc(e.burden)}` : '';
    html += `<button type="button" class="row" data-edit="${esc(e.id)}" data-month="${esc(e.month)}">${glyph(e.category)}<div style="min-width:0"><div class="t">${esc(e.content || e.category)}</div><div class="s"><span class="who"><span class="dot ${pc(e.payer)}"></span>${esc(e.payer)}</span>・${esc(e.category)}${b}${e.memo ? '・' + esc(e.memo) : ''}</div></div><div class="a num">${yen(e.amount)}円<small>${esc(P1())} ${yen(e.share1)}・${esc(P2())} ${yen(e.share2)}</small></div></button>`;
  });
  $('recList').innerHTML = html;
}

/* ---------- 分析 ---------- */
function renderAnalysis() {
  const d = S.ov.data, pv = S.ov.prev, bc = budgetCalc(d);
  const diff = d.total - pv.total, vd = (bc.spent) - pv.entries.filter(e => !catInfo(e.category).fixed).reduce((a, e) => a + e.amount, 0);
  const sign = v => v === 0 ? '前月と同じ' : `前月より ${yen(Math.abs(v))}円 ${v > 0 ? '多い' : '少ない'}`; void diff;
  $('anKpis').innerHTML = `
    <div class="kpi"><div class="l">2人の支出</div><div class="v num">${yen(d.total)}円</div><div class="d num" style="color:var(--muted)">固定費 ${yen(d.total - bc.spent)}円</div></div>
    <div class="kpi"><div class="l">やりくり費</div><div class="v num">${yen(bc.spent)}円</div><div class="d ${vd > 0 ? 'up' : 'down'} num">${sign(vd)}</div></div>`;

  // 月ごとの積み上げ棒（固定費＋やりくり費）
  const t = S.ov.trend, W = 340, H = 190, L = 44, B = 26, T = 14, R = 6;
  const max = Math.max(1, ...t.map(x => x.total));
  const step = max > 300000 ? 100000 : max > 100000 ? 50000 : 20000, top = Math.ceil(max / step) * step;
  const y = v => T + (H - T - B) * (1 - v / top), bw = (W - L - R) / t.length;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="直近6か月の支出（固定費とやりくり費）">`;
  for (let v = 0; v <= top; v += step) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v / 10000}万</text>`;
  t.forEach((x, i) => {
    const cx = L + bw * i + bw * .18, w = bw * .64, cur = x.month === S.month;
    svg += `<rect x="${cx}" y="${y(x.fixed)}" width="${w}" height="${y(0) - y(x.fixed)}" fill="var(--night)" opacity="${cur ? 1 : .55}" rx="3"/>`;
    svg += `<rect x="${cx}" y="${y(x.total)}" width="${w}" height="${y(x.fixed) - y(x.total)}" fill="var(--roof)" opacity="${cur ? 1 : .6}" rx="3"/>`;
    svg += `<text x="${cx + w / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${cur ? 'var(--ink)' : 'var(--muted)'}" font-weight="${cur ? 700 : 400}">${+x.month.slice(5)}月</text>`;
    if (cur && x.total) svg += `<text x="${cx + w / 2}" y="${y(x.total) - 4}" text-anchor="middle" font-size="10" fill="var(--ink)" font-weight="700">${(x.total / 10000).toFixed(1)}万</text>`;
  });
  svg += '</svg>';
  $('anTrend').innerHTML = svg + `<div class="legend"><span><i class="sw" style="background:var(--night)"></i>固定費（家賃・光熱費・通信・サブスク）</span><span><i class="sw" style="background:var(--roof)"></i>やりくり費</span></div>`;

  // カテゴリ別と予算
  const byCat = {}; d.entries.forEach(e => byCat[e.category] = (byCat[e.category] || 0) + e.amount);
  const pace = bc.day / bc.dim;
  const vcats = S.cfg.categories.filter(c => !c.fixed && (byCat[c.name] || S.ov.budgets[c.name]));
  $('anBudget').innerHTML = `<h2 class="sec">カテゴリ別と予算<small>${bc.isCur ? `今日は月の${Math.round(pace * 100)}%` : '月の合計'}</small></h2><div class="cats" style="margin-top:0">` +
    vcats.map(c => { const v = byCat[c.name] || 0, b = S.ov.budgets[c.name] || 0, p = b ? v / b : 0, cl = b && p > 1 ? 'over' : b && p > pace + .1 ? 'warn' : '';
      return `<div class="crow">${glyph(c.name)}<div><div class="nm"><span>${esc(c.name)}${b && p > 1 ? ' <span class="pill over">超過</span>' : ''}</span><span class="num">${b ? `予算 ${yen(b)}円` : '予算なし'}</span></div><div class="meter"><i class="${cl}" style="width:${b ? Math.min(100, p * 100) : 0}%"></i></div></div><span class="v num">${yen(v)}円</span></div>`; }).join('') +
    `</div><div class="cats" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">` +
    S.cfg.categories.filter(c => c.fixed && byCat[c.name]).map(c => `<div class="crow">${glyph(c.name)}<div class="nm"><span>${esc(c.name)} <span class="pill">固定費</span></span></div><span class="v num">${yen(byCat[c.name])}円</span></div>`).join('') + `</div>`;

  // 2人の内訳
  const sh = d.total ? d.share1 / d.total : .5, pd = d.total ? d.paid1 / d.total : .5;
  $('anSplit').innerHTML = `<h2 class="sec">ふたりの内訳</h2>
    <div class="split-l"><span>払った額</span><span class="num">${esc(P1())} ${yen(d.paid1)}円・${esc(P2())} ${yen(d.paid2)}円</span></div>
    <div class="split" role="img" aria-label="払った額の割合"><i style="width:${pd * 100}%;background:var(--p1)"></i><i style="width:${(1 - pd) * 100}%;background:var(--p2)"></i></div>
    <div class="split-l"><span>負担する額</span><span class="num">${esc(P1())} ${yen(d.share1)}円・${esc(P2())} ${yen(d.share2)}円</span></div>
    <div class="split" role="img" aria-label="負担する額の割合"><i style="width:${sh * 100}%;background:var(--p1)"></i><i style="width:${(1 - sh) * 100}%;background:var(--p2)"></i></div>
    <div class="legend"><span><i class="sw" style="background:var(--p1)"></i>${esc(P1())}</span><span><i class="sw" style="background:var(--p2)"></i>${esc(P2())}</span><span>払った額と負担する額の差が精算額になります</span></div>`;

  // 前月比
  const pcat = {}; pv.entries.forEach(e => pcat[e.category] = (pcat[e.category] || 0) + e.amount);
  const names = [...new Set(Object.keys(byCat).concat(Object.keys(pcat)))].filter(n => !catInfo(n).fixed).sort((a, b) => Math.abs((byCat[b] || 0) - (pcat[b] || 0)) - Math.abs((byCat[a] || 0) - (pcat[a] || 0)));
  $('anCompare').innerHTML = `<h2 class="sec">前月（${mLabel(shiftM(S.month, -1))}）との比較<small>やりくり費</small></h2>` + (names.length ? `<div class="cmp"><span class="h">カテゴリ</span><span class="h r">${mLabel(S.month)}</span><span class="h r">差</span>` +
    names.map(n => { const a = byCat[n] || 0, b = pcat[n] || 0, df = a - b; return `<span>${esc(n)}</span><span class="r num">${yen(a)}円</span><span class="r num ${df > 0 ? 'up' : df < 0 ? 'down' : ''}">${df > 0 ? '+' : df < 0 ? '−' : '±'}${yen(Math.abs(df))}</span>`; }).join('') + '</div>' : '<div class="empty">比べる記録がありません</div>');
}

/* ---------- 精算 ---------- */
function renderSettle() {
  const d = S.ov.data;
  $('stHero').innerHTML = heroHTML(d, false) + (settleWords(d).state === 'todo' ? `<div class="act"><button type="button" data-act="settle">精算を記録</button></div>` : '');
  $('stCalc').innerHTML = `<h2 class="sec">計算の内訳<small>${mLabel(S.month)}</small></h2>
    <div class="calc num">
      <span><span class="who"><span class="dot p1"></span>${esc(P1())}</span>が払った額</span><span class="r">${yen(d.paid1)}円</span>
      <span>− ${esc(P1())}の負担額</span><span class="r">${yen(d.share1)}円</span>
      <span>− 精算済み（${esc(P2())}→${esc(P1())}）</span><span class="r">${yen(d.settled)}円</span>
      <span class="sep"></span>
      <span class="tot">残り</span><span class="r tot">${yen(d.remaining)}円</span>
    </div>
    <p class="hint" style="margin:10px 0 0">残りがプラスなら${esc(P2())}から${esc(P1())}へ、マイナスなら${esc(P1())}から${esc(P2())}へ渡します。</p>`;
  $('stHistory').innerHTML = `<h2 class="sec">${mLabel(S.month)}の精算記録</h2>` + (d.settlements.length ? `<div class="list">${d.settlements.map(p => `
      <div class="row" style="cursor:default"><span class="glyph" style="background:var(--night)" aria-hidden="true">精</span><div style="min-width:0"><div class="t">${esc(p.payer)} → ${esc(other(p.payer))}</div><div class="s">${mdw(p.date)}${p.means ? '・' + esc(p.means) : ''}${p.memo ? '・' + esc(p.memo) : ''}</div></div><div class="a num">${yen(p.amount)}円<small><button type="button" class="link" style="font-size:12px;color:var(--bad)" data-delsettle="${esc(p.id)}">削除</button></small></div></div>
      <div id="cf-${esc(p.id)}"></div>`).join('')}</div>` : '<div class="empty">まだ精算していません</div>');
  $('stMonths').innerHTML = `<h2 class="sec">月ごとの状況</h2><div class="mlist">${S.ov.months.map(m => {
      const st = m.remaining === 0 ? (m.total ? '<span class="pill ok">精算済み</span>' : '<span class="pill">記録なし</span>') : `<span class="pill todo">残り ${yen(Math.abs(m.remaining))}円</span>`;
      return `<button type="button" class="mrow" data-month-go="${esc(m.month)}"><span><b>${mLabel(m.month)}</b> <span class="hint num">支出 ${yen(m.total)}円</span></span>${st}</button>`; }).join('')}</div>`;
}

/* ---------- 全体 ---------- */
function render() {
  $('mLabel').textContent = `${S.month.slice(0, 4)}/${S.month.slice(5)}`;
  ({ home: renderHome, records: renderRecords, analysis: renderAnalysis, settle: renderSettle })[S.view]();
}
function show(v) {
  S.view = v;
  ['home', 'records', 'analysis', 'settle'].forEach(k => $('v-' + k).classList.toggle('active', k === v));
  document.querySelectorAll('.tabs [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  render(); window.scrollTo(0, 0);
}
function goMonth(m) { API.getMonth(m).then(ov => { S.month = m; apply(ov); }).catch(fail); }

/* ---------- シート（入力・精算・設定） ---------- */
const sheet = {
  open(html) { $('sheet').innerHTML = '<div class="grab"></div>' + html; $('scrim').classList.add('show'); },
  close() { $('scrim').classList.remove('show'); $('sheet').onclick = null; $('sheet').oninput = null; }
};
$('scrim').addEventListener('click', e => { if (e.target === $('scrim')) sheet.close(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') sheet.close(); });

let F = null; // 入力中のフォーム
function openEntry(entry, mode) {
  const lastMeans = p => { const m = store.get('kk_means_' + p); return S.cfg.means.includes(m) ? m : S.cfg.means[0]; };
  const payer = entry ? entry.payer : S.user; // 新しい記録は、ログインした人
  const b = entry ? entry.burden || '折半' : '折半';
  const std = ['折半', P1() + 'だけ', P2() + 'だけ'].includes(b);
  F = { mode: mode || 'expense', id: entry ? entry.id : '', payer, category: entry ? entry.category : null, burden: std ? b : '割合', ratio: std ? '' : b, means: entry ? entry.means : lastMeans(payer),
    amount: entry ? String(entry.amount) : '', content: entry ? entry.content : '', memo: entry ? entry.memo : '', date: entry ? entry.date : S.today, lastMeans, confirmDel: false,
    sPayer: null, sAmount: '', sMeans: store.get('kk_settle_means') || '口座引落・振込', sDate: S.today, sMemo: '' };
  if (F.mode === 'settle') { const w = settleWords(S.ov.data); F.sPayer = w.from || P2(); F.sAmount = w.amt ? String(w.amt) : ''; }
  drawEntry();
}
function readEntryInputs() {
  const g = id => $(id) ? $(id).value : undefined;
  if (F.mode === 'expense') { F.amount = g('eAmount') ?? F.amount; F.content = g('eContent') ?? F.content; F.memo = g('eMemo') ?? F.memo; F.date = g('eDate') ?? F.date; F.ratio = g('eRatio') ?? F.ratio; }
  else { F.sAmount = g('sAmount') ?? F.sAmount; F.sDate = g('sDate') ?? F.sDate; F.sMemo = g('sMemo') ?? F.sMemo; }
}
function drawEntry() {
  const s = S.cfg, isEdit = !!F.id;
  const seg = isEdit ? '' : `<div class="seg" role="tablist"><button type="button" class="${F.mode === 'expense' ? 'on' : ''}" data-mode="expense">支出</button><button type="button" class="${F.mode === 'settle' ? 'on' : ''}" data-mode="settle">精算</button></div>`;
  const payerBtns = (sel, attr) => `<div class="payer">${s.names ? [P1(), P2()].map(n => `<button type="button" class="${pc(n)}${sel === n ? ' on' : ''}" data-${attr}="${esc(n)}"><span class="dot ${pc(n)}"></span>${esc(n)}</button>`).join('') : ''}</div>`;
  let body;
  if (F.mode === 'expense') {
    const r = ratioOf(F.burden === '割合' ? F.ratio : F.burden), a = +F.amount || 0;
    const prev = !a ? '' : r === null ? '割合は「6:4」のように入れてください' : `${P1()} ${yen(Math.round(a * r))}円・${P2()} ${yen(a - Math.round(a * r))}円 の負担になります`;
    body = `
      <div class="f"><span class="lb">払った人</span>${payerBtns(F.payer, 'payer')}</div>
      <div class="f"><label for="eAmount">金額</label><div class="amountbox"><input id="eAmount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(F.amount)}"><span>円</span></div><div class="hint num" id="ePrev">${esc(prev)}</div></div>
      <div class="f"><span class="lb">カテゴリ</span><div class="catgrid">${s.categories.map(c => `<button type="button" class="${F.category === c.name ? 'on' : ''}" data-cat="${esc(c.name)}">${glyph(c.name)}${esc(c.name)}</button>`).join('')}</div></div>
      <div class="f"><span class="lb">負担</span><div class="chips">${['折半', P1() + 'だけ', P2() + 'だけ', '割合'].map(v => `<button type="button" class="chip${F.burden === v ? ' on' : ''}" data-burden="${esc(v)}">${v === '割合' ? '割合で決める' : esc(v)}</button>`).join('')}</div>
        ${F.burden === '割合' ? `<div class="inrow"><span class="hint" style="min-height:0">${esc(P1())} : ${esc(P2())}</span><input class="tx" id="eRatio" placeholder="6:4" value="${esc(F.ratio)}" autocomplete="off"></div>` : ''}</div>
      <div class="f"><span class="lb">支払方法</span><div class="chips">${s.means.map(m => `<button type="button" class="chip${F.means === m ? ' on' : ''}" data-means="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>
      <div class="f"><label for="eContent">内容</label><input class="tx" id="eContent" placeholder="例：スーパー、電気代" value="${esc(F.content)}" autocomplete="off"></div>
      <div class="f"><label for="eDate">日付</label><div class="inrow"><input class="tx" type="date" id="eDate" value="${esc(F.date)}"><button type="button" class="chip" data-day="0">今日</button><button type="button" class="chip" data-day="-1">昨日</button></div></div>
      <div class="f"><label for="eMemo">メモ（任意）</label><input class="tx" id="eMemo" value="${esc(F.memo)}" autocomplete="off"></div>
      <button type="button" class="btn" data-act="save-entry">${isEdit ? '保存する' : '登録する'}</button>
      ${isEdit ? (F.confirmDel ? `<div class="confirm"><span>${mdw(F.date)} ${esc(F.content || F.category)} ${yen(+F.amount)}円 を削除します。元に戻せません。</span><div class="inrow"><button type="button" class="btn danger" data-act="del-entry">削除する</button><button type="button" class="btn ghost" data-act="del-cancel">やめる</button></div></div>` : `<button type="button" class="btn danger" data-act="del-ask">この記録を削除</button>`) : ''}`;
  } else {
    const d = S.ov.data;
    body = `
      <div class="f"><span class="lb">渡した人</span>${payerBtns(F.sPayer, 'spayer')}<div class="hint">${esc(F.sPayer)} → ${esc(other(F.sPayer))}・${mLabel(S.month)}の残り ${yen(Math.abs(d.remaining))}円</div></div>
      <div class="f"><label for="sAmount">金額</label><div class="amountbox"><input id="sAmount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(F.sAmount)}"><span>円</span></div></div>
      <div class="f"><span class="lb">渡し方</span><div class="chips">${s.means.map(m => `<button type="button" class="chip${F.sMeans === m ? ' on' : ''}" data-smeans="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>
      <div class="f"><label for="sDate">日付</label><input class="tx" type="date" id="sDate" value="${esc(F.sDate)}"></div>
      <div class="f"><label for="sMemo">メモ（任意）</label><input class="tx" id="sMemo" value="${esc(F.sMemo)}" autocomplete="off"></div>
      <button type="button" class="btn" data-act="save-settle">${mLabel(S.month)}分の精算を記録する</button>`;
  }
  const title = isEdit ? '記録を編集' : F.mode === 'expense' ? '支出を記録' : '精算を記録';
  sheet.open(`<div class="sheethead"><h3>${title}</h3><button type="button" class="iconbtn" data-act="close" aria-label="閉じる">✕</button></div><div class="form">${seg}${body}</div>`);
}
function onSheetInput(e) {
  if (!F) return;
  if (e.target.id === 'eAmount' || e.target.id === 'sAmount') { e.target.value = e.target.value.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\D/g, '').replace(/^0+(?=\d)/, ''); }
  if (F.mode === 'expense' && (e.target.id === 'eAmount' || e.target.id === 'eRatio')) {
    readEntryInputs();
    const r = ratioOf(F.burden === '割合' ? F.ratio : F.burden), a = +F.amount || 0;
    $('ePrev').textContent = !a ? '' : r === null ? '割合は「6:4」のように入れてください' : `${P1()} ${yen(Math.round(a * r))}円・${P2()} ${yen(a - Math.round(a * r))}円 の負担になります`;
  }
}
$('sheet').addEventListener('input', onSheetInput);

function openSettings() {
  const B = { ...S.ov.budgets }, on = {};
  S.ov.recurring.forEach(r => on[r.id] = r.on);
  const draw = () => {
    const vcats = S.cfg.categories.filter(c => !c.fixed);
    const total = vcats.reduce((a, c) => a + (+B[c.name] || 0), 0);
    sheet.open(`<div class="sheethead"><h3>設定</h3><button type="button" class="iconbtn" data-act="close" aria-label="閉じる">✕</button></div>
      <div class="form">
        <div class="f"><span class="lb">ログイン中</span><div class="login"><span class="who">${S.user ? `<span class="dot ${pc(S.user)}"></span>${esc(S.user)}` : esc(S.email)}</span><button type="button" class="chip" data-act="logout">ログアウト</button></div><div class="hint">${S.user ? '「払った人」の最初の選択は、ログインした人になります' : 'このアカウントの名前がまだ決まっていません'}</div></div>
        <div class="panel"><h2 class="sec">やりくり費の月の予算<small class="num" id="budTotal">合計 ${yen(total)}円</small></h2><div class="cats" style="margin-top:0">${vcats.map(c => `
          <div class="setrow">${glyph(c.name)}<label for="b-${esc(c.name)}">${esc(c.name)}</label><input class="tx num" id="b-${esc(c.name)}" data-budget="${esc(c.name)}" inputmode="numeric" value="${B[c.name] || ''}" placeholder="予算なし"></div>`).join('')}</div></div>
        <div class="panel"><h2 class="sec">定期の支払い<small>オンの項目は毎月自動で記録</small></h2><div class="list">${S.ov.recurring.map(r => `
          <div class="row" style="cursor:default">${glyph(r.category)}<div style="min-width:0"><div class="t">${esc(r.name)}</div><div class="s">毎月${r.day}日・<span class="who"><span class="dot ${pc(r.payer)}"></span>${esc(r.payer)}</span>・${yen(r.amount)}円${r.note ? '・' + esc(r.note) : ''}</div></div><button type="button" class="toggle${on[r.id] ? ' on' : ''}" data-rec="${esc(r.id)}" aria-pressed="${on[r.id]}" aria-label="${esc(r.name)}を自動で記録"></button></div>`).join('')}</div></div>
        <p class="hint" style="margin:0">カテゴリ・支払方法・名前は、スプレッドシートの「設定」シートで変えられます。</p>
        <button type="button" class="btn" data-act="save-settings">保存する</button>
      </div>`);
    $('sheet').onclick = e => {
      if (e.target.closest('[data-act="logout"]')) { logout(); return; }
      const t = e.target.closest('[data-rec]'); if (t) { on[t.dataset.rec] = !on[t.dataset.rec]; keepBudgets(); draw(); return; }
      if (e.target.closest('[data-act="close"]')) { $('sheet').onclick = null; sheet.close(); }
      if (e.target.closest('[data-act="save-settings"]')) { keepBudgets(); API.saveSettings({ budgets: B, recurringOn: on }, S.month).then(ov => { $('sheet').onclick = null; sheet.close(); apply(ov); toast('設定を保存しました'); }).catch(fail); }
    };
    $('sheet').oninput = e => { if (e.target.dataset.budget !== undefined) { e.target.value = e.target.value.replace(/\D/g, ''); keepBudgets(); $('budTotal').textContent = `合計 ${yen(S.cfg.categories.filter(c => !c.fixed).reduce((a, c) => a + (+B[c.name] || 0), 0))}円`; } };
  };
  const keepBudgets = () => document.querySelectorAll('[data-budget]').forEach(i => { const v = +i.value || 0; if (v > 0) B[i.dataset.budget] = v; else delete B[i.dataset.budget]; });
  draw();
}

/* ---------- 操作 ---------- */
document.addEventListener('click', e => {
  const t = e.target;
  if ($('sheet').onclick && $('sheet').contains(t)) return; // 設定シートは専用の処理
  const tab = t.closest('.tabs [data-v]'); if (tab) return show(tab.dataset.v);
  if (t.closest('#plusBtn')) return openEntry(null, 'expense');
  if (t.closest('#openSettings')) return openSettings();
  if (t.closest('#mPrev')) return goMonth(shiftM(S.month, -1));
  if (t.closest('#mNext')) return goMonth(shiftM(S.month, 1));
  const act = t.closest('[data-act]');
  const ed = t.closest('[data-edit]');
  if (ed) { const m = ed.dataset.month; const find = () => S.ov.data.entries.find(x => x.id === ed.dataset.edit); if (m === S.month) return openEntry(find()); return API.getMonth(m).then(ov => { S.month = m; apply(ov); openEntry(find()); }).catch(fail); }
  const fp = t.closest('[data-fpayer]'); if (fp) { S.filter.payer = fp.dataset.fpayer; return renderRecords(); }
  const fc = t.closest('[data-fcat]'); if (fc) { S.filter.cat = fc.dataset.fcat; return renderRecords(); }
  const mg = t.closest('[data-month-go]'); if (mg) return goMonth(mg.dataset.monthGo);
  const ds = t.closest('[data-delsettle]');
  if (ds) { const id = ds.dataset.delsettle, box = $('cf-' + id); box.innerHTML = `<div class="confirm"><span>この精算記録を削除します。</span><div class="inrow"><button type="button" class="btn danger" data-act="del-settle" data-id="${esc(id)}">削除する</button><button type="button" class="btn ghost" data-act="del-settle-cancel" data-id="${esc(id)}">やめる</button></div></div>`; return; }

  // シート内（支出・精算）
  if (F && $('scrim').classList.contains('show') && $('sheet').contains(t)) {
    readEntryInputs();
    const md = t.closest('[data-mode]'); if (md) { F.mode = md.dataset.mode; if (F.mode === 'settle' && !F.sPayer) { const w = settleWords(S.ov.data); F.sPayer = w.from || P2(); F.sAmount = w.amt ? String(w.amt) : ''; } return drawEntry(); }
    const py = t.closest('[data-payer]'); if (py) { F.payer = py.dataset.payer; if (!F.id) F.means = F.lastMeans(F.payer); return drawEntry(); }
    const ct = t.closest('[data-cat]'); if (ct) { F.category = ct.dataset.cat; return drawEntry(); }
    const bd = t.closest('[data-burden]'); if (bd) { F.burden = bd.dataset.burden; drawEntry(); if (F.burden === '割合' && $('eRatio')) $('eRatio').focus(); return; }
    const mn = t.closest('[data-means]'); if (mn) { F.means = mn.dataset.means; return drawEntry(); }
    const dy = t.closest('[data-day]'); if (dy) { F.date = shiftDate(S.today, +dy.dataset.day); return drawEntry(); }
    const sp = t.closest('[data-spayer]'); if (sp) { F.sPayer = sp.dataset.spayer; return drawEntry(); }
    const sm = t.closest('[data-smeans]'); if (sm) { F.sMeans = sm.dataset.smeans; return drawEntry(); }
  }
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'close') { sheet.close(); return; }
  if (a === 'settle') return openEntry(null, 'settle');
  if (a === 'go-settle') return show('settle');
  if (a === 'go-analysis') return show('analysis');
  if (a === 'go-records') return show('records');
  if (a === 'open-settings') return openSettings();
  if (a === 'del-ask') { F.confirmDel = true; return drawEntry(); }
  if (a === 'del-cancel') { F.confirmDel = false; return drawEntry(); }
  if (a === 'del-entry') return API.deleteEntry(F.id, S.month).then(ov => { sheet.close(); apply(ov); toast('削除しました'); }).catch(fail);
  if (a === 'del-settle') return API.deleteSettlement(act.dataset.id, S.month).then(ov => { apply(ov); toast('精算記録を削除しました'); }).catch(fail);
  if (a === 'del-settle-cancel') { $('cf-' + act.dataset.id).innerHTML = ''; return; }
  if (a === 'save-entry') {
    const amount = +F.amount || 0;
    if (!amount) return toast('金額を入れてください', true);
    if (!F.payer) return toast('払った人を選んでください', true);
    if (!F.category) return toast('カテゴリを選んでください', true);
    const burden = F.burden === '割合' ? F.ratio : F.burden;
    if (ratioOf(burden) === null) return toast('割合は「6:4」のように入れてください', true);
    if (!F.date) return toast('日付を選んでください', true);
    const p = { id: F.id, date: F.date, payer: F.payer, amount, category: F.category, content: F.content, burden, means: F.means, memo: F.memo };
    return API.saveEntry(p).then(ov => { store.set('kk_means_' + p.payer, p.means); sheet.close(); apply(ov); toast(F.id ? '保存しました' : `${yen(amount)}円を記録しました`); F = null; }).catch(fail);
  }
  if (a === 'save-settle') {
    const amount = +F.sAmount || 0;
    if (!amount) return toast('金額を入れてください', true);
    const p = { date: F.sDate, month: S.month, payer: F.sPayer, amount, means: F.sMeans, memo: F.sMemo };
    return API.saveSettlement(p).then(ov => { store.set('kk_settle_means', p.means); sheet.close(); apply(ov); toast('精算を記録しました'); F = null; }).catch(fail);
  }
});
$('q').addEventListener('input', e => { S.filter.q = e.target.value; renderRecords(); });

/* ---------- 起動 ---------- */
$('altLogin').addEventListener('click', loginByRedirect);
const startView = ['records', 'analysis', 'settle'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
takeRedirectResult();
API.init().then(r => {
  S.cfg = { names: r.names, categories: r.categories, means: r.means };
  S.today = r.today; S.now = r.now; S.month = r.month;
  $('boot').hidden = true;
  S.user = [r.names.p1, r.names.p2].includes(r.me) ? r.me : null; S.email = r.email || '';
  apply(r); show(startView);
}).catch(e => { $('boot').textContent = '読み込めませんでした。画面を開き直してください。'; fail(e); });
