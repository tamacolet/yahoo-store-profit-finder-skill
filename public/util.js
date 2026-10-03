'use strict';

/* ========== dom helpers ========== */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/* ========== format ========== */
export const nf = new Intl.NumberFormat('ja-JP');
export const fmtNum = n => (n == null || !Number.isFinite(n) ? '—' : nf.format(Math.round(n)));
export const fmtYen = (n, sign = false) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = sign ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
  return `${s}¥${nf.format(Math.abs(Math.round(n)))}`;
};
export const fmtRate = n => (n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(1)}%`);
export const okUrl = u => {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') ? u : null; }
  catch { return null; }
};
export const shortTime = t => {
  const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(t || '');
  return m ? `${Number(m[1])}/${Number(m[2])} ${m[3]}` : (t || '');
};
export const scanDate = id => {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id || '');
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : id;
};
export const profitClass = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

/* ========== confidence ========== */
// 新APIの confidence が無い過去データは matchType から推定して受ける
export const confOf = it =>
  it.confidence || (it.matchType === 'jan' ? 'high' : it.matchType === 'model' ? 'mid' : 'low');
export const CONF_LABEL = { high: '高', mid: '中', low: '低' };
export function confBadge(it) {
  const c = confOf(it);
  return el('span', `badge conf ${c}`, `確度 ${CONF_LABEL[c] || c}`);
}

/* ========== toast ========== */
export function toast(msg, kind = '') {
  const t = el('div', `toast ${kind}`.trim(), msg);
  $('#toastHost').appendChild(t);
  setTimeout(() => t.remove(), 5200);
}

export async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg || 'コピーしました', 'ok'); }
  catch {
    const ta = el('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg || 'コピーしました', 'ok'); }
    catch { toast('コピーできませんでした', 'err'); }
    ta.remove();
  }
}
