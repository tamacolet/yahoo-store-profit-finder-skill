import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScan, applyDiff, mergeVariants } from '../lib/scan.mjs'
import { buildMasterIndex } from '../lib/matcher.mjs'
import { createStore } from '../lib/store.mjs'

const MASTER = [
  { JAN: '4900000000001', itemName: 'Foo Phone 64GB AB1234/C', category: 'スマートフォン' },
  { JAN: '4900000000002', itemName: 'Bar Pad 128GB XY9876Z/A', category: 'タブレット' },
]

const HIT1 = {
  key: 'shop1::aaa',
  code: 'aaa',
  jan: '4900000000001',
  name: '【新品】Foo Phone 64GB AB1234C',
  url: 'https://store.shopping.yahoo.co.jp/shop1/aaa.html',
  sellerId: 'shop1',
  sellerName: 'Shop1',
  sellerRating: 4.5,
  image: 'img1.jpg',
  genreName: 'スマホ',
  condition: 'new',
  inStock: true,
  price: 10000,
  premiumPrice: 9000,
  hasPremiumDeal: true,
  basePrice: 9000,
  roughPoint: 300,
}

const HIT2 = {
  key: 'shop2::bbb',
  code: 'bbb',
  jan: null,
  name: 'Bar Pad 128GB XY9876ZA ブルー',
  url: 'https://store.shopping.yahoo.co.jp/shop2/bbb.html',
  sellerId: 'shop2',
  sellerName: 'Shop2',
  sellerRating: 4.0,
  image: null,
  genreName: 'タブレット',
  condition: 'new',
  inStock: true,
  price: 5000,
  premiumPrice: null,
  hasPremiumDeal: false,
  basePrice: 5000,
  roughPoint: 100,
}

const HIT3 = {
  key: 'shop3::ccc',
  code: 'ccc',
  jan: null,
  name: '謎のガジェット',
  url: 'https://store.shopping.yahoo.co.jp/shop3/ccc.html',
  sellerId: 'shop3',
  condition: 'new',
  inStock: true,
  price: 1000,
  basePrice: 1000,
  roughPoint: 0,
}

const DROP_USED = { ...HIT1, key: 'shop1::u1', code: 'u1', condition: 'used' }
const DROP_OOS = { ...HIT1, key: 'shop1::o1', code: 'o1', inStock: false }

const PRICES = {
  '4900000000001': {
    name: 'Foo Phone', jan: '4900000000001',
    prices: [{ shop: '森森', price: 12000, time: '2026-09-26 10:00' }],
    maxPrice: 12000,
  },
  '4900000000002': {
    name: 'Bar Pad', jan: '4900000000002',
    prices: [{ shop: '商店', price: 4000, time: '2026-09-26 10:00' }],
    maxPrice: 4000,
  },
}

function makeDeps({ hits = [HIT1, HIT2, HIT3], prices = PRICES, pages = {}, onPageFetch, tmp } = {}) {
  const store = createStore({ dir: tmp || mkdtempSync(join(tmpdir(), 'scan-test-')) })
  return {
    store,
    now: () => new Date('2026-09-27T12:00:00+09:00'),
    search: {
      stats: { rateLimitHits: 0, delayMs: 0 },
      collect: async () => ({ items: hits }),
      byJan: async () => hits,
    },
    buyback: {
      master: async () => MASTER,
      masterIndex: async () => buildMasterIndex(MASTER),
      masterCategories: async () => [{ name: 'スマートフォン', count: 1 }],
      async pricesForJans(jans, { onProgress } = {}) {
        jans.forEach((_, i) => onProgress?.(i + 1, jans.length))
        return new Map(jans.map((j) => [j, prices[j] || { jan: j, error: 'なし' }]))
      },
    },
    pageFetcherFactory: ({ mode }) => ({
      source: mode === 'phi' ? 'page-login' : 'page-anon',
      fetch: async (url) => {
        onPageFetch?.(url)
        return pages[url] ?? null
      },
      close: async () => {},
    }),
  }
}

const baseParams = {
  mode: 'genre',
  presets: ['smartphone'],
  keyword: '',
  sellerId: '',
  priceFrom: null,
  priceTo: null,
  masterCategories: [],
  minBuyback: 0,
  deepCheck: 'off',
  deepLimit: 80,
}

describe('runScan 結合', () => {
  it('search→match→buyback→save→done の順にイベントが出る', async () => {
    const events = []
    const deps = makeDeps({ hits: [HIT1, HIT2, HIT3, DROP_USED, DROP_OOS] })
    const doc = await runScan({ ...baseParams }, { deps, onEvent: (e) => events.push(e) })

    const stages = events.filter((e) => e.type === 'progress').map((e) => e.stage)
    expect(stages[0]).toBe('search')
    expect(stages.indexOf('match')).toBeGreaterThan(stages.lastIndexOf('search'))
    expect(stages.indexOf('buyback')).toBeGreaterThan(stages.indexOf('match'))
    expect(stages.indexOf('save')).toBeGreaterThan(stages.lastIndexOf('buyback'))
    expect(events.at(-1).type).toBe('done')
    expect(events.some((e) => e.type === 'items')).toBe(true)

    expect(doc.status).toBe('done')
    expect(doc.summary.listings).toBe(3) // used/在庫なしは捨てる
    expect(doc.summary.matched).toBe(2)
    expect(doc.summary.matchedByModel).toBe(1)
    expect(doc.items).toHaveLength(2)

    const a = doc.items.find((r) => r.key === 'shop1::aaa')
    expect(a.rank).toBe('A') // 12000 - (9000-300) = +3300
    expect(a.matchType).toBe('jan')
    expect(a.flags.premiumDeal).toBe(true)

    const b = doc.items.find((r) => r.key === 'shop2::bbb')
    expect(b.rank).toBe('C') // 4000 - (5000-100) = -900
    expect(b.matchType).toBe('model')
    expect(b.risks).toContain('型番照合（要確認）')
    expect(b.jan).toBe('4900000000002')

    // 保存されている
    const saved = await deps.store.get(doc.id)
    expect(saved.items).toHaveLength(2)
  })

  it('deep: 商品ページの確定値に置き換わる', async () => {
    const deps = makeDeps({
      hits: [HIT1, HIT2],
      pages: {
        'https://store.shopping.yahoo.co.jp/shop1/aaa.html': {
          price: 9000,
          basePrice: 9000,
          totalPoint: 2000,
          totalPointWithEntry: 4000,
          isCapReached: false,
          campaigns: [],
          hasCoupon: false,
          isBonusPlus: false,
          isUsed: false,
          stockAvailable: true,
          stockQuantity: 3,
          maxPurchase: 1,
        },
      },
    })
    const events = []
    const doc = await runScan(
      { ...baseParams, deepCheck: 'phi', deepLimit: 10 },
      { deps, onEvent: (e) => events.push(e) },
    )
    expect(events.some((e) => e.type === 'progress' && e.stage === 'deep')).toBe(true)
    expect(doc.summary.pointSource).toBe('page-login')
    expect(doc.summary.deepChecked).toBe(1)

    const a = doc.items.find((r) => r.key === 'shop1::aaa')
    expect(a.point).toEqual({ conservative: 2000, max: 4000, source: 'page-login', payMethodText: null })
    expect(a.effective.max).toBe(5000)
    expect(a.profit.max).toBe(7000)
    expect(a.flags.maxPurchase).toBe(1)
    expect(a.stock.quantity).toBe(3)
  })

  it('中断すると status:cancelled で保存される', async () => {
    const ctrl = new AbortController()
    const deps = makeDeps({
      hits: [HIT1, HIT2],
      pages: { 'https://store.shopping.yahoo.co.jp/shop1/aaa.html': { basePrice: 9000, totalPoint: 100 } },
      onPageFetch: () => ctrl.abort(),
    })
    const events = []
    const doc = await runScan(
      { ...baseParams, deepCheck: 'phi' },
      { deps, onEvent: (e) => events.push(e), signal: ctrl.signal },
    )
    expect(doc.status).toBe('cancelled')
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' })
    const saved = await deps.store.get(doc.id)
    expect(saved.status).toBe('cancelled')
  })

  it('差分: 前回より1%以上の値下げ→priceDrop、新キー→isNew', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scan-diff-'))
    const deps1 = makeDeps({ tmp, hits: [HIT1] })
    await runScan({ ...baseParams }, { deps: deps1, onEvent: () => {} })

    const cheaper = { ...HIT1, basePrice: 8000, price: 8000, premiumPrice: null, hasPremiumDeal: false }
    const deps2 = makeDeps({ tmp, hits: [cheaper, HIT2] })
    const doc = await runScan({ ...baseParams }, { deps: deps2, onEvent: () => {} })

    const a = doc.items.find((r) => r.key === 'shop1::aaa')
    expect(a.flags.priceDrop).toEqual({ prev: 9000, delta: -1000 })
    const b = doc.items.find((r) => r.key === 'shop2::bbb')
    expect(b.flags.isNew).toBe(true)
  })

  it('applyDiff: 過去スキャンが0件なら isNew を付けない', () => {
    const items = [{ key: 'a::1', basePrice: 100, flags: { isNew: false, priceDrop: null } }]
    applyDiff(items, new Map(), false)
    expect(items[0].flags.isNew).toBe(false)
    applyDiff(items, new Map(), true)
    expect(items[0].flags.isNew).toBe(true)
  })
})

describe('買取が全件取得エラー', () => {
  it('黙って黒字なしにせず status:error で止まる', async () => {
    const events = []
    const deps = makeDeps({ prices: {} })
    deps.buyback.pricesForJans = async (jans) => new Map(jans.map((j) => [j, { jan: j, error: 'メタデータ取得失敗: 401' }]))
    const doc = await runScan({ ...baseParams }, { deps, onEvent: (e) => events.push(e) })
    expect(doc.status).toBe('error')
    expect(events.find((e) => e.type === 'error').message).toMatch(/1件も取得できません/)
  })
})

describe('追加のスキャン判定', () => {
  it('同一ストア・JAN・価格は1行にまとめ、在庫ありを残す', async () => {
    const second = { ...HIT1, key: 'shop1::color2', code: 'color2', name: 'Foo Phone 色違い' }
    const doc = await runScan(baseParams, { deps: makeDeps({ hits: [HIT1, second] }) })
    expect(doc.items).toHaveLength(1)
    expect(doc.items[0].key).toBe(HIT1.key)
    expect(doc.items[0].variants).toBe(2)
    expect(doc.summary.duplicatesMerged).toBe(1)
    expect(doc.summary.rankA).toBe(1)
    expect(mergeVariants([
      { sellerId: 's', jan: 'j', basePrice: 1, variants: 1, stock: { available: false }, key: 'a' },
      { sellerId: 's', jan: 'j', basePrice: 1, variants: 1, stock: { available: true }, key: 'b' },
    ])[0]).toMatchObject({ key: 'b', variants: 2 })
  })

  it('deepではJAN一致を先に確認し、送料・支払方法・ログイン状態を反映する', async () => {
    const urls = []
    const deps = makeDeps({
      hits: [HIT2, { ...HIT1, shippingFree: false }],
      prices: { ...PRICES, '4900000000002': { ...PRICES['4900000000002'], prices: [{ shop: '商店', price: 9000, time: '2026-09-26 10:00' }] } },
      pages: { [HIT1.url]: {
        basePrice: 9000, totalPoint: 500, totalPointWithEntry: 500,
        shippingFee: 600, shippingFree: false, payMethodText: 'PayPay',
        campaigns: [{ title: '特典', point: 50, ratio: 0.01, reachedLimit: false, conditional: true }],
      } },
      onPageFetch: (url) => urls.push(url),
    })
    deps.pageFetcherFactory = () => ({ source: 'page-login', loginState: 'premium', fetch: async (url) => {
      urls.push(url)
      return url === HIT1.url ? {
        basePrice: 9000, totalPoint: 500, totalPointWithEntry: 500,
        shippingFee: 600, shippingFree: false, payMethodText: 'PayPay',
        campaigns: [{ title: '特典', point: 50, ratio: 0.01, reachedLimit: false, conditional: true }],
      } : null
    }, close: async () => {} })
    const doc = await runScan({ ...baseParams, deepCheck: 'phi', deepLimit: 1 }, { deps })
    expect(urls).toEqual([HIT1.url])
    expect(doc.summary.loginState).toBe('premium')
    const item = doc.items.find((r) => r.key === HIT1.key)
    expect(item.shipping).toEqual({ fee: 600, free: false })
    expect(item.effective.max).toBe(9100)
    expect(item.point.payMethodText).toBe('PayPay')
    expect(item.campaigns[0].conditional).toBe(true)
  })

  it('収集が途中で止まっても、集めた分で判定して警告を残す', async () => {
    const events = []
    const deps = makeDeps()
    deps.search.collect = async () => ({ items: [HIT1, HIT2], error: 'リトライ上限。最後のエラー: HTTP 429' })
    const doc = await runScan({ ...baseParams }, { deps, onEvent: (ev) => events.push(ev) })
    expect(doc.status).toBe('done')
    expect(doc.summary.listings).toBe(2)
    expect(doc.summary.warnings[0]).toContain('途中で打ち切りました')
    expect(events.filter((ev) => ev.type === 'warning')).toHaveLength(1)
  })

  it('Phiで匿名ページならwarningを1回流す', async () => {
    const events = []
    const deps = makeDeps({ hits: [HIT1, HIT2], pages: { [HIT1.url]: { basePrice: 9000, totalPoint: 100 } } })
    deps.pageFetcherFactory = () => ({ source: 'page-anon', loginState: 'anon', fetch: async () => ({ basePrice: 9000, totalPoint: 100 }), close: async () => {} })
    const doc = await runScan({ ...baseParams, deepCheck: 'phi', deepLimit: 2 }, { deps, onEvent: (ev) => events.push(ev) })
    expect(events.filter((ev) => ev.type === 'warning')).toHaveLength(1)
    expect(doc.summary.warnings).toHaveLength(1)
    expect(doc.summary.loginState).toBe('anon')
    expect(doc.summary.pointSource).toBe('page-anon')
  })

  it('reverseは買取高い順に上限を適用し、各JAN検索前に待つ', async () => {
    const calls = []
    const deps = makeDeps({ hits: [] })
    deps.search.stats.delayMs = 25
    deps.search.byJan = async (jan) => { calls.push(`search:${jan}`); return [] }
    deps.wait = async (ms) => { calls.push(`wait:${ms}`) }
    deps.buyback.pricesForJans = async () => new Map([
      ['4900000000001', { prices: [{ shop: 'a', price: 2000, time: '2026-09-26 10:00' }] }],
      ['4900000000002', { prices: [{ shop: 'a', price: 5000, time: '2026-09-26 10:00' }] }],
      ['4900000000003', { prices: [{ shop: 'a', price: 3000, time: '2026-09-26 10:00' }] }],
    ])
    deps.buyback.master = async () => [
      ...MASTER.map((m) => ({ ...m, category: 'スマートフォン' })),
      { JAN: '4900000000003', itemName: 'Third', category: 'スマートフォン' },
    ]
    const doc = await runScan({ ...baseParams, mode: 'reverse', masterCategories: ['スマートフォン'], reverseLimit: 2 }, { deps })
    expect(doc.status).toBe('done')
    expect(calls).toEqual(['wait:25', 'search:4900000000002', 'wait:25', 'search:4900000000003'])
  })

  it('reverseの待機中に中断すればJAN検索を始めない', async () => {
    const deps = makeDeps({ hits: [] })
    deps.search.stats.delayMs = 10000
    let searched = false
    deps.search.byJan = async () => { searched = true; return [] }
    deps.buyback.pricesForJans = async () => new Map([
      ['4900000000001', { prices: [{ shop: 'a', price: 2000, time: '2026-09-26 10:00' }] }],
    ])
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10)
    const doc = await runScan({ ...baseParams, mode: 'reverse', masterCategories: ['スマートフォン'] }, { deps, signal: ctrl.signal })
    clearTimeout(timer)
    expect(doc.status).toBe('cancelled')
    expect(searched).toBe(false)
  })
})
