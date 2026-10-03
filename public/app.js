'use strict';
import { $, $$, reducedMotion, el, nf, fmtNum, fmtYen, fmtRate, okUrl, shortTime, scanDate, confOf, confBadge, profitClass, toast, copyText } from './util.js';
import { openItemDrawer, closeItemDrawer, itemDrawerOpen, shippingNote, exportCsv } from './detail.js';

/* ========== state ========== */
const emptyStats = () => ({ listings: 0, matched: 0, matchedByModel: 0, buybackHits: 0, deepChecked: 0, rankA: 0, rankB: 0, rankC: 0, bestProfit: null });
const state = {
  status: null,
  presets: [],
  masterCategories: [],
  mode: 'genre',
  selectedPresets: new Set(['smartphone']),
  selectedCategories: new Set(),
  deepMode: 'phi',
  deepLimit: 120,
  reverseLimit: 300,
  items: [],
  stats: emptyStats(),
  scanId: null,
  running: false,
  es: null,
  flashKeys: new Set(),
  sort: { key: 'rank', asc: true },
  filters: { rank: 'all', minProfit: '', expense: '', highOnly: true, hideRisk: false, hideCarrier: false, q: '' },
  shown: 200,
  viewingHistory: false,
  warnings: [],
  loginState: null,
  deepResult: false,
};
let itemOpener = null;
function showItem(it) { itemOpener = document.activeElement; openItemDrawer(it); }
function hideItem() { closeItemDrawer(); itemOpener?.focus?.(); itemOpener = null; }

/* ========== api ========== */
async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

/* ========== tooltip (buyback shops) ========== */
const tooltip = $('#tooltip');
function showTooltip(anchor, shops) {
  tooltip.textContent = '';
  tooltip.appendChild(el('div', 'tt-title', '買取価格（全店）'));
  for (const s of shops) {
    const row = el('div', 'tt-row');
    row.appendChild(el('span', null, s.shop));
    row.appendChild(el('span', 'num', fmtYen(s.price)));
    row.appendChild(el('span', 'num', shortTime(s.time)));
    tooltip.appendChild(row);
  }
  const r = anchor.getBoundingClientRect();
  tooltip.hidden = false;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let x = r.left - tw - 8; if (x < 8) x = Math.min(r.right + 8, innerWidth - tw - 8);
  let y = r.top; if (y + th > innerHeight - 8) y = Math.max(8, innerHeight - th - 8);
  tooltip.style.left = `${x}px`; tooltip.style.top = `${y}px`;
}
function hideTooltip() { tooltip.hidden = true; }

/* ========== status pills ========== */
const PILL_INFO = {
  pillYahoo: {
    ok: 'Yahoo検索API: 接続OK',
    bad: 'Yahoo検索API: キー未設定またはエラー',
    unk: 'Yahoo検索API: 状態不明',
  },
  pillPhi: {
    ok: 'Yahoo!のログイン状態を確認できました',
    bad: 'Yahoo!にログインしていません',
    unk: 'Yahoo!のログイン状態は未確認です',
  },
  pillBuyback: {
    ok: '買取トークン: 有効（買取価格を取得できます）',
    bad: '買取トークン: 期限切れ/未取得（hikaku にログインが必要）',
    unk: '買取トークン: 状態不明',
  },
};
function renderPills() {
  const st = state.status;
  const set = (id, kind) => {
    const p = $('#' + id);
    p.classList.remove('ok', 'bad');
    if (kind !== 'unk') p.classList.add(kind === 'ok' ? 'ok' : 'bad');
    p.title = PILL_INFO[id][kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : 'unk'];
  };
  set('pillYahoo', st?.yahooApi === true ? 'ok' : st?.yahooApi === false ? 'bad' : 'unk');
  const login = st?.phi;
  const labels = { premium: 'LYPプレミアム', login: 'ログイン済み', anon: '未ログイン' };
  $('#pillPhi .pill-txt').textContent = `Yahoo!ログイン: ${labels[login] || '未確認'}`;
  set('pillPhi', login === 'premium' || login === 'login' ? 'ok' : login === 'anon' ? 'bad' : 'unk');
  set('pillBuyback', st?.buybackToken === 'ok' ? 'ok' : (st?.buybackToken === 'expired' || st?.buybackToken === 'missing') ? 'bad' : 'unk');
}
function normalizeItem(it) {
  const risks = Array.isArray(it.risks) ? it.risks : [];
  const confidence = it.confidence || (it.matchType === 'jan' && !risks.length ? 'high' : it.matchType === 'jan' || it.matchType === 'model' ? 'mid' : 'low');
  return { ...it, risks, confidence, variants: it.variants ?? 1, shipping: it.shipping ?? { fee: null, free: null }, campaigns: Array.isArray(it.campaigns) ? it.campaigns : [] };
}
function setSummary(summary = {}) {
  state.loginState = summary.loginState || null;
  state.warnings = [...new Set([...state.warnings, ...(Array.isArray(summary.warnings) ? summary.warnings : [])])];
  renderPills(); renderWarning();
}
function renderWarning() {
  const show = state.warnings.length || (state.loginState === 'anon' && (state.stats.deepChecked || state.deepResult));
  $('#warnBand').hidden = !show;
  $('#warnBandText').textContent = ['PhiのDefaultプロファイルでYahoo!にログインすると、ポイントが正しく計算されます。', ...state.warnings].join(' ');
}
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    renderPills();
    if (!state.running && state.status?.running) attachScan(state.status.running);
  } catch { renderPills(); }
}

/* ========== chips ========== */
function chip(label, on, onClick, extra) {
  const c = el('button', `chip${on ? ' on' : ''}`, label);
  c.type = 'button';
  if (extra) c.appendChild(el('span', 'cnt', extra));
  c.addEventListener('click', onClick);
  return c;
}
function renderChips() {
  const mk = host => {
    host.textContent = '';
    for (const p of state.presets) {
      host.appendChild(chip(p.label, state.selectedPresets.has(p.id), () => {
        state.selectedPresets.has(p.id) ? state.selectedPresets.delete(p.id) : state.selectedPresets.add(p.id);
        renderChips(); updateEstimate();
      }));
    }
    if (!state.presets.length) host.appendChild(el('span', 'chips-loading', 'プリセットを取得できませんでした'));
  };
  mk($('#presetChips'));
  mk($('#presetChipsKw'));
  const mh = $('#masterChips');
  mh.textContent = '';
  for (const c of state.masterCategories) {
    mh.appendChild(chip(c.name, state.selectedCategories.has(c.name), () => {
      state.selectedCategories.has(c.name) ? state.selectedCategories.delete(c.name) : state.selectedCategories.add(c.name);
      renderChips(); updateEstimate();
    }, fmtNum(c.count)));
  }
  if (!state.masterCategories.length) mh.appendChild(el('span', 'chips-loading', 'カテゴリを取得できませんでした'));
}

/* ========== mode & params ========== */
function setMode(mode) {
  state.mode = mode;
  $$('.settings .segment .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $$('.mode-pane').forEach(p => p.classList.toggle('hidden', p.dataset.mode !== mode));
  updateEstimate();
}
function numInput(id) {
  const v = $(id).value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function buildParams() {
  const p = {
    mode: state.mode,
    priceFrom: numInput('#priceFromInput'),
    priceTo: numInput('#priceToInput'),
    deepCheck: state.deepMode,
    deepLimit: state.deepLimit,
  };
  if (state.mode === 'genre') {
    p.presets = [...state.selectedPresets];
    if (!p.presets.length) throw new Error('ジャンルプリセットを1つ以上選んでください');
  } else if (state.mode === 'keyword') {
    p.keyword = $('#kwInput').value.trim();
    p.sellerId = $('#sellerInput').value.trim();
    if (!p.keyword && !p.sellerId) throw new Error('キーワードかストアIDを入力してください');
    if (state.selectedPresets.size) p.presets = [...state.selectedPresets];
  } else {
    p.masterCategories = [...state.selectedCategories];
    if (!p.masterCategories.length) throw new Error('カテゴリを1つ以上選んでください');
    p.minBuyback = numInput('#minBuybackInput') ?? 20000;
    p.reverseLimit = state.reverseLimit;
  }
  return p;
}
function updateEstimate() {
  const deep = state.deepMode !== 'off' ? `。商品ページの確認は最大${fmtNum(state.deepLimit)}件` : '。商品ページの確認はオフ';
  let base;
  if (state.mode === 'genre') {
    const n = Math.max(1, state.selectedPresets.size);
    base = `ジャンル${state.selectedPresets.size || 1}つで約${2 * n}〜${4 * n}分`;
  } else if (state.mode === 'keyword') {
    base = '検索は件数次第で約1〜5分';
  } else {
    base = `${fmtNum(state.reverseLimit)}件のJANを調べる場合、検索だけで約${Math.ceil(state.reverseLimit * 1.3 / 60)}分（1件あたり約1.3秒）`;
  }
  $('#estimateNote').textContent = `所要時間の目安: ${base}${deep}。`;
}

/* ========== KPI ========== */
const kpiEls = {
  listings: $('#kpiListings'), matched: $('#kpiMatched'), matchedByModel: $('#kpiMatchedModel'),
  rankA: $('#kpiA'), rankB: $('#kpiB'), bestProfit: $('#kpiBest'), deepChecked: $('#kpiDeep'),
};
function animateNum(node, to, fmt) {
  const from = node._v ?? 0;
  node._v = to ?? 0;
  if (reducedMotion || from === to || to == null) { node.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 550;
  const tick = t => {
    const k = Math.min(1, (t - t0) / dur);
    node.textContent = fmt(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function renderKpis() {
  const s = state.stats;
  animateNum(kpiEls.listings, s.listings ?? 0, fmtNum);
  animateNum(kpiEls.matched, s.matched ?? 0, fmtNum);
  animateNum(kpiEls.matchedByModel, s.matchedByModel ?? 0, fmtNum);
  animateNum(kpiEls.rankA, s.rankA ?? 0, fmtNum);
  animateNum(kpiEls.rankB, s.rankB ?? 0, fmtNum);
  animateNum(kpiEls.deepChecked, s.deepChecked ?? 0, fmtNum);
  kpiEls.bestProfit.textContent = fmtYen(s.bestProfit, true);
  kpiEls.bestProfit.className = `kpi-val num ${s.bestProfit > 0 ? 'pos' : s.bestProfit < 0 ? 'neg' : ''}`;
}

/* ========== progress ========== */
const STAGES = ['search', 'match', 'buyback', 'deep', 'save'];
function renderProgress(d) {
  $('#progressPanel').hidden = false;
  const idx = STAGES.indexOf(d.stage);
  $$('#steps .step').forEach(li => {
    const i = STAGES.indexOf(li.dataset.stage);
    li.classList.toggle('done', i < idx || d.stage === 'done');
    li.classList.toggle('active', i === idx && d.stage !== 'done');
  });
  if (d.stage === 'done') $$('#steps .step').forEach(li => { li.classList.add('done'); li.classList.remove('active'); });
  const pct = d.stage === 'done' ? 100 : Math.min(99, Math.round(((Math.max(0, idx) + (d.total ? Math.min(1, d.done / d.total) : 0)) / STAGES.length) * 100));
  $('#pbarFill').style.width = `${pct}%`;
  $('#pmsg').textContent = d.message || '';
}
function markAllDone(msg) {
  renderProgress({ stage: 'done', message: msg, done: 1, total: 1 });
}

/* ========== badges ========== */
function badgesOf(it) {
  const f = it.flags || {};
  const out = [];
  if (f.premiumDeal) out.push(['プレミアム特価', 'deal']);
  if (f.priceDrop?.delta) out.push([`値下げ −¥${nf.format(Math.abs(Math.round(f.priceDrop.delta)))}`, 'drop']);
  if (f.isNew) out.push(['新着', 'new']);
  if (f.coupon) out.push(['クーポン', '']);
  if (f.bonusPlus) out.push(['ボーナスストア+', '']);
  if (f.maxPurchase) out.push([`お一人様${f.maxPurchase}点`, '']);
  if (it.matchType === 'model') out.push(['型番照合', 'model']);
  if (it.variants > 1) out.push([`×${fmtNum(it.variants)}出品`, '']);
  for (const r of it.risks || []) out.push([`⚠ ${r}`, 'warn']);
  return out;
}
function badgeRow(it) {
  const box = el('div', 'badges');
  for (const [txt, cls] of badgesOf(it)) box.appendChild(el('span', `badge ${cls}`.trim(), txt));
  return box;
}

/* ========== view (filter + expense adjust + sort) ========== */
const RANK_ORD = { A: 0, B: 1, C: 2, '-': 3 };
function adjusted(it) {
  const cost = Number(state.filters.expense) || 0;
  if (!cost || it.rank === '-' || !it.profit) return it;
  const pc = it.profit.conservative == null ? null : it.profit.conservative - cost;
  const pm = it.profit.max == null ? null : it.profit.max - cost;
  const eff = it.effective
    ? { conservative: (it.effective.conservative ?? 0) + cost, max: (it.effective.max ?? 0) + cost }
    : it.effective;
  return {
    ...it,
    profit: { conservative: pc, max: pm },
    effective: eff,
    profitRate: eff?.max && pm != null ? (pm / eff.max) * 100 : it.profitRate,
    rank: pc == null || pm == null ? it.rank : pc > 0 ? 'A' : pm > 0 ? 'B' : 'C',
  };
}
function getView() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  let list = state.items.map(adjusted).filter(it => {
    if (f.rank === 'near' ? !(it.rank === 'C' && it.profit?.max >= -3000) : f.rank !== 'all' && it.rank !== f.rank) return false;
    if (f.highOnly && confOf(it) !== 'high') return false;
    const minP = Number(f.minProfit);
    if (f.minProfit !== '' && Number.isFinite(minP) && !((it.profit?.max ?? -Infinity) >= minP)) return false;
    if (f.hideRisk && (it.risks || []).length) return false;
    if (f.hideCarrier && (it.risks || []).some(r => r.includes('キャリア'))) return false;
    if (q && ![it.name, it.masterName, it.sellerName, it.sellerId, it.jan].some(v => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  });
  const { key, asc } = state.sort;
  const dir = asc ? 1 : -1;
  const val = it => ({
    name: it.name || '', rank: RANK_ORD[it.rank] ?? 9,
    profit: it.profit?.max ?? -Infinity, rate: it.profitRate ?? -Infinity,
    effective: it.effective?.max ?? Infinity, price: it.basePrice ?? Infinity,
    buyback: it.buyback?.max ?? -Infinity,
  }[key]);
  list.sort((a, b) => {
    if (key === 'rank') {
      const d = (RANK_ORD[a.rank] ?? 9) - (RANK_ORD[b.rank] ?? 9);
      if (d) return asc ? d : -d;
      return (b.profit?.max ?? -Infinity) - (a.profit?.max ?? -Infinity);
    }
    const va = val(a), vb = val(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return (b.profit?.max ?? -Infinity) - (a.profit?.max ?? -Infinity);
  });
  return list;
}

/* ========== table render ========== */
function makeRow(it) {
  const tr = el('tr');
  tr.tabIndex = 0;
  tr.setAttribute('role', 'button');
  tr.setAttribute('aria-label', `${it.name || '商品'}の詳細を開く`);
  tr.addEventListener('click', e => { if (!e.target.closest('a, button')) showItem(it); });
  tr.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.closest('a, button')) { e.preventDefault(); showItem(it); } });
  tr.dataset.key = it.key || '';
  if (state.flashKeys.has(it.key)) { tr.classList.add('flash'); state.flashKeys.delete(it.key); }

  const tdImg = el('td');
  const img = el('img', 'pimg');
  img.width = 48; img.height = 48; img.loading = 'lazy'; img.alt = '';
  const src = okUrl(it.image);
  if (src) img.src = src;
  tdImg.appendChild(img);
  tr.appendChild(tdImg);

  const tdName = el('td');
  tdName.appendChild(el('div', 'pname', it.name || ''));
  const meta = [];
  if (it.masterName) meta.push(it.masterName);
  tdName.appendChild(el('div', 'pmeta', meta.join(' / ') || ''));
  const meta2 = el('div', 'pmeta');
  meta2.appendChild(document.createTextNode(`${it.sellerName || it.sellerId || ''} `));
  if (it.sellerRating != null) meta2.appendChild(el('span', 'pstar', `★${Number(it.sellerRating).toFixed(1)}`));
  tdName.appendChild(meta2);
  tr.appendChild(tdName);

  const tdRank = el('td');
  tdRank.appendChild(el('span', `rank-badge ${it.rank || '-'}`, it.rank || '-'));
  tdRank.appendChild(confBadge(it));
  tr.appendChild(tdRank);

  const tdProfit = el('td', 'numc c-profit');
  tdProfit.appendChild(el('div', `v-big ${profitClass(it.profit?.max)}`, fmtYen(it.profit?.max, true)));
  tdProfit.appendChild(el('div', `v-sub ${profitClass(it.profit?.conservative)}`, `確実 ${fmtYen(it.profit?.conservative, true)}`));
  if (it.rank === 'C' && it.profit?.max != null && it.profit.max <= 0)
    tdProfit.appendChild(el('span', 'shortfall', `黒字まで あと ${fmtYen(-it.profit.max)}`));
  tr.appendChild(tdProfit);

  const tdRate = el('td', 'numc', fmtRate(it.profitRate));
  tr.appendChild(tdRate);

  const tdEff = el('td', 'numc');
  tdEff.appendChild(el('div', null, fmtYen(it.effective?.max)));
  tdEff.appendChild(el('div', 'v-sub', `確実 ${fmtYen(it.effective?.conservative)}`));
  if (shippingNote(it)) tdEff.appendChild(el('div', 'v-sub', shippingNote(it)));
  tr.appendChild(tdEff);

  const tdPrice = el('td', 'numc');
  if (it.flags?.premiumDeal && it.price != null && it.basePrice != null && it.basePrice < it.price)
    tdPrice.appendChild(el('span', 'strike', fmtYen(it.price)));
  tdPrice.appendChild(el('div', 'v-big', fmtYen(it.basePrice ?? it.price)));
  tr.appendChild(tdPrice);

  const tdPoint = el('td', 'numc');
  tdPoint.appendChild(el('div', null, fmtNum(it.point?.max)));
  const sub = el('div', 'v-sub', `確実 ${fmtNum(it.point?.conservative)}`);
  if (it.point?.source === 'api') { sub.appendChild(document.createTextNode(' ')); sub.appendChild(el('span', 'est-tag', '推定')); }
  tdPoint.appendChild(sub);
  tr.appendChild(tdPoint);

  const tdBuy = el('td', 'numc buy-cell');
  if (it.buyback?.max != null) {
    tdBuy.appendChild(el('div', 'v-big', fmtYen(it.buyback.max)));
    tdBuy.appendChild(el('span', 'buy-shop', it.buyback.shop || ''));
    tdBuy.appendChild(el('span', 'buy-time', shortTime(it.buyback.time)));
    const shops = it.buyback.shops;
    if (shops?.length > 1) {
      tdBuy.tabIndex = 0;
      tdBuy.addEventListener('mouseenter', () => showTooltip(tdBuy, shops));
      tdBuy.addEventListener('focus', () => showTooltip(tdBuy, shops));
      tdBuy.addEventListener('mouseleave', hideTooltip);
      tdBuy.addEventListener('blur', hideTooltip);
    }
  } else {
    tdBuy.appendChild(el('div', 'v-sub', '—'));
  }
  tr.appendChild(tdBuy);

  const tdBadges = el('td');
  tdBadges.appendChild(badgeRow(it));
  tr.appendChild(tdBadges);

  const tdOps = el('td');
  const ops = el('div', 'ops');
  const href = okUrl(it.url);
  if (href) {
    const a = el('a', 'op-btn', 'Yahoo');
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    ops.appendChild(a);
  }
  if (it.jan) {
    const b = el('button', 'op-btn', 'JAN');
    b.type = 'button';
    b.addEventListener('click', () => copyText(it.jan, 'JANをコピーしました'));
    ops.appendChild(b);
  }
  tdOps.appendChild(ops);
  tr.appendChild(tdOps);

  return tr;
}

function makeCard(it) {
  const c = el('div', 'mcard');
  c.tabIndex = 0;
  c.setAttribute('role', 'button');
  c.setAttribute('aria-label', `${it.name || '商品'}の詳細を開く`);
  c.addEventListener('click', e => { if (!e.target.closest('a, button')) showItem(it); });
  c.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.closest('a, button')) { e.preventDefault(); showItem(it); } });
  const head = el('div', 'mc-head');
  const img = el('img', 'pimg');
  img.width = 48; img.height = 48; img.loading = 'lazy'; img.alt = '';
  const src = okUrl(it.image); if (src) img.src = src;
  head.appendChild(img);
  const mid = el('div');
  mid.appendChild(el('div', 'pname', it.name || ''));
  mid.appendChild(el('div', 'pmeta', it.sellerName || it.sellerId || ''));
  head.appendChild(mid);
  head.appendChild(el('span', `rank-badge ${it.rank || '-'}`, it.rank || '-'));
  c.appendChild(head);
  c.appendChild(confBadge(it));

  const body = el('div', 'mc-body num');
  const cell = (k, v, cls = '') => { const d = el('div'); d.appendChild(el('div', `k`, k)); const vv = el('div', cls, v); body.appendChild(d); body.appendChild(vv); };
  cell('利益(最大)', fmtYen(it.profit?.max, true), `v-big ${profitClass(it.profit?.max)}`);
  cell('利益(確実)', fmtYen(it.profit?.conservative, true), profitClass(it.profit?.conservative));
  cell('利益率', fmtRate(it.profitRate));
  cell('実質(最大)', fmtYen(it.effective?.max));
  if (shippingNote(it)) cell('送料', '送料込み');
  cell('Yahoo価格', fmtYen(it.basePrice ?? it.price));
  cell('買取最高', it.buyback?.max != null ? `${fmtYen(it.buyback.max)} ${it.buyback.shop || ''}` : '—');
  c.appendChild(body);
  if (it.rank === 'C' && it.profit?.max != null && it.profit.max <= 0)
    c.appendChild(el('span', 'shortfall', `黒字まで あと ${fmtYen(-it.profit.max)}`));

  const foot = el('div', 'mc-foot');
  foot.appendChild(badgeRow(it));
  const ops = el('div', 'ops');
  const href = okUrl(it.url);
  if (href) { const a = el('a', 'op-btn', 'Yahoo'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; ops.appendChild(a); }
  if (it.jan) { const b = el('button', 'op-btn', 'JAN'); b.type = 'button'; b.addEventListener('click', () => copyText(it.jan, 'JANをコピーしました')); ops.appendChild(b); }
  foot.appendChild(ops);
  c.appendChild(foot);
  return c;
}

/* ========== highlights ========== */
function renderHighlights() {
  const row = $('#hlRow');
  row.textContent = '';
  const top = getView()
    .filter(it => it.rank === 'A' || it.rank === 'B')
    .sort((a, b) => (b.profit?.max ?? -Infinity) - (a.profit?.max ?? -Infinity))
    .slice(0, 6);
  $('#hlEmpty').hidden = top.length > 0;
  for (const it of top) {
    const card = el('div', `hl-card${it.rank === 'A' ? ' top' : ''}`);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.addEventListener('click', () => showItem(it));
    card.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); showItem(it); } });
    const head = el('div', 'hl-head');
    const img = el('img', 'hl-img');
    img.width = 52; img.height = 52; img.loading = 'lazy'; img.alt = '';
    const src = okUrl(it.image); if (src) img.src = src;
    head.appendChild(img);
    const nm = el('div');
    nm.appendChild(el('div', 'hl-name', it.name || ''));
    nm.appendChild(el('div', 'hl-store', `${it.sellerName || it.sellerId || ''}${it.sellerRating != null ? ` ★${Number(it.sellerRating).toFixed(1)}` : ''}`));
    head.appendChild(nm);
    head.appendChild(el('span', `rank-badge ${it.rank}`, it.rank));
    card.appendChild(head);

    card.appendChild(el('div', `hl-profit num ${profitClass(it.profit?.max)}`, fmtYen(it.profit?.max, true)));
    const s1 = el('div', 'hl-sub');
    s1.appendChild(el('span', null, `確実 ${fmtYen(it.profit?.conservative, true)}`));
    s1.appendChild(el('b', null, fmtRate(it.profitRate)));
    card.appendChild(s1);
    const s2 = el('div', 'hl-sub');
    s2.appendChild(el('span', null, `実質 ${fmtYen(it.effective?.max)}`));
    s2.appendChild(el('b', null, it.buyback?.max != null ? `買取 ${fmtYen(it.buyback.max)}` : '買取 —'));
    card.appendChild(s2);
    if (it.buyback?.shop) card.appendChild(el('div', 'hl-sub', `${it.buyback.shop} ${shortTime(it.buyback.time)}`));
    card.appendChild(badgeRow(it));
    row.appendChild(card);
  }
}

/* ========== main render ========== */
function render() {
  const view = getView();
  const shown = view.slice(0, state.shown);
  const tbody = $('#tbody');
  tbody.textContent = '';
  for (const it of shown) tbody.appendChild(makeRow(it));

  const cards = $('#cardList');
  cards.textContent = '';
  for (const it of shown) cards.appendChild(makeCard(it));

  const emptyEl = $('#tableEmpty');
  if (!view.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = '';
    if (!state.items.length) {
      emptyEl.appendChild(el('span', 'big', state.running ? 'スキャン中…' : 'まだ結果がありません'));
      emptyEl.appendChild(document.createTextNode(state.running ? '商品を調べ終えるとここに表示されます。' : '設定からスキャンを開始するか、履歴から読み込んでください。'));
    } else {
      emptyEl.appendChild(el('span', 'big', '条件に合う商品がありません'));
      emptyEl.appendChild(document.createTextNode('絞り込み条件をゆるめてみてください。'));
    }
  } else emptyEl.hidden = true;
  cards.classList.toggle('empty', !view.length);
  if (!view.length) cards.appendChild(el('p', 'card-empty', emptyEl.textContent));

  $('#moreBtn').hidden = view.length <= state.shown;
  $('#fCount').textContent = `${fmtNum(view.length)}件表示中 / 全${fmtNum(state.items.length)}件`;
  renderHighlights();
}

/* ========== scan control ========== */
function setRunning(on) {
  state.running = on;
  document.body.classList.toggle('scanning', on);
  const b = $('#scanBtn');
  b.textContent = on ? '停止' : 'スキャン開始';
  b.classList.toggle('stop', on);
}
async function startScan() {
  let params;
  try { params = buildParams(); } catch (e) { toast(e.message, 'err'); return; }
  try {
    const r = await api('/api/scans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
    state.items = [];
    state.stats = emptyStats();
    state.seenAB = new Set();
    state.viewingHistory = false;
    state.warnings = [];
    state.deepResult = state.deepMode !== 'off';
    setSummary();
    renderKpis(); render();
    attachScan(r.id);
  } catch (e) {
    toast(`スキャンを開始できません: ${e.message}`, 'err');
  }
}
async function cancelScan() {
  if (!state.scanId) return;
  try { await api(`/api/scans/${state.scanId}/cancel`, { method: 'POST' }); }
  catch (e) { toast(`停止できません: ${e.message}`, 'err'); }
}
function attachScan(id) {
  if (state.es) state.es.close();
  state.scanId = id;
  setRunning(true);
  $('#progressPanel').hidden = false;
  renderProgress({ stage: 'search', message: '接続中…', done: 0, total: 0 });

  const es = new EventSource(`/api/scans/${encodeURIComponent(id)}/events`);
  state.es = es;
  es.addEventListener('progress', e => {
    const d = JSON.parse(e.data);
    if (d.stats) { state.stats = { ...state.stats, ...d.stats }; renderKpis(); }
    renderProgress(d);
  });
  es.addEventListener('items', e => {
    const d = JSON.parse(e.data);
    const prev = state.seenAB || new Set();
    for (const it of d.items || []) {
      if ((it.rank === 'A' || it.rank === 'B') && !prev.has(it.key)) {
        state.flashKeys.add(it.key);
        prev.add(it.key);
      }
    }
    state.seenAB = prev;
    state.items = (d.items || []).map(normalizeItem);
    render();
  });
  es.addEventListener('warning', e => {
    try {
      const warning = JSON.parse(e.data);
      if (warning.message) state.warnings.push(String(warning.message));
    } catch { state.warnings.push('ポイントの確認で注意が必要です。'); }
    renderWarning();
  });
  es.addEventListener('done', e => {
    const d = JSON.parse(e.data);
    es.close(); state.es = null;
    setRunning(false);
    if (d.summary) { state.stats = { ...state.stats, ...d.summary }; renderKpis(); }
    setSummary(d.summary);
    markAllDone(d.status === 'cancelled' ? '停止しました（途中までの結果を保存）' : `完了（${d.summary?.durationSec ?? '—'}秒）`);
    loadScan(d.id || id, { silent: true });
  });
  es.addEventListener('error', e => {
    if (e.data) { // server-sent error event
      try { const d = JSON.parse(e.data); toast(`エラー: ${d.message}`, 'err'); } catch { toast('スキャンでエラーが発生しました', 'err'); }
      es.close(); state.es = null; setRunning(false);
      markAllDone('エラーで終了しました');
    } else if (state.running) {
      toast('進捗の接続が切れました。結果は履歴から確認できます。', 'err');
      setRunning(false);
    }
  });
}

/* ========== history ========== */
async function loadScan(id, { silent = false } = {}) {
  try {
    const d = await api(`/api/scans/${encodeURIComponent(id)}`);
    state.items = (d.items || []).map(normalizeItem);
    state.stats = { ...emptyStats(), ...(d.summary || {}) };
    state.warnings = [];
    state.deepResult = d.params?.deepCheck !== 'off' && !!d.params?.deepCheck;
    setSummary(d.summary);
    state.scanId = d.id;
    state.viewingHistory = true;
    renderKpis(); render();
    if (!silent) toast(`スキャン ${scanDate(d.id)} を表示中`, 'ok');
  } catch (e) { if (!silent) toast(`読み込めません: ${e.message}`, 'err'); }
}
const MODE_LABEL = { genre: 'ジャンル巡回', keyword: 'キーワード・ストア', reverse: '逆引き' };
function paramsLabel(p = {}) {
  if (p.mode === 'genre') {
    const names = (p.presets || []).map(id => state.presets.find(x => x.id === id)?.label || id);
    return names.join('・') || '—';
  }
  if (p.mode === 'keyword') return [p.keyword && `「${p.keyword}」`, p.sellerId && `ストア:${p.sellerId}`].filter(Boolean).join(' ') || '—';
  return (p.masterCategories || []).join('・') || '—';
}
async function renderHistory() {
  const host = $('#historyList');
  host.textContent = '';
  host.appendChild(el('p', 'chips-loading', '読み込み中…'));
  try {
    const d = await api('/api/scans');
    host.textContent = '';
    if (!d.scans?.length) { host.appendChild(el('p', 'chips-loading', 'まだスキャン履歴がありません')); return; }
    for (const s of d.scans) {
      const item = el('div', 'hist-item');
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      const top = el('div', 'hist-top');
      top.appendChild(el('span', 'hist-date', scanDate(s.id)));
      top.appendChild(el('span', 'hist-mode', MODE_LABEL[s.params?.mode] || s.params?.mode || 'スキャン'));
      item.appendChild(top);
      item.appendChild(el('div', 'hist-sub', paramsLabel(s.params)));
      const st = el('div', 'hist-stats');
      const sum = s.summary || {};
      st.appendChild(el('span', null, `A:${fmtNum(sum.rankA ?? 0)}`));
      st.appendChild(el('span', null, `B:${fmtNum(sum.rankB ?? 0)}`));
      st.appendChild(el('span', 'num', `最高 ${fmtYen(sum.bestProfit, true)}`));
      st.appendChild(el('span', 'hist-status', s.status === 'done' ? '' : s.status || ''));
      const del = el('button', 'hist-del', '削除');
      del.type = 'button';
      del.addEventListener('click', async ev => {
        ev.stopPropagation();
        if (!confirm(`スキャン ${scanDate(s.id)} を削除しますか？`)) return;
        try { await api(`/api/scans/${encodeURIComponent(s.id)}`, { method: 'DELETE' }); renderHistory(); }
        catch (e) { toast(`削除できません: ${e.message}`, 'err'); }
      });
      st.appendChild(del);
      item.appendChild(st);
      item.addEventListener('click', () => { loadScan(s.id); closeDrawer(); });
      item.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === item) { e.preventDefault(); loadScan(s.id); closeDrawer(); } });
      host.appendChild(item);
    }
  } catch (e) {
    host.textContent = '';
    host.appendChild(el('p', 'chips-loading', `履歴を取得できません: ${e.message}`));
  }
}
function openDrawer() {
  $('#drawerBackdrop').hidden = false;
  const d = $('#historyDrawer');
  d.hidden = false;
  requestAnimationFrame(() => d.classList.add('open'));
  $('#drawerClose').focus();
  renderHistory();
}
function closeDrawer() {
  const d = $('#historyDrawer');
  if (d.hidden) return;
  d.classList.remove('open');
  if (!itemDrawerOpen()) $('#drawerBackdrop').hidden = true;
  setTimeout(() => { d.hidden = true; }, 260);
  $('#historyBtn').focus();
}

/* ========== filters ========== */
const FILTER_KEY = 'ypr.filters.v1';
function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) { const old = JSON.parse(raw); Object.assign(state.filters, old); if (!Object.hasOwn(old, 'highOnly')) state.filters.highOnly = true; }
  } catch { /* ignore */ }
}
function saveFilters() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters)); } catch { /* ignore */ }
}
function bindFilters() {
  const f = state.filters;
  $$('#filterBar .seg-mini .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.rank === f.rank);
    b.addEventListener('click', () => {
      f.rank = b.dataset.rank;
      $$('#filterBar .seg-mini .seg-btn').forEach(x => x.classList.toggle('active', x === b));
      state.shown = 200; saveFilters(); render();
    });
  });
  const bind = (id, key) => {
    const n = $(id);
    if (n.type === 'checkbox') n.checked = !!f[key]; else n.value = f[key] ?? '';
    n.addEventListener('input', () => {
      f[key] = n.type === 'checkbox' ? n.checked : n.value;
      state.shown = 200; saveFilters(); render();
    });
  };
  bind('#fMinProfit', 'minProfit');
  bind('#fExpense', 'expense');
  bind('#fHighOnly', 'highOnly');
  bind('#fHideRisk', 'hideRisk');
  bind('#fHideCarrier', 'hideCarrier');
  bind('#fQuery', 'q');
}

/* ========== sort ========== */
function bindSort() {
  $$('.rtable th.sortable').forEach(th => {
    th.tabIndex = 0;
    const sort = () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.asc = !state.sort.asc;
      else state.sort = { key, asc: key === 'name' || key === 'rank' };
      updateSortHeads(); render();
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', e => { if (e.key === 'Enter') sort(); });
  });
  updateSortHeads();
}
function updateSortHeads() {
  $$('.rtable th.sortable').forEach(th => {
    th.classList.toggle('asc', th.dataset.sort === state.sort.key && state.sort.asc);
    th.classList.toggle('desc', th.dataset.sort === state.sort.key && !state.sort.asc);
  });
}

/* ========== events ========== */
function bindUI() {
  $$('.settings .segment .seg-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#presetAllBtn').addEventListener('click', () => {
    state.presets.forEach(p => state.selectedPresets.add(p.id));
    renderChips(); updateEstimate();
  });
  const deepToggle = $('#deepToggle'), deepSel = $('#deepModeSel');
  deepToggle.addEventListener('change', () => {
    state.deepMode = deepToggle.checked ? 'phi' : 'off';
    deepSel.value = state.deepMode; updateEstimate();
  });
  deepSel.addEventListener('change', () => {
    state.deepMode = deepSel.value;
    deepToggle.checked = state.deepMode !== 'off';
    updateEstimate();
  });
  $('#deepLimitInput').addEventListener('input', e => {
    state.deepLimit = Number(e.target.value);
    $('#deepLimitVal').textContent = fmtNum(state.deepLimit);
    updateEstimate();
  });
  $('#reverseLimitInput').addEventListener('input', e => {
    state.reverseLimit = Number(e.target.value);
    $('#reverseLimitVal').textContent = fmtNum(state.reverseLimit);
    updateEstimate();
  });
  $('#scanBtn').addEventListener('click', () => state.running ? cancelScan() : startScan());
  $('#historyBtn').addEventListener('click', openDrawer);
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#itemDrawerClose').addEventListener('click', hideItem);
  $('#drawerBackdrop').addEventListener('click', () => itemDrawerOpen() ? hideItem() : closeDrawer());
  $('#warnBandClose').addEventListener('click', () => { $('#warnBand').hidden = true; });
  $('#csvBtn').addEventListener('click', () => {
    const rows = getView().slice(0, state.shown);
    if (!rows.length) { toast('書き出す商品がありません', 'err'); return; }
    exportCsv(rows, state.scanId);
  });
  $('#moreBtn').addEventListener('click', () => { state.shown += 200; render(); });
  $('#settingsToggle').addEventListener('click', () => {
    const p = $('#settingsPanel');
    p.classList.toggle('collapsed');
    $('#settingsToggle').setAttribute('aria-expanded', String(!p.classList.contains('collapsed')));
    $('#settingsToggle').textContent = p.classList.contains('collapsed') ? '設定を開く' : '設定を閉じる';
  });
  document.addEventListener('keydown', e => {
    const drawer = itemDrawerOpen() ? $('#itemDrawer') : !$('#historyDrawer').hidden ? $('#historyDrawer') : null;
    if (e.key === 'Escape') { if (itemDrawerOpen()) hideItem(); else closeDrawer(); hideTooltip(); }
    if (e.key === 'Tab' && drawer) {
      const focusable = $$('button:not([disabled]), a[href], input:not([disabled])', drawer);
      if (!focusable.length) return;
      if (e.shiftKey && document.activeElement === focusable[0]) { e.preventDefault(); focusable.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === focusable.at(-1)) { e.preventDefault(); focusable[0].focus(); }
    }
  });
  addEventListener('scroll', hideTooltip, { passive: true });
  const narrow = matchMedia('(max-width: 900px)');
  const fitSettings = () => {
    $('#settingsPanel').classList.toggle('collapsed', narrow.matches);
    $('#settingsToggle').setAttribute('aria-expanded', String(!narrow.matches));
    $('#settingsToggle').textContent = narrow.matches ? '設定を開く' : '設定を閉じる';
  };
  fitSettings();
  narrow.addEventListener('change', fitSettings);
}

/* ========== init ========== */
async function init() {
  loadFilters();
  bindUI(); bindFilters(); bindSort();
  updateEstimate(); renderPills(); render();
  const [st, pr, sc] = await Promise.allSettled([api('/api/status'), api('/api/presets'), api('/api/scans')]);
  if (st.status === 'fulfilled') { state.status = st.value; renderPills(); } else renderPills();
  if (pr.status === 'fulfilled') {
    state.presets = pr.value.presets || [];
    state.masterCategories = pr.value.masterCategories || [];
    renderChips(); updateEstimate();
  } else renderChips();
  if (sc.status === 'fulfilled' && sc.value.scans?.length && !state.status?.running) {
    loadScan(sc.value.scans[0].id, { silent: true });
  }
  if (state.status?.running) attachScan(state.status.running);
  setInterval(refreshStatus, 30000);
}
init();
