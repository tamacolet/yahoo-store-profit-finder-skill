// スキャンのパイプライン。
//   search → match → buyback → rough → deep → diff → save
// 進捗は onEvent(event) に流す。AbortSignal で中断でき、止めた時点までを
// status:'cancelled' で保存する。依存は deps で差し替え可能（テストは偽物を渡す）。

import { PRESETS, presetById, DEFAULT_PRICE_BANDS, clipBands } from './presets.mjs'
import { matchListing } from './matcher.mjs'
import { judgeItem, compareResults, pickBuyback, USED_NAME_RE } from './judge.mjs'

const DEEP_MARGIN_YEN = 3000
const DEEP_MARGIN_RATIO = 0.12
const DEEP_EMIT_EVERY = 5

function waitWithAbort(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  if (!ms) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function mergeVariants(items) {
  const byProduct = new Map()
  for (const item of items) {
    const key = JSON.stringify([item.sellerId, item.jan, item.basePrice])
    const current = byProduct.get(key)
    if (!current) {
      byProduct.set(key, item)
      continue
    }
    const variants = (current.variants ?? 1) + (item.variants ?? 1)
    if (current.stock.available !== true && item.stock.available === true) {
      item.variants = variants
      byProduct.set(key, item)
    } else {
      current.variants = variants
    }
  }
  return [...byProduct.values()]
}

function abortError() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

// 直近スキャンとの差分を flags に反映する。
// prevMap: Map<key, item>（直近最大5スキャンをマージしたもの）。hasPrev=false なら isNew は付けない。
export function applyDiff(results, prevMap, hasPrev) {
  if (!hasPrev) return results
  for (const it of results) {
    const prev = prevMap.get(it.key)
    if (!prev) {
      it.flags.isNew = true
    } else if (
      prev.basePrice != null &&
      it.basePrice != null &&
      it.basePrice <= prev.basePrice * 0.99
    ) {
      it.flags.priceDrop = { prev: prev.basePrice, delta: it.basePrice - prev.basePrice }
    }
  }
  return results
}

// params: { mode, presets[], keyword, sellerId, priceFrom, priceTo,
//           masterCategories[], minBuyback, reverseLimit, deepCheck, deepLimit }
// deps:   { search, buyback, pageFetcherFactory, store, now, wait }
export async function runScan(params, { deps, onEvent = () => {}, signal } = {}) {
  const { search, buyback, pageFetcherFactory, store } = deps
  const now = deps.now || (() => new Date())
  const startedAt = now()
  const id = params.id || (await store.nextId())

  const stats = {
    listings: 0,
    matched: 0,
    matchedByModel: 0,
    buybackHits: 0,
    deepChecked: 0,
    rankA: 0,
    rankB: 0,
    rankC: 0,
    bestProfit: null,
  }
  let rateLimitHits = 0
  let pointSource = 'api'
  let loginState = null
  let duplicatesMerged = 0
  const warnings = []
  let status = 'done'
  let errorMessage = null
  let results = []

  const emit = (stage, message, done = 0, total = 0) =>
    onEvent({ type: 'progress', stage, message, done, total, stats: { ...stats } })
  const emitItems = () => onEvent({ type: 'items', items: results })
  const cancelled = () => signal?.aborted === true
  const throwIfAborted = () => {
    if (cancelled()) throw abortError()
  }

  // 出品の収集が途中で止まっても、集めた分で判定を続ける（全部捨てない）
  const warnSearchStopped = (reason) => {
    const message = `出品の収集を途中で打ち切りました（${reason}）。ここまでに集めた分だけで判定しています`
    warnings.push(message)
    onEvent({ type: 'warning', message })
  }

  // 型番照合で買取の半値未満なのは、ほぼ別物（付属品・下位モデル）なので結果から外す
  const judgeAll = (recs, priceMap, at) => {
    const judged = recs
      .map((r) => judgeItem({ ...r, buybackData: priceMap.get(r.jan) }, { now: at }))
      .filter((r) => !(r.matchType === 'model' && r.risks.includes('価格が安すぎる（要確認）')))
    const merged = mergeVariants(judged)
    duplicatesMerged = judged.length - merged.length
    return merged.sort(compareResults)
  }

  function recount() {
    stats.rankA = results.filter((r) => r.rank === 'A').length
    stats.rankB = results.filter((r) => r.rank === 'B').length
    stats.rankC = results.filter((r) => r.rank === 'C').length
    stats.bestProfit = results.reduce(
      (m, r) => (r.profit?.max != null && r.profit.max > (m ?? -Infinity) ? r.profit.max : m),
      null,
    )
  }

  async function saveAndFinish() {
    const finishedAt = now()
    const summary = {
      ...stats,
      durationSec: Math.round((finishedAt - startedAt) / 1000),
      rateLimitHits,
      pointSource,
      loginState,
      duplicatesMerged,
      warnings,
    }
    if (errorMessage) summary.error = errorMessage
    const doc = {
      id,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      params,
      summary,
      items: results,
    }
    emit('save', '結果を保存中…')
    await store.save(doc)
    if (errorMessage) onEvent({ type: 'error', message: errorMessage })
    onEvent({ type: 'done', id, status, summary })
    return doc
  }

  // ---- 1. search: 出品を集める ----
  const listings = new Map()
  let prefetchedPrices = null
  const addHits = (hits) => {
    for (const it of hits || []) {
      if (it.condition && it.condition !== 'new') continue
      if (it.inStock === false) continue
      if (USED_NAME_RE.test(it.name || '')) continue
      listings.set(it.key, it)
    }
  }

  try {
    if (params.mode === 'reverse') {
      // 買取表から逆引き: カテゴリのJAN → 買取価格 → minBuyback以上だけ jan_code 検索
      emit('search', '買取マスターを読み込み中…')
      const items = await buyback.master()
      const wanted = new Set(params.masterCategories || [])
      const jans = [
        ...new Set(
          items
            .filter((m) => wanted.size === 0 || wanted.has(m?.category))
            .map((m) => m?.JAN ?? m?.jan)
            .filter(Boolean),
        ),
      ]
      emit('buyback', `買取価格を取得中…（${jans.length}件）`, 0, jans.length)
      prefetchedPrices = await buyback.pricesForJans(jans, {
        concurrency: 8,
        signal,
        onProgress: (d, t) => emit('buyback', '買取価格を取得中…', d, t),
      })
      const reverseLimit = Math.min(2000, Math.max(1, params.reverseLimit ?? 300))
      const okJans = jans
        .map((jan) => ({ jan, max: pickBuyback(prefetchedPrices.get(jan), now()).max }))
        .filter((v) => v.max != null && v.max >= (params.minBuyback || 0))
        .sort((a, b) => b.max - a.max)
        .slice(0, reverseLimit)
        .map((v) => v.jan)
      for (let i = 0; i < okJans.length; i += 1) {
        throwIfAborted()
        emit('search', `JAN ${okJans[i]} の出品を検索中…`, i, okJans.length)
        await (deps.wait || waitWithAbort)(search.stats?.delayMs ?? 0, signal)
        throwIfAborted()
        try {
          addHits(await search.byJan(okJans[i], { signal }))
        } catch (e) {
          if (e?.name === 'AbortError' || cancelled()) throw e
          warnSearchStopped(e?.message || String(e))
          break
        }
      }
    } else {
      const bands = clipBands(DEFAULT_PRICE_BANDS, params.priceFrom, params.priceTo)
      const genreIds = [
        ...new Set(
          (params.presets || [])
            .map((p) => presetById(p)?.genreIds || [])
            .flat(),
        ),
      ]
      const targets = genreIds.length ? genreIds : [null]
      for (const genreId of targets) {
        throwIfAborted()
        const { items, error } = await search.collect({
          genreId,
          keyword: params.keyword || '',
          sellerId: params.sellerId || '',
          bands,
          signal,
          onProgress: (d, t) =>
            emit('search', `出品を収集中…（ジャンル${genreId ?? '全体'}・帯${d}/${t}）`, d, t),
        })
        addHits(items)
        if (error) {
          warnSearchStopped(error)
          break
        }
      }
    }
    stats.listings = listings.size
    rateLimitHits = search.stats?.rateLimitHits ?? 0
    emit('search', `出品 ${stats.listings}件`, stats.listings, stats.listings)

    // ---- 2. match: 買取マスター索引で照合 ----
    emit('match', '買取マスターと照合中…')
    const index = await buyback.masterIndex()
    const recs = []
    for (const it of listings.values()) {
      const m = matchListing(it, index)
      if (!m) continue
      recs.push({
        key: it.key,
        sellerId: it.sellerId,
        sellerName: it.sellerName,
        sellerRating: it.sellerRating,
        url: it.url,
        name: it.name,
        image: it.image,
        genreName: it.genreName,
        jan: m.jan,
        matchType: m.matchType,
        masterName: m.masterName,
        price: it.price,
        basePrice: it.basePrice,
        pointConservative: it.roughPoint,
        pointMax: it.roughPoint,
        pointSource: 'api',
        stockAvailable: it.inStock,
        shippingFee: null,
        shippingFree: it.shippingFree ?? null,
      })
    }
    stats.matched = recs.length
    stats.matchedByModel = recs.filter((r) => r.matchType === 'model').length
    emit('match', `照合 ${recs.length}件（うち型番照合 ${stats.matchedByModel}件）`, recs.length, stats.listings)
    throwIfAborted()

    // ---- 3. buyback: ユニークJANの買取価格 ----
    const jans = [...new Set(recs.map((r) => r.jan).filter(Boolean))]
    emit('buyback', `買取価格を取得中…（${jans.length}件）`, 0, jans.length)
    const priceMap = await buyback.pricesForJans(jans, {
      concurrency: 8,
      signal,
      prefetched: prefetchedPrices,
      onProgress: (d, t) => emit('buyback', '買取価格を取得中…', d, t),
    })
    stats.buybackHits = jans.filter((j) => pickBuyback(priceMap.get(j), now()).max != null).length
    // 全件が取得エラーなら「黒字なし」に見えてしまう。黙って通さない
    const failed = jans.filter((j) => priceMap.get(j)?.error && !/見つかりません/.test(priceMap.get(j).error))
    if (jans.length > 0 && failed.length === jans.length) {
      throw new Error(`買取価格を1件も取得できませんでした: ${priceMap.get(failed[0]).error}`)
    }

    // ---- 4. rough: 概算で仮判定 ----
    results = judgeAll(recs, priceMap, now())
    recount()
    emitItems()

    // ---- 5. deep: 商品ページで確定値に置き換える ----
    if (params.deepCheck === 'phi' || params.deepCheck === 'anon') {
      const candidates = recs
        .map((r, i) => ({ r, i, profit: results.find((x) => x.key === r.key)?.profit?.max }))
        .filter((c) => c.profit != null && c.profit >= -Math.max(DEEP_MARGIN_YEN, (c.r.basePrice || 0) * DEEP_MARGIN_RATIO))
        .sort((a, b) => (a.r.matchType === 'jan' ? 0 : 1) - (b.r.matchType === 'jan' ? 0 : 1) || b.profit - a.profit)
        .slice(0, params.deepLimit ?? 120)

      const fetcher = pageFetcherFactory({ mode: params.deepCheck })
      try {
        for (let i = 0; i < candidates.length; i += 1) {
          throwIfAborted()
          const c = candidates[i]
          emit('deep', `商品ページ確認中… ${c.r.url}`, i, candidates.length)
          const parsed = await fetcher.fetch(c.r.url)
          if (parsed) {
            pointSource = fetcher.source
            Object.assign(c.r, {
              price: parsed.price ?? c.r.price,
              basePrice: parsed.basePrice ?? c.r.basePrice,
              pointConservative: parsed.totalPoint ?? c.r.pointConservative,
              pointMax: parsed.totalPointWithEntry ?? parsed.totalPoint ?? c.r.pointMax,
              pointSource: fetcher.source,
              isUsed: parsed.isUsed,
              isCapReached: parsed.isCapReached,
              stockAvailable: parsed.stockAvailable ?? c.r.stockAvailable,
              stockQuantity: parsed.stockQuantity,
              maxPurchase: parsed.maxPurchase,
              hasCoupon: parsed.hasCoupon,
              isBonusPlus: parsed.isBonusPlus,
              campaigns: parsed.campaigns,
              payMethodText: parsed.payMethodText,
              shippingFee: parsed.shippingFee,
              shippingFree: parsed.shippingFree,
            })
            stats.deepChecked += 1
          }
          results = judgeAll(recs, priceMap, now())
          if ((i + 1) % DEEP_EMIT_EVERY === 0 || i === candidates.length - 1) {
            recount()
            emitItems()
          }
        }
      } finally {
        loginState = fetcher.loginState ?? null
        await fetcher.close?.()
      }
      if (params.deepCheck === 'phi' && loginState === 'anon') {
        const message = 'PhiのDefaultプロファイルでYahoo!にログインしていないため、ポイントが実際より低く出ています'
        warnings.push(message)
        onEvent({ type: 'warning', message })
      }
      emit('deep', `商品ページ確認 ${stats.deepChecked}/${candidates.length}件`, candidates.length, candidates.length)
    }

    // ---- 6. diff: 直近スキャンと比較 ----
    const prev = await store.recentItems({ limit: 5, excludeId: id })
    applyDiff(results, prev.map, prev.scanCount > 0)
    emitItems()

    // ---- 7. save ----
    if (cancelled()) status = 'cancelled'
    return await saveAndFinish()
  } catch (e) {
    if (e?.name === 'AbortError' || cancelled()) {
      status = 'cancelled'
      recount()
      return await saveAndFinish()
    }
    status = 'error'
    errorMessage = e?.message || String(e)
    recount()
    return await saveAndFinish()
  }
}

export { PRESETS }
