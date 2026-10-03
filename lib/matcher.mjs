// JAN照合・型番照合。買取マスター（約25,000件）を索引化し、出品を突き合わせる。
//
// JANが無い出品（実測で全体の約25%）を拾うため、マスターの itemName と出品名の両方から
// 「型番らしいトークン」を抜き出して照合する。1つの型番が複数 JAN に対応する場合は
// 曖昧なので索引から外す（誤照合して仕入判断を誤るよりマシ）。

// JAN: 13桁 or 8桁の数字。20〜29始まりは店舗独自のインストアコードなので JAN として扱わない。
// 69始まり（中国GS1）は正規のJAN。
export function normalizeJan(value) {
  if (value == null) return null
  const digits = String(value).replace(/\D/g, '')
  if (!(digits.length === 13 || digits.length === 8)) return null
  if (/^2[0-9]/.test(digits)) return null
  return digits
}

// 分割文字: 空白・【】[]（）()「」、,／|・
const SPLIT_RE = /[\s　【】\[\]（）()「」、,，／|・]+/

// 「数字+単位」だけのトークン（256GB, 1TB, 5G, 3000MAH, 120HZ など）。容量・規格は型番ではない。
const NUMBER_UNIT_RE =
  /^\d+(?:\.\d+)?(?:GB|TB|MB|KB|PB|MAH|AH|WH|HZ|MP|NM|MM|CM|M|KM|L|ML|DL|CL|G|KG|W|KW|V|A|MA|S|MS|K|X|枚|個|本|型|色|倍|％|インチ|ヶ月|か月|年|日)$/i

// 規格・プロトコル名（WIFI6E, USB3.2, HDMI2.1, IP68, PCIE5.0 など）。型番ではない。
// IP（防塵防水等級）は IP + 数字 の時だけにする（IPHONE17 のような型番を潰さないため）。
const SPEC_RE =
  /^(?:(?:WI-?FI|WIFI|USB|HDMI|DVI|DP|BT|BLE|LTE|NR|NSA|SA|GPS|NFC|PCI-?E|PCIE|NVME|SSD|SATA|DDR|GDDR|LPDDR|LAN|WAN|TYPE-?C|THUNDERBOLT|PD|QC|SIM|E-?SIM|MICRO-?SD|SDXC|SDHC|SD|IEEE|ATX|ITX|E-?ATX)\d*[\dA-Z.-]*|IPX?\d[\dA-Z.-]*)$/i

// トークンが型番として使えるか:
// 英字と数字を両方含み、英数以外（/ - . 等）を除いて大文字化した長さが6以上。
export function normalizeModelToken(token) {
  if (!token) return null
  if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return null
  const norm = token.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (norm.length < 6) return null
  if (NUMBER_UNIT_RE.test(norm)) return null
  if (SPEC_RE.test(norm)) return null
  return norm
}

// 名前（マスター itemName や出品名）から型番らしいトークンを全部抜く。
export function extractModelTokens(name) {
  const out = []
  for (const raw of String(name || '').split(SPLIT_RE)) {
    const norm = normalizeModelToken(raw)
    if (norm) out.push(norm)
  }
  return out
}

// 買取マスター → 索引 { byJan: Map<jan, entry>, byModel: Map<token, entry>, count }
// entry = { jan, itemName, category }
// 同じ正規化型番が別 JAN 複数に対応する時は曖昧なので byModel から外す。
export function buildMasterIndex(masterItems) {
  const byJan = new Map()
  const tokenToJans = new Map()
  for (const m of masterItems || []) {
    const jan = normalizeJan(m?.JAN ?? m?.jan)
    if (!jan) continue
    const entry = { jan, itemName: m?.itemName ?? m?.name ?? '', category: m?.category ?? null }
    byJan.set(jan, entry)
    for (const tok of extractModelTokens(entry.itemName)) {
      let set = tokenToJans.get(tok)
      if (!set) tokenToJans.set(tok, (set = new Set()))
      set.add(jan)
    }
  }
  const byModel = new Map()
  for (const [tok, jans] of tokenToJans) {
    if (jans.size === 1) byModel.set(tok, byJan.get([...jans][0]))
  }
  return { byJan, byModel, count: byJan.size }
}

// 付属品・消耗品の出品名。対応機種の型番を名前に含むため、型番照合だと本体と取り違える。
const ACCESSORY_RE =
  /用|対応|互換|専用|ケース|カバー|フィルム|保護|ガラス|キーボード|充電|ケーブル|アダプタ|スタンド|置台|ホルダー|ペン|バッテリー|ポーチ|バッグ|スキン|シール|パーツ|部品|交換|替え/

// RAM・保存容量などの表記をすべてGBにそろえる。両側に容量がある時だけ比較する。
function capacitiesInGb(name) {
  return new Set(
    [...String(name || '').matchAll(/(\d+)\s?(GB|TB)/gi)]
      .map(([, amount, unit]) => Number(amount) * (unit.toUpperCase() === 'TB' ? 1024 : 1)),
  )
}

// 出品を索引に照合する。
// 戻り値: { jan, matchType: 'jan'|'model', masterName } | null
export function matchListing(listing, index) {
  const jan = normalizeJan(listing?.jan ?? listing?.janCode)
  if (jan && index.byJan.has(jan)) {
    return { jan, matchType: 'jan', masterName: index.byJan.get(jan).itemName }
  }

  if (ACCESSORY_RE.test(listing?.name || '')) return null
  const jans = new Set()
  let masterName = null
  for (const tok of extractModelTokens(listing?.name || '')) {
    const hit = index.byModel.get(tok)
    if (hit) {
      jans.add(hit.jan)
      masterName = hit.itemName
    }
  }
  // 複数の異なる JAN に当たったら曖昧なので照合しない
  if (jans.size === 1) {
    const listingCapacities = capacitiesInGb(listing?.name)
    const masterCapacities = capacitiesInGb(masterName)
    if (listingCapacities.size && masterCapacities.size &&
        ![...listingCapacities].some((capacity) => masterCapacities.has(capacity))) return null
    return { jan: [...jans][0], matchType: 'model', masterName }
  }
  return null
}
