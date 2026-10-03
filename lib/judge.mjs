// 実質価格・利益・ランク・リスクの判定。
//
// 実質価格は「確実」「最大」の2本で判定する。最大値は全キャンペーンにエントリー済み・
// 支払い方法も満たした場合の値で、誰でも取れるとは限らないため両方持つ。

export const MAX_AGE_DAYS = 30 // 30日より古い買取値は使わない
export const STALE_DAYS = 7 // 7日より古い値しか無い時は「買取価格が古い」

// 買取価格は「SIMフリー・新品未使用」前提。キャリア版・中古はJAN一致でも買取額が下がる。
const CARRIER_PATTERNS = [
  /softbank/i,
  /ソフトバンク/,
  /docomo/i,
  /ドコモ/,
  /\bau\b/i,
  /エーユー/,
  /ワイモバイル/,
  /y!?mobile/i,
  /uq\s?mobile/i,
  /UQモバイル/,
  /楽天モバイル/,
]
// 中古・展示品は新品の買取価格と比べられない。「新品未使用」「未開封」は新品なので当てない。
// 「再生」単独は「ブルーレイ再生」「連続再生」など新品の機能説明に当たるので入れない。
export const USED_NAME_RE = /中古|整備済|整備品|再生新品|再生品|メーカー再生|リファービッシュ|リファビッシュ|アウトレット|難あり|箱破損|箱不良|箱潰れ|箱つぶれ|シュリンク破れ|箱なし|箱無し|訳あり|訳アリ|展示品|新古品|本体のみ|[SABCD]ランク|美品|(?<!未)開封品|ジャンク/
// ネットワーク利用制限が△の端末は買取額が下がる
const RESTRICTED_NAME_RE = /判定\s*[△▲]|利用制限\s*[△▲]|赤ロム/
const OVERSEAS_NAME_RE = /海外版|海外SIM|グローバル版|並行輸入|香港版|米国版|輸入品/

// "2026-01-17 18:30" 形式（JST）。実行環境のタイムゾーンに依らず JST として読む
function parseTime(t) {
  if (!t) return NaN
  const ms = new Date(`${String(t).trim().replace(' ', 'T')}+09:00`).getTime()
  return Number.isNaN(ms) ? NaN : ms
}

// 買取価格データから「今使える最高値」を選ぶ。
// data: { name, jan, prices: [{shop, price, time}], maxPrice } (formatPriceData のJSON)
// 戻り値: { max, shop, time, shops, stale }
//   shops は有効（30日以内）な価格のみ高い順。30日超しか無い時は max:null。
//   使える最高値が7日より古い時 stale:true（risk「買取価格が古い」）。
export function pickBuyback(data, now = new Date(), { maxAgeDays = MAX_AGE_DAYS, staleDays = STALE_DAYS } = {}) {
  const empty = { max: null, shop: null, time: null, shops: [], stale: false }
  if (!data || data.error || !Array.isArray(data.prices) || data.prices.length === 0) return empty

  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  const fresh = data.prices
    .filter((p) => p && typeof p.price === 'number' && p.price > 0)
    .filter((p) => {
      const t = parseTime(p.time)
      return !Number.isNaN(t) && nowMs - t <= maxAgeDays * 24 * 60 * 60 * 1000
    })
    .sort((a, b) => b.price - a.price)

  if (fresh.length === 0) return empty
  const best = fresh[0]
  const stale = nowMs - parseTime(best.time) > staleDays * 24 * 60 * 60 * 1000
  return { max: best.price, shop: best.shop, time: best.time, shops: fresh, stale }
}

// A: 確実に黒字 / B: 条件を満たせば黒字 / C: 赤字 / -: 買取不明
export function rankOf(profitConservative, profitMax) {
  if (profitConservative == null && profitMax == null) return '-'
  if (profitConservative != null && profitConservative > 0) return 'A'
  if (profitMax != null && profitMax > 0) return 'B'
  return 'C'
}

const round1 = (v) => Math.round(v * 10) / 10

// rec（出品+照合+買取+ページ確定値の寄せ集め）を ResultItem 形に判定する。
// rec の主要フィールド:
//   key, sellerId, sellerName, sellerRating, url, name, image, genreName,
//   jan, matchType, masterName, price, basePrice, shippingFee, shippingFree,
//   pointConservative, pointMax, pointSource ('api'|'page-login'|'page-anon'),
//   buybackData（formatPriceDataのJSONオブジェクト）,
//   isUsed, isCapReached, stockAvailable(bool|null), stockQuantity, maxPurchase,
//   payMethodText, hasCoupon, isBonusPlus, campaigns, variants, priceDrop, isNew, checkedAt
export function judgeItem(rec, { now = new Date() } = {}) {
  const basePrice = typeof rec.basePrice === 'number' ? rec.basePrice : null
  const shippingFee = typeof rec.shippingFee === 'number' ? rec.shippingFee : null
  const shippingFree = typeof rec.shippingFree === 'boolean' ? rec.shippingFree : null
  const pointConservative = typeof rec.pointConservative === 'number' ? rec.pointConservative : 0
  const pointMax = typeof rec.pointMax === 'number' ? rec.pointMax : pointConservative
  const price = typeof rec.price === 'number' ? rec.price : basePrice

  const effectiveConservative = basePrice != null ? basePrice + (shippingFee || 0) - pointConservative : null
  const effectiveMax = basePrice != null ? basePrice + (shippingFee || 0) - pointMax : null

  const bb = pickBuyback(rec.buybackData, now)
  const profitConservative =
    bb.max != null && effectiveConservative != null ? bb.max - effectiveConservative : null
  const profitMax = bb.max != null && effectiveMax != null ? bb.max - effectiveMax : null
  const profitRate =
    profitMax != null && effectiveMax != null && effectiveMax > 0
      ? round1((profitMax / effectiveMax) * 100)
      : null

  const risks = []
  const name = rec.name || ''
  if (rec.isUsed === true || USED_NAME_RE.test(name)) risks.push('中古・整備品')
  if (CARRIER_PATTERNS.some((re) => re.test(name))) risks.push('キャリア版')
  if (OVERSEAS_NAME_RE.test(name)) risks.push('海外版')
  if (RESTRICTED_NAME_RE.test(name)) risks.push('利用制限△')
  if (shippingFree !== true && shippingFee == null) risks.push('送料別の可能性')
  if (rec.isCapReached === true) risks.push('ポイント上限到達')
  if (rec.stockAvailable === false) risks.push('在庫なし')
  else if (rec.stockAvailable == null) risks.push('在庫不明')
  if (rec.matchType === 'model') risks.push('型番照合（要確認）')
  if (bb.stale) risks.push('買取価格が古い')
  if (bb.max != null && effectiveConservative != null && effectiveConservative < bb.max * 0.5) {
    risks.push('価格が安すぎる（要確認）')
  }
  const confidence = rec.matchType !== 'jan' ||
    risks.includes('中古・整備品') || risks.includes('価格が安すぎる（要確認）')
    ? 'low'
    : ['キャリア版', '海外版', '利用制限△', '買取価格が古い', '在庫なし'].some((risk) => risks.includes(risk))
      ? 'mid'
      : 'high'

  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  return {
    key: rec.key,
    sellerId: rec.sellerId ?? null,
    sellerName: rec.sellerName ?? null,
    sellerRating: rec.sellerRating ?? null,
    url: rec.url ?? null,
    name: rec.name ?? null,
    image: rec.image ?? null,
    genreName: rec.genreName ?? null,
    jan: rec.jan ?? null,
    matchType: rec.matchType ?? null,
    masterName: rec.masterName ?? null,
    price,
    basePrice,
    shipping: { fee: shippingFee, free: shippingFree },
    point: {
      conservative: pointConservative,
      max: pointMax,
      source: rec.pointSource || 'api',
      payMethodText: typeof rec.payMethodText === 'string' ? rec.payMethodText : null,
    },
    effective: { conservative: effectiveConservative, max: effectiveMax },
    buyback: { max: bb.max, shop: bb.shop, time: bb.time, shops: bb.shops },
    profit: { conservative: profitConservative, max: profitMax },
    profitRate,
    rank: rankOf(profitConservative, profitMax),
    confidence,
    risks,
    variants: typeof rec.variants === 'number' ? rec.variants : 1,
    flags: {
      premiumDeal: basePrice != null && price != null && basePrice < price,
      coupon: rec.hasCoupon === true,
      bonusPlus: rec.isBonusPlus === true,
      maxPurchase: typeof rec.maxPurchase === 'number' ? rec.maxPurchase : null,
      priceDrop: rec.priceDrop ?? null,
      isNew: rec.isNew === true,
    },
    stock: {
      available: typeof rec.stockAvailable === 'boolean' ? rec.stockAvailable : null,
      quantity: typeof rec.stockQuantity === 'number' ? rec.stockQuantity : null,
    },
    campaigns: Array.isArray(rec.campaigns) ? rec.campaigns : [],
    checkedAt: rec.checkedAt || nowIso,
  }
}

// レポート・保存時の並び: ランク順 → 確信度順 → 利益（最大）の大きい順
export function compareResults(a, b) {
  const order = { A: 0, B: 1, C: 2, '-': 3 }
  const ra = order[a.rank] ?? 4
  const rb = order[b.rank] ?? 4
  if (ra !== rb) return ra - rb
  const confidenceOrder = { high: 0, mid: 1, low: 2 }
  const ca = confidenceOrder[a.confidence] ?? 3
  const cb = confidenceOrder[b.confidence] ?? 3
  if (ca !== cb) return ca - cb
  return (b.profit?.max ?? -Infinity) - (a.profit?.max ?? -Infinity)
}
