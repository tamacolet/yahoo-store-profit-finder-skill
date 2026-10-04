import { describe, it, expect, vi } from 'vitest'
import {
  buildSearchUrl,
  normalizeHit,
  splitBand,
  adaptDelay,
  shouldRetry,
  backoffMs,
  retryWaitMs,
  keyOf,
  MAX_REACHABLE,
  createSearchClient,
} from '../lib/yahoo-search.mjs'

describe('buildSearchUrl', () => {
  it('ジャンル検索のURLを組み立てる', () => {
    const url = buildSearchUrl({ appid: 'APP', genreId: 38338, priceFrom: 10000, priceTo: 30000 })
    const q = new URL(url).searchParams
    expect(q.get('appid')).toBe('APP')
    expect(q.get('genre_category_id')).toBe('38338')
    expect(q.get('condition')).toBe('new')
    expect(q.get('in_stock')).toBe('true')
    expect(q.get('price_from')).toBe('10000')
    expect(q.get('price_to')).toBe('30000')
    expect(q.get('results')).toBe('50')
    expect(q.get('start')).toBe('1')
  })

  it('キーワード・ストア・JAN・ソートを付けられる', () => {
    const q = new URL(
      buildSearchUrl({ appid: 'A', keyword: 'iPhone 17', sellerId: 'ebest', jan: '4900000000001', sort: '+price' }),
    ).searchParams
    expect(q.get('query')).toBe('iPhone 17')
    expect(q.get('seller_id')).toBe('ebest')
    expect(q.get('jan_code')).toBe('4900000000001')
    expect(q.get('sort')).toBe('+price')
  })
})

describe('normalizeHit', () => {
  const base = {
    code: 'abc123',
    janCode: '4580038873259',
    name: 'OPPO Find X9',
    url: 'https://store.shopping.yahoo.co.jp/ebest/abc123.html',
    condition: 'new',
    inStock: true,
    price: 274800,
    seller: { sellerId: 'ebest', name: 'イーベスト', review: { rate: 4.6, count: 100 } },
    image: { small: 's.jpg', medium: 'm.jpg' },
    genreCategory: { id: 38338, name: 'アンドロイドスマートフォン' },
    point: {},
  }

  it('premiumPriceStatus=true でも金額が同じなら特価扱いしない', () => {
    const it = normalizeHit({ ...base, premiumPrice: 274800, premiumPriceStatus: true })
    expect(it.hasPremiumDeal).toBe(false)
    expect(it.basePrice).toBe(274800)
  })

  it('premiumPrice が実際に安い時だけ起点価格にする', () => {
    const it = normalizeHit({ ...base, premiumPrice: 231490, premiumPriceStatus: true })
    expect(it.hasPremiumDeal).toBe(true)
    expect(it.basePrice).toBe(231490)
    expect(it.price).toBe(274800)
  })

  it('概算ポイントは通常系とプレミアム系の大きい方', () => {
    const it = normalizeHit({
      ...base,
      point: {
        amount: 100,
        bonusAmount: 50,
        lyLimitedBonusAmount: 10,
        premiumAmount: 300,
        premiumBonusAmount: 100,
        lyLimitedPremiumBonusAmount: 50,
      },
    })
    expect(it.roughPoint).toBe(450) // 300+100+50 > 100+50+10
  })

  it('JAN正規化・販売者・画像・状態を拾う', () => {
    const it = normalizeHit(base)
    expect(it.jan).toBe('4580038873259')
    expect(it.sellerId).toBe('ebest')
    expect(it.sellerRating).toBe(4.6)
    expect(it.image).toBe('m.jpg')
    expect(it.condition).toBe('new')
    expect(it.inStock).toBe(true)
    expect(it.key).toBe('ebest::abc123')
    expect(keyOf(it)).toBe('ebest::abc123')
  })

  it('店舗独自コード（20〜29始まり）はJANにしない', () => {
    expect(normalizeHit({ ...base, janCode: '2012345678901' }).jan).toBeNull()
    expect(normalizeHit({ ...base, janCode: '4900000000001' }).jan).toBe('4900000000001')
  })

  it('送料コード2だけ送料無料、未指定は不明にする', () => {
    expect(normalizeHit({ ...base, shipping: { code: 2 } }).shippingFree).toBe(true)
    expect(normalizeHit({ ...base, shipping: { code: 3 } }).shippingFree).toBe(false)
    expect(normalizeHit({ ...base, shipping: { code: 1 } }).shippingFree).toBe(false)
    expect(normalizeHit(base).shippingFree).toBeNull()
  })
})

describe('splitBand', () => {
  it('取得上限以下はそのまま', () => {
    expect(splitBand([10000, 20000], 950)).toEqual([[10000, 20000]])
  })
  it('950超は二分割', () => {
    expect(splitBand([10000, 20000], 951)).toEqual([
      [10000, 15000],
      [15000, 20000],
    ])
  })
  it('上限なしの帯は分割しない', () => {
    expect(splitBand([200000, null], 5000)).toEqual([[200000, null]])
  })
  it('これ以上割れない帯はそのまま返す', () => {
    expect(splitBand([100, 101], MAX_REACHABLE + 1)).toEqual([[100, 101]])
  })
  it('件数が多すぎる帯は割らない（巨大ジャンルで何時間もかかるのを防ぐ）', () => {
    expect(splitBand([10000, 20000], 179345)).toEqual([[10000, 20000]])
  })
})

describe('適応待機', () => {
  it('429系を踏むと間隔を1.6倍（上限8000ms）に伸ばす', () => {
    expect(adaptDelay(1200, true)).toBe(1920)
    expect(adaptDelay(7000, true)).toBe(8000)
  })
  it('成功が続くと0.95倍（下限1200ms）に戻す', () => {
    expect(adaptDelay(8000, false)).toBe(7600)
    expect(adaptDelay(1200, false)).toBe(1200)
  })
  it('再試行対象と待機時間', () => {
    expect(shouldRetry(429)).toBe(true)
    expect(shouldRetry(503)).toBe(true)
    expect(shouldRetry(404)).toBe(false)
    expect(backoffMs(0)).toBe(2000)
    expect(backoffMs(2)).toBe(8000)
  })
  it('429は小刻みに送り直さず60秒待つ。500系は倍々で待つ', () => {
    expect(retryWaitMs(429, 0)).toBe(60000)
    expect(retryWaitMs(429, 3)).toBe(60000)
    expect(retryWaitMs(503, 1)).toBe(4000)
  })
  it('60秒以内には再送せず、制限が続けばさらに60秒待って回復する', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ hits: [] }) })
      const client = createSearchClient({ appid: 'TEST', fetchImpl })
      const result = client.byJan('4900000000001')
      await vi.advanceTimersByTimeAsync(59999)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(59999)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toEqual([])
      expect(fetchImpl).toHaveBeenCalledTimes(3)
      expect(client.stats.rateLimitHits).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
