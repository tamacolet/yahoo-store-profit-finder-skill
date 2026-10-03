// 商品ページの __NEXT_DATA__ 解析と、Phi（ログイン済み）/ 未ログインの取得器。
//
// pickProps は「必要な項目だけ抜く小さなオブジェクト」を返す純粋関数。
// Phi 側ではこの関数を pickProps.toString() でページ内に埋め込んで同じ処理をさせるため、
// 外部の変数・importを参照しない自己完結の関数にする（コードを二重に書かない）。

import { normalizeJan } from './matcher.mjs'
import { pathToFileURL } from 'node:url'
import { PHI_SHADOW_PATH as PHI_SHADOW_DEFAULT } from './paths.mjs'

// ⚠ 自己完結であること（外部変数・import・ヘルパーを参照してはいけない）。
export function pickProps(pageProps) {
  const pp = pageProps || {}
  const item = pp.item || {}
  const point = pp.point || {}
  const badge = item.badge || {}
  const stock = item.stock || {}
  const user = pp.user && typeof pp.user === 'object' ? pp.user : null
  const postage = pp.postage || {}

  const campaigns = []
  const campaignGroups = [
    { list: point.currentCampaignList, conditional: false },
    { list: point.conditionalCampaignList, conditional: true },
  ]
  for (let gi = 0; gi < campaignGroups.length; gi += 1) {
    const group = campaignGroups[gi]
    const list = Array.isArray(group.list) ? group.list : []
    for (let li = 0; li < list.length; li += 1) {
      const parts = (list[li] && list[li].partsCampaignList) || []
      for (let pi = 0; pi < parts.length; pi += 1) {
        const c = parts[pi] || {}
        campaigns.push({
          title: c.title ?? null,
          point: c.point ?? null,
          ratio: c.ratio ?? null,
          isReachedLimit: c.isReachedLimit === true,
          conditional: group.conditional,
        })
      }
    }
  }

  return {
    item: {
      name: item.name ?? null,
      applicablePrice: item.applicablePrice ?? null,
      premiumPrice: item.premiumPrice ?? null,
      regularPrice: item.regularPrice ?? null,
      janCode: item.janCode ?? null,
      isUsed: item.isUsed === true,
      usedConditionText: item.usedConditionText ?? null,
      isCoupon: badge.isCoupon === true,
      isBonusPlus: badge.isBonusPlus === true,
      stock: {
        isAvailable: typeof stock.isAvailable === 'boolean' ? stock.isAvailable : null,
        quantity: typeof stock.quantity === 'number' ? stock.quantity : null,
        maxPurchaseQuantity:
          typeof stock.maxPurchaseQuantity === 'number' ? stock.maxPurchaseQuantity : null,
        stockText: stock.stockText ?? null,
      },
    },
    point: {
      totalPoint: typeof point.totalPoint === 'number' ? point.totalPoint : null,
      totalPointWithEntry:
        typeof point.totalPointWithEntry === 'number' ? point.totalPointWithEntry : null,
      totalPointRatio: point.totalPointRatio ?? null,
      isCapReached: point.isCapReached === true,
      payMethodText: point.priorityPayMethodText ?? null,
      campaigns,
    },
    postage: {
      fee: typeof postage.fee === 'number' ? postage.fee : null,
      isFree: typeof postage.isPostageFree === 'boolean' ? postage.isPostageFree : null,
    },
    user: {
      // user はキーが1つでもあればログイン済み（未ログインは {}）。個人情報は持ち出さない。
      isLoggedIn: !!(user && Object.keys(user).length > 0),
      isPremiumUser: !!(user && user.isPremiumUser === true),
    },
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// pickProps の結果を判定に使う形に変換する。
export function parseItemProps(picked) {
  if (!picked || typeof picked !== 'object') return null
  const item = picked.item || {}
  const point = picked.point || {}

  const applicable = num(item.applicablePrice) ?? num(item.regularPrice)
  const premium = num(item.premiumPrice)
  // basePrice は applicablePrice と premiumPrice の安い方
  const basePrice =
    applicable != null && premium != null ? Math.min(applicable, premium) : (applicable ?? premium)

  const totalPoint = num(point.totalPoint)
  const totalPointWithEntry = num(point.totalPointWithEntry) ?? totalPoint

  return {
    name: item.name ?? null,
    jan: normalizeJan(item.janCode),
    rawJan: item.janCode != null ? String(item.janCode).replace(/\D/g, '') || null : null,
    price: applicable,
    premiumPrice: premium,
    basePrice,
    totalPoint,
    totalPointWithEntry,
    isCapReached: point.isCapReached === true,
    payMethodText: point.payMethodText ?? null,
    campaigns: (point.campaigns || []).map((c) => ({
      title: c?.title ?? null,
      point: c?.point ?? null,
      ratio: c?.ratio ?? null,
      reachedLimit: c?.isReachedLimit === true,
      conditional: c?.conditional === true,
    })),
    shippingFee: num(picked?.postage?.fee),
    shippingFree: typeof picked?.postage?.isFree === 'boolean' ? picked.postage.isFree : null,
    hasCoupon: item.isCoupon === true,
    isBonusPlus: item.isBonusPlus === true,
    isUsed: item.isUsed === true,
    usedConditionText: item.usedConditionText ?? null,
    isLoggedIn: picked?.user?.isLoggedIn === true,
    isPremiumUser: picked?.user?.isPremiumUser === true,
    stockAvailable:
      typeof item.stock?.isAvailable === 'boolean' ? item.stock.isAvailable : null,
    stockQuantity: num(item.stock?.quantity),
    maxPurchase: num(item.stock?.maxPurchaseQuantity),
  }
}

export function extractNextData(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html || '')
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

// HTML → 判定用オブジェクト（未ログイン経路用の一括パース）
export function parseItemPage(html) {
  const root = extractNextData(html)
  if (!root) return null
  return parseItemProps(pickProps(root?.props?.pageProps))
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// 同じ名前は既存窓へ再接続される。古い別プロファイルの窓を掴まないよう固有名にする。
const SHADOW_NAME = 'ypf-deep'
// ログインはプロファイルごとに分かれる。Yahoo!ログイン済みは Phi の Default プロファイル。
const PHI_PROFILE = process.env.YAHOO_PHI_PROFILE || 'Default'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// { source, fetch(url) → parsed|null, close() }
//   mode 'phi'  : Phi shadow窓（ログインCookieが乗る）。失敗したら anon に切替。
//   mode 'anon' : 未ログインの node fetch。
// 商品ページは連続取得でHTTP200のまま中身が欠けるため、1200ms間隔を下げない。
// 欠けたら3秒待って1回だけ再試行する。
export function createPageFetcher({
  mode = 'anon',
  log = () => {},
  delayMs = 1200,
  phiPath = PHI_SHADOW_DEFAULT,
  fetchImpl = fetch,
} = {}) {
  let h = null
  let phiFailed = mode !== 'phi'
  let lastAt = 0
  let closed = false
  let lastUser = null // 直近に取れたページの user 判定（未取得は null）

  async function pace() {
    const wait = delayMs - (Date.now() - lastAt)
    if (wait > 0) await sleep(wait)
    lastAt = Date.now()
  }

  async function ensurePhi(firstUrl) {
    const { loadPhi } = await import(pathToFileURL(phiPath).href)
    h = await loadPhi()
    await h.enterContext({ kind: 'shadow', name: SHADOW_NAME, profile: PHI_PROFILE })
    // 最初に開くのは商品URL（トップは別オリジンへ飛んで fetch が失敗する）
    await h.openTab(firstUrl)
  }

  function pageExpr(url) {
    return (
      `(async () => { try {` +
      `const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });` +
      `const html = await res.text();` +
      `const m = /<script id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/.exec(html);` +
      `if (!m) return null;` +
      `const root = JSON.parse(m[1]);` +
      `const pick = ${pickProps.toString()};` +
      `return JSON.stringify(pick(root && root.props && root.props.pageProps));` +
      `} catch (e) { return null; } })()`
    )
  }

  async function fetchViaPhi(url) {
    if (!h) await ensurePhi(url)
    const json = await h.js(pageExpr(url))
    return json ? JSON.parse(json) : null
  }

  async function fetchViaAnon(url) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const root = extractNextData(html)
    return root ? pickProps(root?.props?.pageProps) : null
  }

  async function fetchOnce(url) {
    let picked = null
    if (!phiFailed) {
      try {
        picked = await fetchViaPhi(url)
      } catch (e) {
        log(`Phi での取得に失敗（未ログイン取得へ切替）: ${e.message}`)
        phiFailed = true
        try {
          await h?.closeShadowWindow(SHADOW_NAME)
        } catch {}
        h = null
      }
    }
    if (!picked) {
      try {
        picked = await fetchViaAnon(url)
      } catch (e) {
        log(`ページ取得失敗: ${url} (${e.message})`)
        return null
      }
    }
    if (picked) lastUser = picked.user || null
    return picked
  }

  return {
    // 直近に取れたページが実際にログイン済みだったかで決める。
    // phi 経由でも未ログインのページが取れたなら 'page-anon'。
    get source() {
      return lastUser?.isLoggedIn === true ? 'page-login' : 'page-anon'
    },
    // まだ1件も取れていなければ null
    get loginState() {
      if (!lastUser) return null
      if (lastUser.isPremiumUser === true) return 'premium'
      if (lastUser.isLoggedIn === true) return 'login'
      return 'anon'
    },
    async fetch(url) {
      if (closed || !url) return null
      await pace()
      let picked = await fetchOnce(url)
      if (!picked) {
        // 欠けたら3秒待って1回だけ再試行
        await sleep(3000)
        lastAt = Date.now()
        picked = await fetchOnce(url)
      }
      return picked ? parseItemProps(picked) : null
    },
    async close() {
      closed = true
      if (h) {
        await h.closeShadowWindow(SHADOW_NAME).catch(() => {})
        h = null
      }
    },
  }
}
