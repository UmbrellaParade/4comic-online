# Umbrella Parade 4コマ漫画ツール オンライン版

このフォルダーは、旧ツールを残したまま、完全オンライン化とスマホ対応を進めるための新規開発用です。

## 現在の状態

旧ツールの主要機能ファイルをコピー済みです。

- 漫画半自動制作ツール.html
- x-post-server.js
- x-scheduler-runner.js
- 漫画キャラプリセット.json
- README_漫画半自動制作ツール.md

秘密情報と実行データはコピーしていません。

- x-oauth-tokens.json
- x-scheduled-posts.json
- ログファイル
- ローカル取り込みフォルダー設定

## 起動

ローカル確認:

```powershell
npm start
```

オンライン想定:

```powershell
$env:ONLINE_MODE="true"
$env:HOST="0.0.0.0"
$env:PUBLIC_BASE_URL="https://your-domain.example.com"
$env:DATA_DIR="./data"
npm start
```

開くURL:

- ローカル: http://127.0.0.1:8787/tool
- オンライン: `PUBLIC_BASE_URL` + `/tool`

## 旧ツールとの分離

旧ツール本体:

```text
../06_旧ツールリポジトリ
```

オンライン化前バックアップ:

```text
../09_バックアップ/旧ツールリポジトリ_2026-05-15_オンライン化前
```

このオンライン版では旧ツール本体を直接編集しません。

## 次にやること

1. Renderなどにデプロイして常時起動できるURLを作る。
2. X Developer PortalのCallback URLに `https://公開URL/x-callback` を追加する。
3. ツールをスマホ幅で確認して、押しにくいボタンや長い入力欄を直す。
4. 予約データと画像をオンライン保存に寄せる。
5. WordPressの予約公開はWP-Cron依存を避けるため、オンラインサーバーから状態確認・再実行できるようにする。
