'use strict';

import {
  $, el, nf, fmtNum, fmtYen, fmtRate, okUrl, shortTime, scanDate,
  confOf, CONF_LABEL, confBadge, profitClass, copyText,
} from './util.js';

const HIKAKU_URL = 'https://hikaku-342505.firebaseapp.com/search/';

/* ========== risk descriptions ========== */
const RISK_INFO = [
  [/海外版/, '海外向けモデルの可能性があります。日本での保証・対応周波数・技適を確認してください。'],
  [/送料別/, '送料が表示価格に含まれていない可能性があります。支払い総額が増える場合があります。'],
  [/ポイント上限/, 'ポイントの付与上限に達しているため、実際の還元は表示より少なくなる可能性があります。'],
  [/型番照合/, 'JANコードではなく型番で照合しました。容量・色違いの別モデルの可能性があります。'],
  [/キャリア/, 'キャリア版は買取価格が下がる・対象外になる場合があります。SIMフリー版か確認してください。'],
  [/中古|整備|再生/, '新品ではない可能性があります。買取価格は新品が前提の場合が多いため注意してください。'],
  [/価格が安すぎる/, '相場より大幅に安いため、商品状態や出品内容を必ず確認してください。'],
];
const riskDesc = r => (RISK_INFO.find(([re]) => re.test(r)) || [])[1]
  || '商品ページで内容を確認してください。';

/* ========== shipping ========== */
export function shippingText(it) {
  const s = it.shipping;
  if (!s) return null;
  if (s.fee != null && s.fee > 0) return `+${fmtYen(s.fee)}`;
  if (s.fee === 0 || s.free === true) return '無料';
  return '未確認';
}
// 一覧の実質価格の下に出す小さな注記（送料がかかる時だけ）
export function shippingNote(it) {
  const s = it.shipping;
  return s && s.fee != null && s.fee !== 0 ? '送料込み' : null;
}

/* ========== item drawer ========== */
function flowStep(label, value, note) {
  const row = el('div', 'flow-step');
  const head = el('div', 'flow-head');
  head.appendChild(el('span', 'flow-label', label));
  head.appendChild(value);
  row.appendChild(head);
  if (note) row.appendChild(note);
  return row;
}
const flowArrow = () => el('div', 'flow-arrow', '↓');

function campaignsNode(it) {
  const wrap = el('div', 'flow-campaigns');
  const camps = Array.isArray(it.campaigns) ? it.campaigns : [];
  if (!camps.length) {
    wrap.appendChild(el('div', 'flow-note', '内訳は取得できていません（確実・最大はストアの表示ベース）'));
  }
  for (const c of camps) {
    const row = el('div', 'camp-row');
    const name = el('span', 'camp-name', c.title || 'キャンペーン');
    if (c.conditional) name.appendChild(el('span', 'camp-tag cond', '条件つき'));
    if (c.reachedLimit) name.appendChild(el('span', 'camp-tag limit', '上限到達'));
    row.appendChild(name);
    const val = el('span', `camp-val num ${c.reachedLimit ? 'limit' : ''}`.trim());
    val.textContent = `+${fmtNum(c.point)}pt`;
    if (c.ratio != null) val.appendChild(el('span', 'camp-ratio', `（${c.ratio}%）`));
    row.appendChild(val);
    wrap.appendChild(row);
  }
  if (it.point?.payMethodText)
    wrap.appendChild(el('div', 'flow-note', `※ ${it.point.payMethodText}で支払った場合のポイントです`));
  return wrap;
}

function buybackBars(shops) {
  const box = el('div', 'bb-list');
  const sorted = [...shops].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  const top = sorted[0]?.price || 1;
  for (const s of sorted) {
    const row = el('div', 'bb-row');
    row.appendChild(el('span', 'bb-shop', s.shop || '—'));
    const barWrap = el('span', 'bb-barwrap');
    const bar = el('span', 'bb-bar');
    bar.style.width = `${Math.max(4, Math.round(((s.price ?? 0) / top) * 100))}%`;
    barWrap.appendChild(bar);
    row.appendChild(barWrap);
    row.appendChild(el('span', 'bb-price num', fmtYen(s.price)));
    row.appendChild(el('span', 'bb-time num', shortTime(s.time)));
    box.appendChild(row);
  }
  return box;
}

function buildDetail(it) {
  const host = $('#itemDetail');
  host.textContent = '';

  // ---- head ----
  const head = el('div', 'dd-head');
  const img = el('img', 'dd-img');
  img.width = 64; img.height = 64; img.alt = '';
  const src = okUrl(it.image); if (src) img.src = src;
  head.appendChild(img);
  const hmid = el('div', 'dd-head-mid');
  hmid.appendChild(el('div', 'dd-name', it.name || ''));
  const meta = [it.sellerName || it.sellerId];
  if (it.sellerRating != null) meta.push(`★${Number(it.sellerRating).toFixed(1)}`);
  hmid.appendChild(el('div', 'pmeta', meta.filter(Boolean).join(' ')));
  if (it.masterName) hmid.appendChild(el('div', 'pmeta', `買取マスター: ${it.masterName}`));
  if (it.jan) hmid.appendChild(el('div', 'pmeta num', `JAN: ${it.jan}`));
  const badgeLine = el('div', 'badges dd-badges');
  badgeLine.appendChild(el('span', `rank-badge ${it.rank || '-'}`, it.rank || '-'));
  badgeLine.appendChild(confBadge(it));
  if ((it.variants ?? 1) > 1) badgeLine.appendChild(el('span', 'badge', `×${it.variants}出品`));
  hmid.appendChild(badgeLine);
  head.appendChild(hmid);
  host.appendChild(head);

  // ---- money flow ----
  const flowSec = el('section', 'dd-sec');
  flowSec.appendChild(el('h3', 'dd-sec-title', 'お金の流れ'));
  const flow = el('div', 'flow');

  const yahooVal = el('span', 'flow-val num');
  if (it.flags?.premiumDeal && it.price != null && it.basePrice != null && it.basePrice < it.price)
    yahooVal.appendChild(el('span', 'strike', fmtYen(it.price)));
  yahooVal.appendChild(document.createTextNode(fmtYen(it.basePrice ?? it.price)));
  flow.appendChild(flowStep('Yahoo!価格', yahooVal));
  flow.appendChild(flowArrow());

  flow.appendChild(flowStep('送料', el('span', 'flow-val num', shippingText(it) ?? '未確認')));
  flow.appendChild(flowArrow());

  const ptVal = el('span', 'flow-val num');
  ptVal.appendChild(document.createTextNode(`最大 +${fmtNum(it.point?.max)}pt`));
  ptVal.appendChild(el('span', 'flow-sub', `（確実 +${fmtNum(it.point?.conservative)}pt）`));
  flow.appendChild(flowStep('ポイント', ptVal, campaignsNode(it)));
  flow.appendChild(flowArrow());

  const effVal = el('span', 'flow-val num');
  effVal.appendChild(document.createTextNode(fmtYen(it.effective?.max)));
  effVal.appendChild(el('span', 'flow-sub', `（確実 ${fmtYen(it.effective?.conservative)}）`));
  const effNote = shippingNote(it);
  flow.appendChild(flowStep('実質価格', effVal, effNote ? el('div', 'flow-note', `送料込みの金額です`) : null));
  flowSec.appendChild(flow);
  host.appendChild(flowSec);

  // ---- buyback ----
  const bbSec = el('section', 'dd-sec');
  bbSec.appendChild(el('h3', 'dd-sec-title', '買取価格（高い順）'));
  if (it.buyback?.shops?.length) {
    bbSec.appendChild(buybackBars(it.buyback.shops));
  } else if (it.buyback?.max != null) {
    bbSec.appendChild(buybackBars([{ shop: it.buyback.shop, price: it.buyback.max, time: it.buyback.time }]));
  } else {
    bbSec.appendChild(el('p', 'flow-note', '買取価格は見つかりませんでした'));
  }
  host.appendChild(bbSec);

  // ---- profit ----
  const prSec = el('section', 'dd-sec');
  prSec.appendChild(el('h3', 'dd-sec-title', '利益'));
  const prBox = el('div', 'dd-profit');
  const line = (k, v, cls) => {
    const r = el('div', 'dd-profit-row');
    r.appendChild(el('span', 'dd-profit-k', k));
    r.appendChild(el('span', `num ${cls}`.trim(), v));
    prBox.appendChild(r);
  };
  line('利益（最大）', fmtYen(it.profit?.max, true), `v-big ${profitClass(it.profit?.max)}`);
  line('利益（確実）', fmtYen(it.profit?.conservative, true), profitClass(it.profit?.conservative));
  line('利益率', fmtRate(it.profitRate));
  const mp = it.flags?.maxPurchase;
  if (mp > 1 && it.profit) {
    const tot = el('div', 'dd-profit-row total');
    tot.appendChild(el('span', 'dd-profit-k', `上限${mp}点まで買った時の合計`));
    const v = el('span', 'num');
    v.appendChild(el('b', profitClass(it.profit.max * mp), fmtYen(it.profit.max * mp, true)));
    v.appendChild(el('span', 'flow-sub', `（確実 ${fmtYen(it.profit.conservative * mp, true)}）`));
    tot.appendChild(v);
    prBox.appendChild(tot);
  }
  prSec.appendChild(prBox);
  host.appendChild(prSec);

  // ---- risks ----
  if ((it.risks || []).length) {
    const rSec = el('section', 'dd-sec');
    rSec.appendChild(el('h3', 'dd-sec-title', '注意点'));
    for (const r of it.risks) {
      const row = el('div', 'dd-risk');
      row.appendChild(el('span', 'dd-risk-name', `⚠ ${r}`));
      row.appendChild(el('span', 'dd-risk-desc', riskDesc(r)));
      rSec.appendChild(row);
    }
    host.appendChild(rSec);
  }

  // ---- ops ----
  const ops = el('div', 'dd-ops');
  const href = okUrl(it.url);
  if (href) {
    const a = el('a', 'btn ghost', 'Yahoo!で開く');
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    ops.appendChild(a);
  }
  if (it.jan) {
    const b = el('button', 'btn ghost', 'JANをコピー');
    b.type = 'button';
    b.addEventListener('click', () => copyText(it.jan, 'JANをコピーしました'));
    ops.appendChild(b);
  }
  const hk = el('a', 'btn ghost', '買取比較を開く');
  hk.href = HIKAKU_URL; hk.target = '_blank'; hk.rel = 'noopener noreferrer';
  ops.appendChild(hk);
  host.appendChild(ops);
}

export function openItemDrawer(it) {
  buildDetail(it);
  $('#drawerBackdrop').hidden = false;
  const d = $('#itemDrawer');
  d.hidden = false;
  requestAnimationFrame(() => d.classList.add('open'));
  $('#itemDrawerClose').focus();
}
export function closeItemDrawer() {
  const d = $('#itemDrawer');
  if (d.hidden) return;
  d.classList.remove('open');
  setTimeout(() => { d.hidden = true; }, 260);
  if ($('#historyDrawer').hidden) $('#drawerBackdrop').hidden = true;
}
export const itemDrawerOpen = () => !$('#itemDrawer').hidden;

/* ========== CSV ========== */
const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function exportCsv(items, scanId) {
  const header = ['ランク', '確度', '利益最大', '利益確実', '利益率', '実質最大', 'Yahoo価格',
    '送料', 'ポイント最大', '買取最高', '買取店', 'ストア', '商品名', 'JAN', 'URL', 'リスク'];
  const rows = items.map(it => [
    it.rank || '',
    CONF_LABEL[confOf(it)] || '',
    it.profit?.max ?? '',
    it.profit?.conservative ?? '',
    it.profitRate ?? '',
    it.effective?.max ?? '',
    it.basePrice ?? it.price ?? '',
    it.shipping?.fee ?? (it.shipping?.free === true ? 0 : ''),
    it.point?.max ?? '',
    it.buyback?.max ?? '',
    it.buyback?.shop || '',
    it.sellerName || it.sellerId || '',
    it.name || '',
    it.jan || '',
    it.url || '',
    (it.risks || []).join('；'),
  ]);
  const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `yahoo-profit-${scanId || 'export'}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
