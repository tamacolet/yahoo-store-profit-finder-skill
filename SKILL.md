---
name: yahoo-store-profit-finder
description: |
  Yahoo!ショッピングを巡回し、ポイント込みの実質価格が買取価格を下回る商品を自動発掘。
  検索APIで全件収集→JAN/型番で買取マスター照合→商品ページ（Phiログイン）で確定ポイント取得→ランク付け。
  ブラウザのダッシュボード（server.mjs）と無人CLI（cli.mjs）の2面。
  Use when: 「ヤフショ利益」「Yahoo特価」「ポイント込み実質」「買取差額」「実質価格が買取より安い」「特価スマホ探して」「利益商品スキャン」
---

# Yahoo Store Profit Finder

「ポイント込み実質価格 < 買取価格」の商品を見つけるツール。Webアプリ版。

## 起動

```bash
cd <このスキルのディレクトリ>
pnpm install   # 初回のみ
pnpm start     # → http://127.0.0.1:4173
```

## 前提

- `YAHOO_CLIENT_ID`（検索API。無いとスキャン不可。`/api/status` で確認可）
- Phi Browser のログイン状態:
  - Yahoo!（LYPプレミアム）… Phi の `Default` プロファイルでログインして `--deep phi`。変更する時は `YAHOO_PHI_PROFILE` を設定
  - hikaku … 買取価格・買取マスター取得用トークンの元。未ログインだと買取照合が全部失敗する

## CLI（無人実行）

```bash
node cli.mjs --preset smartphone,tablet [--deep phi|anon|off] [--deep-limit 120]
node cli.mjs --mode keyword --keyword "iPhone" [--seller ebest]
node cli.mjs --mode reverse --category スマートフォン [--min-buyback 20000] [--reverse-limit 300]
```

進捗は stderr、最後に A/B 上位20件の表を stdout。`--json out.json` で全結果を保存。
結果は常に `data/scans/<id>.json` にも保存され、次回スキャンで値下げ・新着の差分が付く。

## ランク

- A = 確実ポイントだけで黒字 / B = エントリー込み最大なら黒字 / C = 赤字 / - = 買取不明

## モード

- `genre`: プリセットのジャンルを価格帯分割で全件巡回
- `keyword`: キーワード/ストアID検索（プリセット併用可）
- `reverse`: 買取マスターのカテゴリから `minBuyback` 円以上のJANを買取価格順に検索。既定300件、最大2000件で、JAN検索ごとにAPI待機間隔を守る

## 実測の約束事（変えない）

- 検索APIは `results=50, start≤901` で先頭950件まで。超える帯は価格二分割。
- APIレート制限はバースト型: 間隔1200ms下限・429/500/503で×1.6（上限8000ms）・成功で×0.95。
- 429時は60秒待って再送し、続く場合も60秒ずつ待つ（初回を含め最大6回）。500/503と通信失敗は従来の指数待機。
- `premiumPriceStatus=true`でも `premiumPrice===price` がある。金額で比較して安い方を basePrice に。
- 検索APIのポイントは概算（`max(通常系合計, プレミアム系合計)`）。確定値は商品ページのみ。
- 商品ページは連続取得するとHTTP200のまま中身が欠ける。1件1200ms・欠けたら3秒後に1回再試行。
- Phi の shadow 窓は `Default` プロファイルで最初に商品URLを開く（トップは別オリジンで fetch 失敗）。失敗時は anon へ自動切替。実際に未ログインなら `page-anon` と警告を記録。
- JAN: 13桁 or 8桁。20〜29始まりは店舗独自コードで除外。69始まりは正規。
- 型番照合は記憶容量も照合し、共通容量がない出品を除外。中古・整備品、海外版、送料別の可能性をリスク表示。送料は実質価格に含め、結果は確度順・同一ストア/JAN/価格の重複をまとめる。
- 買取価格: 30日より古い値は使わない。7日より古い値しか無い時は risk「買取価格が古い」。

## ファイル

```
server.mjs            node:http サーバー（静的配信 + /api + SSE）
cli.mjs               無人実行CLI
lib/presets.mjs       ジャンルプリセット・価格帯
lib/yahoo-search.mjs  検索API（適応待機・帯分割・hit正規化）
lib/matcher.mjs       JAN正規化・型番照合（買取マスター索引）
lib/buyback.mjs       kaitori-app 経由の買取価格（トークン・3hキャッシュ・鮮度）
lib/item-page.mjs     __NEXT_DATA__ 解析・Phi/anon 取得器
lib/judge.mjs         実質価格・利益・ランク・リスク
lib/scan.mjs          パイプライン（依存注入・進捗・中断）
lib/store.mjs         data/scans/*.json の保存・一覧・差分
test/                 vitest
```

## テスト

```bash
pnpm test
```
