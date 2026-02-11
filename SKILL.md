---
name: yahoo-store-profit-finder
description: |
  Yahooショッピングのストア（ヤマダデンキ含む）をHTMLのみでスクレイピングし、
  価格・ポイント・実質価格・JANを取得して、morimori-kaitori.jpの買取価格と照合し
  利益が出る商品を抽出するスキル。Yahoo APIは使わない。
  Use when: 「Yahooストア利益計算」「ヤマダデンキ利益商品」「価格/ポイント/JAN取得」
---

# Yahoo Store Profit Finder

Yahooショッピングのストア検索ページと商品詳細ページを**HTMLのみ**で解析し、
`価格 / ポイント / 実質価格 / JAN` を取得して、`https://www.morimori-kaitori.jp/search` と照合する。

## ワークフロー

1. ストア検索ページ（`/search.html`）から商品URLを抽出
2. 商品詳細ページの `__NEXT_DATA__` から以下を取得
- `item.applicablePrice`（価格）
- `point.totalPoint`（ポイント）
- `item.janCode`（JAN）
3. `実質価格 = 価格 - ポイント` を計算
4. JAN優先で `morimori-kaitori` を検索し、通常/ゆとり/預かり価格を取得
5. `利益 = 買取価格 - 実質価格` で利益候補を抽出

## 実行

```bash
pnpm exec node /Users/t/.claude/skills/yahoo-store-profit-finder/scripts/yahoo-store-profit-scan.mjs \
  --store yamada-denki \
  --keyword "WF-1000XM5" \
  --pages 2 \
  --max-items 40 \
  --mode normal \
  --min-profit 1000 \
  --json /tmp/yahoo-profit.json
```

## 主なオプション

- `--store` 必須。YahooストアID（例: `yamada-denki`）
- `--keyword` ストア内検索キーワード
- `--pages` 取得するページ数
- `--max-items` 商品詳細を読む上限件数
- `--mode normal|yutori|deposit` 森森側の価格種別
- `--point-source total|with-entry` 利用するポイント種別
- `--min-profit` 最低利益フィルタ
- `--storage-state` Playwrightログイン状態JSON
- `--json` 結果JSON出力先

## Playwrightログイン連携

ログイン後ポイントで取得したい場合は、先にPlaywrightでYahooログイン状態を保存する。

```bash
pnpm exec node /Users/t/.claude/skills/yahoo-store-profit-finder/scripts/yahoo-login-save-state.mjs \
  --out /tmp/yahoo-shopping-state.json
```

その後、保存した状態を指定して実行:

```bash
pnpm exec node /Users/t/.claude/skills/yahoo-store-profit-finder/scripts/yahoo-store-profit-scan.mjs \
  --store yamada-denki \
  --pages 2 \
  --max-items 40 \
  --mode normal \
  --point-source with-entry \
  --storage-state /tmp/yahoo-shopping-state.json \
  --json /tmp/yahoo-profit-login.json
```

## 注意

- Yahoo APIは使用しない（HTML/埋め込みJSONのみ）
- ストアHTML構造が大幅変更された場合はパーサ更新が必要
- 利益は送料・手数料を含まない単純差分
