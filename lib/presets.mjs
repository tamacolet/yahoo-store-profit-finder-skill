// ジャンルプリセット定義。Yahoo検索APIの genre_category_id に対応する。
export const PRESETS = [
  { id: 'smartphone', label: 'スマホ', genreIds: [38338] },
  { id: 'tablet', label: 'タブレット', genreIds: [21076] },
  { id: 'game', label: 'ゲーム機', genreIds: [77080, 50797] },
  { id: 'camera', label: 'カメラ・レンズ', genreIds: [47733, 2465] },
  { id: 'audio', label: 'イヤホン・ヘッドホン', genreIds: [49482] },
  { id: 'watch', label: 'スマートウォッチ', genreIds: [36497] },
  { id: 'pc', label: 'ノートPC', genreIds: [14242] },
  { id: 'pcparts', label: 'グラボ', genreIds: [40331] },
  { id: 'tcg', label: 'トレカ', genreIds: [2420] },
  { id: 'beauty', label: '美容家電', genreIds: [1987] },
  { id: 'robot', label: 'ロボット掃除機', genreIds: [26212] },
]

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null
}

// 価格帯分割の初期値（実測の件数分布に合わせたもの）
export const DEFAULT_PRICE_BANDS = [
  [3000, 10000],
  [10000, 20000],
  [20000, 30000],
  [30000, 50000],
  [50000, 80000],
  [80000, 120000],
  [120000, 200000],
  [200000, null],
]

// priceFrom/priceTo で初期価格帯を切り詰める。重ならない帯は捨てる。
export function clipBands(bands, priceFrom, priceTo) {
  const out = []
  for (const [f, t] of bands) {
    const from = priceFrom != null ? Math.max(f, priceFrom) : f
    const to = t == null ? priceTo ?? null : priceTo != null ? Math.min(t, priceTo) : t
    if (to == null || from < to) out.push([from, to])
  }
  return out
}
