import { describe, it, expect } from 'vitest'
import { pickBuyback, rankOf, judgeItem, compareResults, USED_NAME_RE } from '../lib/judge.mjs'

const NOW = new Date('2026-09-27T12:00:00+09:00')
const ago = (days) => {
  const d = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

describe('pickBuyback（買取の鮮度選択）', () => {
  it('30日以内の最高値を使う', () => {
    const data = {
      jan: '4900000000001',
      prices: [
        { shop: '森森', price: 100000, time: ago(3) },
        { shop: '商店', price: 120000, time: ago(40) }, // 古すぎて除外
        { shop: 'wiki', price: 90000, time: ago(1) },
      ],
    }
    const p = pickBuyback(data, NOW)
    expect(p.max).toBe(100000)
    expect(p.shop).toBe('森森')
    expect(p.stale).toBe(false)
    expect(p.shops).toHaveLength(2)
  })

  it('7日より古い値しか無い時は stale=true', () => {
    const data = { jan: 'x', prices: [{ shop: '森森', price: 50000, time: ago(10) }] }
    const p = pickBuyback(data, NOW)
    expect(p.max).toBe(50000)
    expect(p.stale).toBe(true)
  })

  it('30日超しか無い・エラー・空は使わない', () => {
    expect(pickBuyback({ jan: 'x', prices: [{ shop: 'a', price: 1, time: ago(31) }] }, NOW).max).toBeNull()
    expect(pickBuyback({ error: '商品が見つかりません', jan: 'x' }, NOW).max).toBeNull()
    expect(pickBuyback(null, NOW).max).toBeNull()
  })
})

describe('rankOf', () => {
  it('A/B/C/- の判定', () => {
    expect(rankOf(100, 200)).toBe('A')
    expect(rankOf(-100, 200)).toBe('B')
    expect(rankOf(-100, -50)).toBe('C')
    expect(rankOf(null, null)).toBe('-')
    expect(rankOf(0, 0)).toBe('C') // 0円は黒字ではない
  })
})

describe('judgeItem', () => {
  const base = {
    key: 'ebest::x1',
    sellerId: 'ebest',
    url: 'https://store.shopping.yahoo.co.jp/ebest/x1.html',
    name: 'OPPO Find X9 Ultra 16GB/512GB ホワイト',
    jan: '4900000000001',
    matchType: 'jan',
    masterName: 'OPPO Find X9 Ultra 16GB/512GB ホワイト',
    price: 274800,
    basePrice: 231490,
    pointConservative: 26253,
    pointMax: 34253,
    pointSource: 'page-login',
    shippingFree: true,
    stockAvailable: true,
    stockQuantity: 9,
    buybackData: { jan: '4900000000001', prices: [{ shop: '森森', price: 233500, time: ago(1) }] },
  }

  it('実質・利益・利益率・ランクを計算する', () => {
    const r = judgeItem(base, { now: NOW })
    expect(r.effective).toEqual({ conservative: 205237, max: 197237 })
    expect(r.profit).toEqual({ conservative: 28263, max: 36263 })
    expect(r.profitRate).toBe(18.4)
    expect(r.rank).toBe('A')
    expect(r.buyback.max).toBe(233500)
    expect(r.buyback.shop).toBe('森森')
    expect(r.risks).toEqual([])
    expect(r.flags.premiumDeal).toBe(true)
    expect(r.point.source).toBe('page-login')
    expect(r.point.payMethodText).toBeNull()
    expect(r.shipping).toEqual({ fee: null, free: true })
    expect(r.confidence).toBe('high')
    expect(r.variants).toBe(1)
  })

  it('買取が無いとランク-になる', () => {
    const r = judgeItem({ ...base, buybackData: null }, { now: NOW })
    expect(r.rank).toBe('-')
    expect(r.profit).toEqual({ conservative: null, max: null })
  })

  it('risks: 中古・キャリア・型番照合・在庫・上限・安すぎ', () => {
    const r = judgeItem(
      {
        ...base,
        name: '【中古】iPhone 16 docomo版',
        isUsed: true,
        isCapReached: true,
        matchType: 'model',
        stockAvailable: null,
        buybackData: { jan: 'x', prices: [{ shop: '森森', price: 400000, time: ago(1) }] },
      },
      { now: NOW },
    )
    // 実質(確実)=231490-26253=205237 < 400000*0.5=200000 → いや 205237 > 200000 → 付かない
    expect(r.risks).toContain('中古・整備品')
    expect(r.risks).toContain('キャリア版')
    expect(r.risks).toContain('ポイント上限到達')
    expect(r.risks).toContain('在庫不明')
    expect(r.risks).toContain('型番照合（要確認）')
    expect(r.risks).not.toContain('価格が安すぎる（要確認）')
    expect(r.confidence).toBe('low')
  })

  it('価格が安すぎる（実質が買取の50%未満）を立てる', () => {
    const r = judgeItem(
      {
        ...base,
        basePrice: 10000,
        pointConservative: 0,
        pointMax: 0,
        buybackData: { jan: 'x', prices: [{ shop: '森森', price: 233500, time: ago(1) }] },
      },
      { now: NOW },
    )
    expect(r.risks).toContain('価格が安すぎる（要確認）')
    expect(r.confidence).toBe('low')
  })

  it('買取価格が古いを立てる', () => {
    const r = judgeItem(
      { ...base, buybackData: { jan: 'x', prices: [{ shop: '森森', price: 233500, time: ago(10) }] } },
      { now: NOW },
    )
    expect(r.risks).toContain('買取価格が古い')
    expect(r.confidence).toBe('mid')
  })

  it('在庫なし/名前の中古表記でも拾う', () => {
    const r = judgeItem(
      { ...base, name: '整備済み品 iPad', stockAvailable: false },
      { now: NOW },
    )
    expect(r.risks).toContain('中古・整備品')
    expect(r.risks).toContain('在庫なし')
    expect(r.confidence).toBe('low')
  })

  it('送料を実質価格と利益に加え、支払い方法・キャンペーン・販売形態数を保持する', () => {
    const campaigns = [{ name: '特典', conditional: true, reachedLimit: false }]
    const r = judgeItem({ ...base, shippingFee: 500, shippingFree: false, payMethodText: 'PayPay残高', campaigns, variants: 3 }, { now: NOW })
    expect(r.effective).toEqual({ conservative: 205737, max: 197737 })
    expect(r.profit).toEqual({ conservative: 27763, max: 35763 })
    expect(r.shipping).toEqual({ fee: 500, free: false })
    expect(r.risks).not.toContain('送料別の可能性')
    expect(r.point.payMethodText).toBe('PayPay残高')
    expect(r.campaigns).toEqual(campaigns)
    expect(r.variants).toBe(3)
  })

  it('送料が未確定で送料無料と分からない場合だけ注意を出す', () => {
    for (const shippingFree of [false, null, undefined]) {
      const r = judgeItem({ ...base, shippingFee: null, shippingFree }, { now: NOW })
      expect(r.risks).toContain('送料別の可能性')
      expect(r.effective.conservative).toBe(205237)
    }
    expect(judgeItem({ ...base, shippingFee: 0, shippingFree: false }, { now: NOW }).risks).not.toContain('送料別の可能性')
  })

  it('送料で黒字から赤字に変わる場合はランクにも反映する', () => {
    const rec = {
      ...base,
      basePrice: 100000,
      pointConservative: 0,
      pointMax: 0,
      buybackData: { prices: [{ shop: '森森', price: 100100, time: ago(1) }] },
    }
    expect(judgeItem({ ...rec, shippingFee: 0 }, { now: NOW }).rank).toBe('A')
    expect(judgeItem({ ...rec, shippingFee: 200 }, { now: NOW }).rank).toBe('C')
  })

  it('海外版の表記をすべて検知してJAN照合の確信度を中にする', () => {
    for (const label of ['海外版', '海外SIM', 'グローバル版', '並行輸入', '香港版', '米国版', '輸入品']) {
      const r = judgeItem({ ...base, name: `OPPO ${label}` }, { now: NOW })
      expect(r.risks).toContain('海外版')
      expect(r.confidence).toBe('mid')
    }
  })

  it('キャリア版・在庫なしは中、型番照合・中古は低を優先する', () => {
    expect(judgeItem({ ...base, name: 'docomo OPPO' }, { now: NOW }).confidence).toBe('mid')
    expect(judgeItem({ ...base, stockAvailable: false }, { now: NOW }).confidence).toBe('mid')
    const restricted = judgeItem({ ...base, name: 'iPhone 16e 判定△品' }, { now: NOW })
    expect(restricted.risks).toContain('利用制限△')
    expect(restricted.confidence).toBe('mid')
    expect(judgeItem({ ...base, matchType: 'model' }, { now: NOW }).confidence).toBe('low')
    expect(judgeItem({ ...base, name: '中古 海外版 OPPO' }, { now: NOW }).confidence).toBe('low')
  })
})

describe('compareResults', () => {
  it('ランク→確信度→利益（最大）降順', () => {
    const a = { rank: 'A', confidence: 'high', profit: { max: 100 } }
    const b = { rank: 'A', confidence: 'high', profit: { max: 500 } }
    const c = { rank: 'A', confidence: 'mid', profit: { max: 9999 } }
    const d = { rank: 'A', confidence: 'low', profit: { max: 20000 } }
    const e = { rank: 'B', confidence: 'high', profit: { max: 30000 } }
    const f = { rank: '-', confidence: 'high', profit: { max: null } }
    expect([e, d, c, a, f, b].sort(compareResults)).toEqual([b, a, c, d, e, f])
  })
})

describe('USED_NAME_RE', () => {
  it('中古・展示品・開封品に当たる', () => {
    for (const n of ['【中古】iPad', '展示品 FMV', '訳ありNew Bridge', '開封品 iPhone']) expect(USED_NAME_RE.test(n)).toBe(true)
  })
  it('新品未使用・未開封には当たらない', () => {
    for (const n of ['【新品未使用】iPhone 17', '未開封品 Switch 2', '新品 未開封']) expect(USED_NAME_RE.test(n)).toBe(false)
  })
  it('機能説明の「再生」には当たらない', () => {
    for (const n of ['ブルーレイ再生対応 レコーダー', '連続再生30時間 イヤホン']) expect(USED_NAME_RE.test(n)).toBe(false)
  })
  it('中古のランク表記・本体のみ・新古品も拾う', () => {
    for (const n of ['【Bランク・本体のみ】Pixel 8a', '【新古品】arrows We', '美品 iPhone 15', '箱不良・シュリンク破れ品 iPhone 16e']) expect(USED_NAME_RE.test(n)).toBe(true)
  })
  it('再生品・難あり・箱の傷みも拾う', () => {
    for (const label of ['再生新品', '再生品', 'メーカー再生', 'リファビッシュ', 'アウトレット', '難あり', '箱破損', '箱なし', '箱無し']) {
      expect(USED_NAME_RE.test(`${label} iPhone`)).toBe(true)
    }
  })
})
