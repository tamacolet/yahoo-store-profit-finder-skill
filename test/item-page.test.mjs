import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickProps, parseItemProps, parseItemPage, extractNextData, createPageFetcher } from '../lib/item-page.mjs'

// 実物に近い __NEXT_DATA__ の pageProps 固定データ
const PAGE_PROPS = {
  item: {
    name: 'iPhone 17 Pro 256GB SIMフリー シルバー MG854J/A',
    applicablePrice: 198000,
    premiumPrice: 182000,
    regularPrice: 201000,
    janCode: '4549995649154',
    isUsed: false,
    usedConditionText: null,
    badge: { isCoupon: true, isBonusPlus: true },
    stock: { isAvailable: true, quantity: 5, maxPurchaseQuantity: 2, stockText: '在庫あり' },
  },
  point: {
    totalPoint: 26253,
    totalPointWithEntry: 34253,
    totalPointRatio: 0.14,
    isCapReached: true,
    priorityPayMethodText: 'PayPay残高',
    currentCampaignList: [{ partsCampaignList: [
      { title: '通常特典', point: 100, ratio: 0.01, isReachedLimit: false },
    ] }],
    conditionalCampaignList: [
      {
        partsCampaignList: [
          { title: 'ボーナスストアPlus ＋4％', point: 5000, ratio: 0.04, isReachedLimit: true },
          { title: 'LYPマイルド', point: 3000, ratio: 0.02, isReachedLimit: false },
        ],
      },
    ],
  },
  user: { isPremiumUser: true },
  postage: { fee: 500, isPostageFree: false },
}

describe('pickProps', () => {
  it('外部参照なしの自己完結関数として評価できる（toString埋め込み経路）', () => {
    // Phi では pickProps.toString() をページ内に埋め込む。関数を再構成しても同じ結果になること。
    const revived = new Function(`return (${pickProps.toString()})`)()
    const picked = revived(PAGE_PROPS)
    expect(picked.item.name).toBe(PAGE_PROPS.item.name)
    expect(picked.point.totalPoint).toBe(26253)
    expect(picked.point.campaigns).toHaveLength(3)
    expect(picked.user.isPremiumUser).toBe(true)
  })

  it('必要な項目だけに絞る', () => {
    const picked = pickProps(PAGE_PROPS)
    expect(Object.keys(picked)).toEqual(['item', 'point', 'postage', 'user'])
    expect(picked.item.stock).toEqual({
      isAvailable: true,
      quantity: 5,
      maxPurchaseQuantity: 2,
      stockText: '在庫あり',
    })
    expect(picked.point.campaigns[0]).toEqual({
      title: '通常特典',
      point: 100,
      ratio: 0.01,
      isReachedLimit: false,
      conditional: false,
    })
    expect(picked.point.campaigns[1].conditional).toBe(true)
    expect(picked.postage).toEqual({ fee: 500, isFree: false })
    expect(picked.user).toEqual({ isLoggedIn: true, isPremiumUser: true })
  })

  it('未ログイン（user=null）でも落ちない', () => {
    const picked = pickProps({ ...PAGE_PROPS, user: null })
    expect(picked.user.isPremiumUser).toBe(false)
    expect(picked.user.isLoggedIn).toBe(false)
    expect(pickProps({ ...PAGE_PROPS, user: {} }).user.isLoggedIn).toBe(false)
  })
})

describe('parseItemProps', () => {
  it('basePrice は applicablePrice と premiumPrice の安い方', () => {
    const p = parseItemProps(pickProps(PAGE_PROPS))
    expect(p.price).toBe(198000)
    expect(p.premiumPrice).toBe(182000)
    expect(p.basePrice).toBe(182000)
  })

  it('premiumPrice が無ければ applicablePrice', () => {
    const pp = JSON.parse(JSON.stringify(PAGE_PROPS))
    pp.item.premiumPrice = null
    const p = parseItemProps(pickProps(pp))
    expect(p.basePrice).toBe(198000)
  })

  it('JANの20〜29始まりは除外・69は通す', () => {
    const pp = JSON.parse(JSON.stringify(PAGE_PROPS))
    pp.item.janCode = '2012345678901'
    expect(parseItemProps(pickProps(pp)).jan).toBeNull()
    pp.item.janCode = '6971818582511'
    expect(parseItemProps(pickProps(pp)).jan).toBe('6971818582511')
  })

  it('totalPointWithEntry が無ければ totalPoint にフォールバック', () => {
    const pp = JSON.parse(JSON.stringify(PAGE_PROPS))
    delete pp.point.totalPointWithEntry
    const p = parseItemProps(pickProps(pp))
    expect(p.totalPoint).toBe(26253)
    expect(p.totalPointWithEntry).toBe(26253)
  })

  it('クーポン・ボーナス・在庫・上限を拾う', () => {
    const p = parseItemProps(pickProps(PAGE_PROPS))
    expect(p.hasCoupon).toBe(true)
    expect(p.isBonusPlus).toBe(true)
    expect(p.isCapReached).toBe(true)
    expect(p.stockAvailable).toBe(true)
    expect(p.stockQuantity).toBe(5)
    expect(p.maxPurchase).toBe(2)
    expect(p.campaigns[1].reachedLimit).toBe(true)
    expect(p.campaigns[1].conditional).toBe(true)
    expect(p.payMethodText).toBe('PayPay残高')
    expect(p.shippingFee).toBe(500)
    expect(p.shippingFree).toBe(false)
    expect(p.isLoggedIn).toBe(true)
  })

  it('stock が丸ごと無い商品は在庫不明（null）', () => {
    const pp = JSON.parse(JSON.stringify(PAGE_PROPS))
    delete pp.item.stock
    const p = parseItemProps(pickProps(pp))
    expect(p.stockAvailable).toBeNull()
  })
})

describe('parseItemPage / extractNextData', () => {
  it('HTMLから __NEXT_DATA__ を抜いてパースする', () => {
    const html =
      '<html><body><script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({ props: { pageProps: PAGE_PROPS } }) +
      '</script></body></html>'
    const p = parseItemPage(html)
    expect(p.basePrice).toBe(182000)
    expect(p.jan).toBe('4549995649154')
  })

  it('__NEXT_DATA__ が無い/壊れたHTMLは null', () => {
    expect(parseItemPage('<html></html>')).toBeNull()
    expect(extractNextData('<script id="__NEXT_DATA__">{oops</script>')).toBeNull()
  })
})

describe('createPageFetcher', () => {
  it('Phiのプロファイル指定と直近ページのログイン状態からsourceを決める', async () => {
    const phiPath = join(mkdtempSync(join(tmpdir(), 'ypf-phi-')), 'fake.mjs')
    writeFileSync(phiPath, 'export async function loadPhi() { return globalThis.__ypfTestPhi }')
    const calls = []
    const pages = [PAGE_PROPS, { ...PAGE_PROPS, user: {} }]
    globalThis.__ypfTestPhi = {
      async enterContext(options) { calls.push(options) },
      async openTab(url) { calls.push(url) },
      async js() { return JSON.stringify(pickProps(pages.shift())) },
      async closeShadowWindow(name) { calls.push(name) },
    }
    const f = createPageFetcher({
      mode: 'phi', phiPath, delayMs: 0,
      fetchImpl: () => { throw new Error('匿名経路に落ちた') },
    })
    try {
      expect(f.loginState).toBeNull()
      expect(f.source).toBe('page-anon')
      expect((await f.fetch('https://example.test/a')).isPremiumUser).toBe(true)
      expect(calls[0]).toEqual({ kind: 'shadow', name: 'ypf-deep', profile: process.env.YAHOO_PHI_PROFILE || 'Default' })
      expect(f.loginState).toBe('premium')
      expect(f.source).toBe('page-login')
      await f.fetch('https://example.test/b')
      expect(f.loginState).toBe('anon')
      expect(f.source).toBe('page-anon')
    } finally {
      await f.close()
      delete globalThis.__ypfTestPhi
    }
    expect(calls.at(-1)).toBe('ypf-deep')
  })
})
