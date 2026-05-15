# GitHub連携・配布メモ

漫画半自動制作ツールを、将来的にべるぼの教育事業の特典として配布するためのメモです。

## 現在の位置

Obsidian内の制作中ツール。

```text
Umbrella Parade/漫画/04_半自動制作システム/06_ツール/漫画半自動制作ツール.html
```

## 方針

- Obsidian内：自分用の制作版、キャラ設定、未公開資料、画像パスを含む
- GitHub側：配布用の公開版、README、サンプルデータだけを置く

## GitHubへ出す前に分けるもの

公開していいもの。

- ツール本体
- 使い方
- サンプルキャラクター
- サンプルプロンプト
- 空のテンプレート

公開しないもの。

- APIキー
- 未公開のUmbrella Parade設定
- 未公開キャラ画像
- ローカルPCの絶対パス
- 個人情報
- 有料特典にする予定の中身そのもの

## 配布用リポジトリ案

```text
umbrella-manga-tool/
  index.html
  README.md
  presets/
    sample-characters.json
  docs/
    how-to-use.md
```

## GitHub Pages公開の候補

HTML/CSS/JavaScriptだけで動く形なら、GitHub Pagesで公開できる。
ただしAPIキーをブラウザに直接入れる方式は、配布版では注意が必要。

## 次にやること

- 自分用ツールと配布用ツールを分ける
- 配布用サンプルプリセットを作る
- APIキーを使う機能は、配布版では「各自のキーをブラウザ内だけに保存する」または「ローカル中継アプリ」にする
- READMEに使い方と注意点を書く
