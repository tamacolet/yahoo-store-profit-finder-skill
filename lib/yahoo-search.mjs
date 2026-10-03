// Yahoo!ショッピング検索API V3。適応待機（バースト型レート制限）・価格帯分割・hit正規化。
// 実測済みの数値は旧 sweep.mjs から流用（SPEC.md「実測済みの事実」参照）。

import { normalizeJan } from './matcher.mjs'

const ENDPOINT = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch'

export const PAGE_SIZE = 50

// results=50 は start=901 まで踏めるため、実際に取れるのは先頭950件まで。
// これを超える件数のセグメントは splitBand が価格帯を割って取りこぼしを防ぐ。
export const MAX_REACHABLE = 950

// 1つの価格帯がこれより多い時は割らない（先頭950件だけ取る）。
// 実測: 「ノートPC」の1〜2万円帯は約18万件あり、割り切ろうとすると6時間以上かかる。
export const MAX_SPLIT_TOTAL = 30000

export function buildSearchUrl({
  appid,
  genreId,
  keyword,
  sellerId,
  jan,
  priceFrom,
  priceTo,
  start = 1,
  results = PAGE_SIZE,
  sort,
}) {
  const q = new URLSearchParams({
    appid,
    condition: 'new',
    in_stock: 'true',
    results: String(results),
    start: String(start),
  })
  if (genreId != null) q.set('genre_category_id', String(genreId))
  if (keyword) q.set('query', keyword)
  if (sellerId) q.set('seller_id', sellerId)
  if (jan) q.set('jan_code', String(jan))
  if (priceFrom != null) q.set('price_from', String(priceFrom))
  if (priceTo != null) q.set('price_to', String(priceTo))
  if (sort) q.set('sort', sort)
  return `${ENDPOINT}?${q}`
}

// APIのhitから判定に使う形に正規化する。
export function normalizeHit(hit) {
  const price = typeof hit?.price === 'number' ? hit.price : null
  const premiumPrice = typeof hit?.premiumPrice === 'number' ? hit.premiumPrice : null
  // premiumPriceStatus は「プレミアム価格が設定されているか」のフラグ。
  // status=true でも premiumPrice === price のことがあるため、実際に安いかは金額で判定する。
  const hasPremiumDeal =
    hit?.premiumPriceStatus === true && premiumPrice != null && price != null && premiumPrice < price

  const p = hit?.point || {}
  // 検索APIのポイントは概算。通常系とプレミアム系の大きい方を採る。
  const roughPoint = Math.max(
    (p.amount || 0) + (p.bonusAmount || 0) + (p.lyLimitedBonusAmount || 0),
    (p.premiumAmount || 0) + (p.premiumBonusAmount || 0) + (p.lyLimitedPremiumBonusAmount || 0),
  )

  return {
    key: keyOf({ sellerId: hit?.seller?.sellerId, code: hit?.code, url: hit?.url, jan: hit?.janCode, name: hit?.name }),
    code: hit?.code ?? null,
    jan: normalizeJan(hit?.janCode),
    name: hit?.name ?? null,
    url: hit?.url ?? null,
    sellerId: hit?.seller?.sellerId ?? null,
    sellerName: hit?.seller?.name ?? null,
    sellerRating: typeof hit?.seller?.review?.rate === 'number' ? hit.seller.review.rate : null,
    image: hit?.image?.medium || hit?.image?.small || null,
    genreName: hit?.genreCategory?.name ?? null,
    shipping: hit?.shipping?.name ?? null,
    shippingFree: hit?.shipping?.code == null ? null : hit.shipping.code === 2,
    condition: hit?.condition ?? null,
    inStock: typeof hit?.inStock === 'boolean' ? hit.inStock : null,
    price,
    premiumPrice,
    hasPremiumDeal,
    // 実質価格の起点。プレミアム特価が実際に安い時だけそちらを使う。
    basePrice: hasPremiumDeal ? premiumPrice : price,
    roughPoint,
  }
}

export function keyOf(item) {
  return `${item?.sellerId || '?'}::${item?.code || item?.url || item?.jan || item?.name}`
}

// 件数が取得上限を超えるセグメントを、上限に収まるまで価格帯で二分割する。
// priceTo が null（上限なし）のセグメントは割れないので、そのまま返す。
export function splitBand([from, to], count) {
  if (count <= MAX_REACHABLE || count > MAX_SPLIT_TOTAL) return [[from, to]]
  if (to == null) return [[from, to]]
  const mid = Math.floor((from + to) / 2)
  if (mid <= from || mid >= to) return [[from, to]]
  return [
    [from, mid],
    [mid, to],
  ]
}

// 429/500/503 は再試行対象。
export function shouldRetry(status) {
  return status === 429 || status === 500 || status === 503
}

export function backoffMs(attempt, baseMs = 2000) {
  return baseMs * 2 ** attempt
}

// 制限は継続ブロックではなくバースト型。429を踏んだら間隔を伸ばし、
// 通り続けている間はゆっくり戻す。
export function adaptDelay(currentMs, rateLimited, opts = {}) {
  const min = opts.minMs ?? 1200
  const max = opts.maxMs ?? 8000
  if (rateLimited) return Math.min(max, Math.ceil(currentMs * 1.6))
  return Math.max(min, Math.ceil(currentMs * 0.95))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function abortError() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

// 検索クライアント。collect() が価格帯分割つきの全件取得、byJan() が逆引き用の最安検索。
export function createSearchClient({ appid, log = () => {}, fetchImpl = fetch } = {}) {
  const stats = { rateLimitHits: 0, delayMs: 1200 }

  async function fetchJson(url, { signal, timeoutMs = 20000, maxAttempts = 6 } = {}) {
    let lastError = null
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) throw abortError()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      const onAbort = () => ctrl.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal })
        if (res.ok) {
          stats.delayMs = adaptDelay(stats.delayMs, false)
          return await res.json()
        }
        if (!shouldRetry(res.status)) throw new Error(`HTTP ${res.status}`)
        stats.rateLimitHits += 1
        stats.delayMs = adaptDelay(stats.delayMs, true)
        const wait = backoffMs(attempt)
        log(`  … HTTP ${res.status}、${wait}ms待機して再試行 (${attempt + 1}/${maxAttempts})`)
        lastError = new Error(`HTTP ${res.status}`)
        await sleep(wait)
      } catch (e) {
        if (signal?.aborted) throw abortError()
        // AbortError含むネットワーク系も同じ扱いで再試行する
        if (e?.message?.startsWith('HTTP ') && !shouldRetry(Number(e.message.slice(5)))) throw e
        lastError = e
        const wait = backoffMs(attempt)
        log(`  … ${e.message}、${wait}ms待機して再試行 (${attempt + 1}/${maxAttempts})`)
        await sleep(wait)
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
    throw new Error(`リトライ上限。最後のエラー: ${lastError?.message || 'unknown'}`)
  }

  async function sweepBand({ base, band, signal, log: lg }) {
    const [from, to] = band
    const head = await fetchJson(
      buildSearchUrl({ ...base, priceFrom: from, priceTo: to, results: 1 }),
      { signal },
    )
    const total = head?.totalResultsAvailable ?? 0

    const bands = splitBand(band, total)
    if (bands.length > 1) {
      lg(`  ${from}-${to ?? '∞'}: ${total}件 → 取得上限(${MAX_REACHABLE})超のため分割`)
      const out = []
      for (const b of bands) {
        if (signal?.aborted) throw abortError()
        await sleep(stats.delayMs)
        // 件数が多いと push(...配列) はスタックを使い切るので1件ずつ足す
        for (const it of await sweepBand({ base, band: b, signal, log: lg })) out.push(it)
      }
      return out
    }

    if (total > MAX_REACHABLE) {
      const why = total > MAX_SPLIT_TOTAL ? '多すぎるため分割せず' : '分割できず'
      lg(`  ! ${from}-${to ?? '∞'}: ${total}件だが${why}、先頭${MAX_REACHABLE}件のみ取得（取りこぼしあり）`)
    }

    const items = []
    const reachable = Math.min(total, MAX_REACHABLE)
    for (let start = 1; start <= reachable; start += PAGE_SIZE) {
      if (signal?.aborted) throw abortError()
      await sleep(stats.delayMs)
      const data = await fetchJson(
        buildSearchUrl({ ...base, priceFrom: from, priceTo: to, start }),
        { signal },
      )
      const hits = data?.hits || []
      if (hits.length === 0) break
      items.push(...hits.map(normalizeHit))
    }
    lg(`  ${from}-${to ?? '∞'}: ${total}件中 ${items.length}件取得（間隔${stats.delayMs}ms）`)
    return items
  }

  return {
    stats,
    // 価格帯分割つき全件取得。genreId / keyword / sellerId は任意の組み合わせ。
    async collect({ genreId = null, keyword = '', sellerId = '', bands, signal, onProgress } = {}) {
      const base = { appid, genreId, keyword, sellerId }
      const items = []
      const list = bands && bands.length ? bands : [[null, null]]
      let doneBands = 0
      for (const band of list) {
        if (signal?.aborted) throw abortError()
        for (const it of await sweepBand({ base, band, signal, log })) items.push(it)
        doneBands += 1
        onProgress?.(doneBands, list.length)
      }
      return { items }
    },
    // JAN指定で最安から20件（reverseモード用）
    async byJan(jan, { signal } = {}) {
      const data = await fetchJson(
        buildSearchUrl({ appid, jan, sort: '+price', results: 20 }),
        { signal },
      )
      return (data?.hits || []).map(normalizeHit)
    },
  }
}
