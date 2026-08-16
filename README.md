# text-watermark-sample

語選択によるテキスト透かしの試作。意味を変えない表記ゆれ・短縮形・同義語の選択に任意長のバイト列を符号化し、
自己同期フレームによって本文の部分切り出しにも耐えるようにしたもの。

ビルド工程のない静的サイトで、外部への通信は行わない (`dict=` を明示した場合の辞書取得を除く)。
埋め込み・抽出はすべてブラウザ内で完結する。

## 公開先

GitHub Pages で公開する。`site/` 以下がそのまま配信される。

- 公開 URL: `https://<owner>.github.io/text-watermark-sample/`
- 初回のみ、リポジトリの **Settings → Pages → Source** を **GitHub Actions** に設定する。
  以降は `main` の `site/**` が更新されるたびに [`.github/workflows/pages.yml`](.github/workflows/pages.yml) が配信する。

## 構成

```
site/                 GitHub Pages で配信されるもの
  index.html          画面
  assets/style.css    スタイル
  assets/dict.js      搬送辞書 (相互置換可能な語のペア)
  assets/core.js      符号化・復号 (ブラウザ / Node どちらからも使える)
  assets/app.js       画面の配線と GET パラメータの処理
test/core.test.js     符号化・復号の回帰テスト (依存なし)
test/browser.test.js  GET パラメータの確認 (Chromium を使用)
tools/serve.js        開発用の静的サーバ
```

## ローカルでの実行

```sh
npm run serve     # http://localhost:8080/
npm test          # 全テスト (ブラウザが無い場合 browser.test.js はスキップされる)
```

ブラウザ側のテストだけを実行する場合:

```sh
npm install
npx playwright install chromium
node --test test/browser.test.js
```

## 画面

- **埋め込み** — 原文とペイロードを入れて埋め込む。出力は 4 通りに表示できる。
  - `変更前後を併記` — 置換された語を <code>~~すべて~~ 全て</code> の形で並べる (既定)
  - `変更後のみ` — 変更された語を強調する
  - `搬送ビットで色分け` — 全スロットを bit 0 / bit 1 で塗り分ける
  - `変更なしの出力` — 装飾のない本文

  「変更のあった箇所だけ抜き出す」を入れると、変更箇所の前後 12 文字だけを残して間を省略する。
  語にマウスを重ねるとスロット番号・ビット値・辞書グループ ID が出る。

- **抽出** — 透かしを検査する。検出できた場合は次を表示する。
  - 復元したペイロード (テキスト / HEX / 長さ)
  - ブロックごとの検出状況 (スロット範囲・検出回数)
  - **本文中のどこに何が載っていたか** — 各語をフレーム上の役割 (SYNC / IDX / TOTAL / DATA / CRC8)
    で色分けした本文
  - **ペイロード各バイトの搬送位置** — バイトごとに、載っていた 8 語・本文中の文字位置・
    本文から読み取った生ビット・復調後の値を並べた表

- **検証** — 切り出しや削除に対する復元率を試行して測る。
- **辞書** — 辞書 JSON の編集と、原文中の出現数の集計。
- **URL** — 現在の入力に対応する GET URL の生成とパラメータの説明。

## GET パラメータ

クエリ文字列で本文・埋め込みデータ・各種設定を指定できる。静的サイトなのでサーバ側の処理はなく、
すべてブラウザ内で解釈・実行される。画面の **URL** タブから、現在の入力に対応する URL を生成できる。

| 名前 | 値 | 説明 |
| --- | --- | --- |
| `text` (`t`) | 文字列 | 本文。`run=embed` では原文、`run=extract` では検査対象 |
| `text64` (`t64`) | base64url | 本文 (UTF-8 を base64url 化)。`text` より優先 |
| `payload` (`p`) | 文字列 | 埋め込みデータ |
| `payload64` (`p64`) | base64url | 埋め込みデータ。`payload` より優先 |
| `pmode` (`pm`) | `text` \| `hex` | 埋め込みデータの解釈 (既定 `text`) |
| `key` (`k`) | 文字列 | 鍵 |
| `data` (`d`) | `auto` \| `2` \| `4` \| `8` \| `16` \| `32` | DATA バイト数 (既定 `auto`) |
| `profile` | `span` \| `compact` | DATA 自動選択の基準 (既定 `span`) |
| `tiers` | 例 `A,B` / `AB` | 有効な辞書ティア (既定 `A,B`) |
| `langs` | 例 `ja,en` | 有効な言語 (既定 `ja,en`) |
| `dict` | URL | 辞書 JSON の取得先。同一オリジンまたは CORS 許可が必要 |
| `tab` | `embed` \| `extract` \| `verify` \| `dict` \| `url` | 初期表示タブ |
| `run` (`action`) | `embed` \| `extract` \| `1` | 読み込み時に自動実行 (`1` は `tab` に従う) |
| `output` (`o`) | `text` \| `json` | UI を描画せず結果のみを出力 |

### 例

本文と埋め込みデータを入れた状態で画面を開く:

```
?text=...&payload=ID:0042
```

読み込み時に埋め込みまで実行する:

```
?text=...&payload=ID:0042&run=embed
```

埋め込み結果の本文だけを返す (UI なし。`<pre id="result">` に平文で出力される):

```
?text=...&payload=ID:0042&run=embed&output=text
```

統計込みで JSON を返す:

```
?text64=<base64url>&payload=ID:0042&key=s3cret&run=embed&output=json
```

```json
{
  "action": "embed",
  "ok": true,
  "text": "...",
  "capacityBits": 220,
  "periodBits": 204,
  "spanBits": 271,
  "cycles": 1.078,
  "blocks": 3,
  "dataBytes": 4,
  "changed": 90,
  "stable": true,
  "sufficient": true,
  "selfExtract": true
}
```

抽出する:

```
?text64=<base64url>&run=extract&output=json
```

```json
{
  "action": "extract",
  "ok": true,
  "reason": null,
  "slots": 220,
  "dataBytes": 4,
  "blocksFound": 3,
  "blocksTotal": 3,
  "payloadText": "ID:0042",
  "payloadHex": "49443a30303432",
  "payloadLength": 7
}
```

`output` を指定したページは HTML を返すため、`curl` でそのまま結果を取り出すことはできない
(JavaScript の実行が必要)。自動処理から使う場合は、ヘッドレスブラウザで開いて `#result` の
テキストを読むか、Node から `site/assets/core.js` を直接呼ぶ。

### 注意点

- **URL 長**: 実運用では 8 KB 前後で切り捨てられることがある。日本語の本文はパーセント符号化で
  1 文字あたり 9 文字になるため、`text64` (1 文字あたり約 4 文字) を使うほうが短い。
  それでも足りない長さの本文は、URL ではなく画面に貼り付けて処理する。
- **鍵**: `key` を URL に含めると閲覧履歴やリファラに残る。共有する URL には含めないほうがよい。
- **不正な値**: 解釈できないパラメータは画面上部にエラーとして表示され、その項目だけ既定値で続行する。

## Node から使う

`site/assets/core.js` はブラウザと Node の両方から読める。

```js
const wm = require('./site/assets/core.js');

const emb = await wm.embed(text, wm.utf8Encode('ID:0042'), { key: 's3cret' });
const got = await wm.extract(emb.text, { key: 's3cret' });
console.log(wm.utf8Decode(got.payload)); // ID:0042
```

主な関数:

| 関数 | 説明 |
| --- | --- |
| `embed(text, payload, opts)` | 透かしを埋め込む。容量・周期・安定性の統計も返す |
| `extract(text, opts)` | 透かしを抽出する |
| `analyze(text, opts)` | 搬送容量 (スロット数) と辞書グループ別の出現数を数える |
| `frameCost(payloadLen, dataBytes, profile)` | 必要な周期長・span を見積もる |
| `checkDictConsistency(text, opts, trials, rng)` | 辞書の整合性を確認する |

`opts` は `{ dict, tiers, langs, key, dataBytes, profile }`。既定は `tiers: ['A','B']`、`langs: ['ja','en']`。

## 方式

1. 辞書に定義した相互置換可能な語のペアを本文から走査し、出現順に「スロット」とする。
2. 各スロットが 1 bit を搬送する (`variants[0]` = 0、`variants[1]` = 1)。
3. ペイロードを自己同期フレームへ符号化し、スロット列に巡回反復で書き込む。

フレーム構成 (1 ブロック = 36 + 8×D bit):

```
SYNC(16) | IDX(6) | TOTAL-1(6) | DATA(8×D) | CRC8(8)
```

復号側は全ビット位置で SYNC を探索し、CRC8 を通過したブロックのみ採用する。このため
本文の部分切り出し、語の削除・挿入によるずれ、一部ブロックの破損に耐える。
ペイロード列 `LEN(varint) | PAYLOAD | CRC16(2)` は鍵ストリーム (SHA-256 CTR) で XOR されるため、
鍵が一致しない場合は CRC16 が不一致となって復号は失敗する。

辞書は 3 ティアに分かれる。

| ティア | 内容 | 既定 |
| --- | --- | --- |
| A | 表記ゆれのみ。意味・語調とも不変 (`できる` / `出来る`) | 有効 |
| B | 文脈依存または語調が僅かに変化 (`do not` / `don't`) | 有効 |
| C | 語彙置換。意味は近いが同一ではない (`use` / `utilize`) | 無効 |

辞書は画面の **辞書** タブで JSON として編集でき、`dict=<URL>` で外部の JSON を読み込むこともできる。

## 制約

- 搬送容量は本文中の該当語の出現数で決まる。短い本文には埋め込めない。
- 透かしは本文の表記を実際に書き換えるため、原文とは異なる文字列になる。
- 表記を機械的に統一する校正 (すべて漢字にする、短縮形を展開する等) を通すと透かしは失われる。
- 秘匿性を目的とした方式ではない。辞書が既知であれば、透かしの存在自体は検出できる。

## ライセンス

Apache License 2.0 ([LICENSE](LICENSE))
