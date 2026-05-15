# Obsidianオンライン連携

## 結論

ObsidianはローカルフォルダーをVaultとして扱うアプリなので、オンライン漫画ツールからPC内のVaultを直接編集することはできません。

そのため、オンライン連携は「橋」を作るのが安全です。

## おすすめ構成

### 1. Obsidian Sync

スマホとPCでObsidianを使うなら、一番安定します。

- PCのObsidian FolderをSync対象にする
- スマホでも同じVaultを開く
- ノートや画像はObsidian公式Syncで同期

ただし、オンライン漫画ツールから直接Syncへ書き込むわけではありません。

### 2. GitHub経由

オンライン漫画ツールがMarkdownや予約ログをGitHubへ保存し、PC側で取得します。

流れ:

1. オンライン漫画ツールでネタや投稿ログを作る
2. サーバーがGitHubの指定フォルダーへMarkdown保存
3. PC側で `最新版を取得.bat` を押す
4. Obsidian Folder側へ反映する

これは「変更履歴が残る」「AI連携しやすい」ので、制作ログには向いています。

### 3. OneDrive / Google Drive経由

今のPCがOneDrive配下なので、PCとスマホのファイル同期には使えます。
ただし、オンラインサーバーからOneDriveへ直接書くにはMicrosoft連携が必要になります。

## 今後作ると便利な機能

- ツールで生成したネタをGitHubへMarkdown保存
- 投稿予約結果をGitHubへMarkdown保存
- 週ごとの制作ログを自動生成
- PC側でObsidian Folderへ取り込む同期バッチ
- 将来的にGoogle Drive/OneDrive連携

## 方針

最初はGitHub経由で始めるのが安全です。

Obsidianそのものの同期はObsidian Syncで安定化し、制作ログやAI連携用のデータはGitHubに保存していく構成にします。
