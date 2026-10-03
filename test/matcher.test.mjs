import { describe, it, expect } from 'vitest'
import {
  normalizeJan,
  extractModelTokens,
  normalizeModelToken,
  buildMasterIndex,
  matchListing,
} from '../lib/matcher.mjs'

describe('normalizeJan', () => {
  it('13桁と8桁を受理する', () => {
    expect(normalizeJan('4580038873259')).toBe('4580038873259')
    expect(normalizeJan('49123456')).toBe('49123456')
  })
  it('20〜29始まりの店舗独自コードは除外', () => {
    expect(normalizeJan('2012345678901')).toBeNull()
    expect(normalizeJan('29123456')).toBeNull()
  })
  it('69始まり（中国GS1）は正規JANとして通す', () => {
    expect(normalizeJan('6971818582511')).toBe('6971818582511')
  })
  it('桁違い・非数字は弾く', () => {
    expect(normalizeJan('12345')).toBeNull()
    expect(normalizeJan('abc')).toBeNull()
    expect(normalizeJan(null)).toBeNull()
    expect(normalizeJan('4580-0388-73259')).toBe('4580038873259')
  })
})

describe('型番トークン抽出', () => {
  it('英字+数字・正規化後6文字以上を抜く', () => {
    const toks = extractModelTokens('iPhone 17 Pro 256GB SIMフリー シルバー MG854J/A')
    expect(toks).toContain('MG854JA')
    expect(toks).not.toContain('256GB')
    expect(toks).not.toContain('IPHONE')
    expect(toks).not.toContain('17')
  })

  it('容量・規格だけのトークンは除く', () => {
    expect(normalizeModelToken('256GB')).toBeNull()
    expect(normalizeModelToken('1TB')).toBeNull()
    expect(normalizeModelToken('5G')).toBeNull()
    expect(normalizeModelToken('3000MAH')).toBeNull()
    expect(normalizeModelToken('120HZ')).toBeNull()
    expect(normalizeModelToken('WIFI6E')).toBeNull()
    expect(normalizeModelToken('USB3.2')).toBeNull()
  })

  it('区切り文字をまたいで分割する', () => {
    const toks = extractModelTokens('【新品】Apple iPhone17 Pro 256GB シルバー MG854JA 本体')
    expect(toks).toContain('MG854JA')
    expect(toks).toContain('IPHONE17')
    expect(toks).not.toContain('256GB')
  })

  it('型番らしくないトークンは落ちる', () => {
    expect(normalizeModelToken('APPLE')).toBeNull() // 数字なし
    expect(normalizeModelToken('12345')).toBeNull() // 英字なし
    expect(normalizeModelToken('AB12')).toBeNull() // 正規化後6未満
  })
})

describe('型番照合', () => {
  const master = [
    { JAN: '4900000000001', itemName: 'iPhone 17 Pro 256GB SIMフリー シルバー MG854J/A', category: 'スマートフォン' },
    { JAN: '4900000000002', itemName: 'iPad Air 11インチ 128GB Wi-Fi MC9X4J/A', category: 'タブレット' },
    { JAN: '4900000000003', itemName: 'Pixel Foo ZZ1111/A', category: 'スマートフォン' },
    { JAN: '4900000000004', itemName: 'Pixel Bar ZZ1111/A', category: 'スマートフォン' }, // 同じ型番→曖昧
  ]
  const index = buildMasterIndex(master)

  it('JAN一致を優先する', () => {
    const m = matchListing({ jan: '4900000000001', name: '全然違う名前' }, index)
    expect(m).toEqual({ jan: '4900000000001', matchType: 'jan', masterName: master[0].itemName })
  })

  it('実例: JANなし出品でも型番で一致する', () => {
    const m = matchListing(
      { jan: null, name: '【新品】Apple iPhone17 Pro 256GB シルバー MG854JA 本体' },
      index,
    )
    expect(m?.matchType).toBe('model')
    expect(m?.jan).toBe('4900000000001')
  })

  it('256GB や 5G だけでは一致しない', () => {
    expect(matchListing({ jan: null, name: '【新品】タブレット 256GB 5G 本体' }, index)).toBeNull()
    expect(matchListing({ jan: null, name: 'スマートフォン 128GB 5G SIMフリー' }, index)).toBeNull()
  })

  it('複数JANに対応する型番は索引から外れる', () => {
    // ZZ1111/A は 2 JAN に対応 → 索引に入らない
    expect(index.byModel.has('ZZ1111A')).toBe(false)
    expect(matchListing({ jan: null, name: 'Pixel ZZ1111A ブラック' }, index)).toBeNull()
  })

  it('出品名のトークンが複数の異なるJANに当たったら照合しない', () => {
    const ix = buildMasterIndex([
      { JAN: '4900000000010', itemName: 'Foo AA0001/A', category: 'x' },
      { JAN: '4900000000011', itemName: 'Bar BB0002/B', category: 'x' },
    ])
    const m = matchListing({ jan: null, name: 'Foo Bar AA0001A BB0002B セット' }, ix)
    expect(m).toBeNull()
  })

  it('マスターに無いJANの出品は型番照合に回る', () => {
    const m = matchListing({ jan: '4999999999999', name: 'iPad Air MC9X4JA ブルー' }, index)
    expect(m?.matchType).toBe('model')
    expect(m?.jan).toBe('4900000000002')
  })

  it('型番が同じでも容量に共通値がなければ照合しない', () => {
    expect(matchListing({ name: 'iPhone 17 Pro 512GB MG854JA' }, index)).toBeNull()
    expect(matchListing({ name: 'iPhone 17 Pro 8GB+512GB MG854JA' }, index)).toBeNull()
    expect(matchListing({ name: 'iPhone 17 Pro 12GB/512GB MG854JA' }, index)).toBeNull()
  })

  it('容量が共通ならRAM容量が違っても型番照合を保つ', () => {
    expect(matchListing({ name: 'iPhone 17 Pro 8GB+256GB MG854JA' }, index)?.matchType).toBe('model')
    expect(matchListing({ name: 'iPhone 17 Pro 12GB/256GB MG854JA' }, index)?.jan).toBe('4900000000001')
  })

  it('TBをGBに換算し、片側に容量が無い場合は既存の型番照合を保つ', () => {
    const tbIndex = buildMasterIndex([{ JAN: '4900000000099', itemName: 'Tablet 1024GB AB1234/C' }])
    expect(matchListing({ name: 'Tablet 1TB+16G AB1234C' }, tbIndex)?.matchType).toBe('model')
    expect(matchListing({ name: 'Tablet AB1234C' }, tbIndex)?.matchType).toBe('model')
    expect(matchListing({ name: 'Tablet 512GB AB1234C' }, tbIndex)).toBeNull()
  })

  it('JAN一致は容量違いでも優先する', () => {
    expect(matchListing({ jan: '4900000000001', name: 'iPhone 17 Pro 512GB MG854JA' }, index)?.matchType).toBe('jan')
  })
})

describe('付属品の型番照合除外', () => {
  const index = buildMasterIndex([
    { JAN: '4549995000017', itemName: 'KC-T305C [ブラック]', category: 'タブレット' },
  ])
  it('対応機種名を含む付属品は本体と照合しない', () => {
    expect(matchListing({ name: 'KYOCERA 京セラ Wi-Fiタブレット KC-T305C用充電置台 ODT305' }, index)).toBeNull()
  })
  it('本体の出品は照合する', () => {
    expect(matchListing({ name: '京セラ KC-T305C 新品' }, index)?.jan).toBe('4549995000017')
  })
})
