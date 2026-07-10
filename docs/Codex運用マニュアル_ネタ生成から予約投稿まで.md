# Codex運用マニュアル: 4コマ漫画ツールでネタ生成から予約投稿まで行う

この文書は、Codexが `Umbrella Parade Comic Studio` を使って、4コマ漫画のネタ生成、画像生成、X予約投稿、WordPress予約投稿まで進めるための実務マニュアルです。

目的は、ユーザー確認を最小にしながら、既存データを壊さず、予約投稿まで確実に完了させることです。

## 基本情報

### 公開ツール

- ツールURL: `https://comic.umbrellaparade13.com/tool`
- VPS本体: `ubuntu@133.18.122.18`
- SSHキー: `C:\Users\myabe\.ssh\umbrella-comic-studio-13.key`
- VPSアプリ本体: `/opt/umbrella-comic-studio`
- VPSデータ本体: `/var/lib/umbrella-comic-studio`
- ローカル開発フォルダー: `C:\Users\myabe\OneDrive\Desktop\Obsidian Folder\Umbrella Parade\漫画\04_半自動制作システム\10_オンライン版開発`
- GitHub: `https://github.com/UmbrellaParade/4comic-online`

### 主要ファイル

- ツールHTML: `漫画半自動制作ツール.html`
- 投稿サーバー: `x-post-server.js`
- X予約キュー: `/var/lib/umbrella-comic-studio/x-scheduled-posts.json`
- ツール状態保存: `/var/lib/umbrella-comic-studio/client-state.json`
- 追加画像保存: `/var/lib/umbrella-comic-studio/runtime-images.json`
- サーバーログ: `/var/lib/umbrella-comic-studio/x-post-server.log`

## 作業原則

### まず守ること

- 秘密情報を表示しない。X token、refresh token、OAuth secret、WordPress Application Password、OpenAI/Gemini/Claude API keyはログや回答に出さない。
- 予約キューや `client-state.json` を直接編集する場合は、必ず事前バックアップを作る。
- 通常作業はツールUIを優先する。直接JSON編集は、日時修正、重複予約の移動、失敗予約の復旧など、UIより安全に処理できる時だけ使う。
- X予約とWordPress予約は別物。片方だけ変更して完了扱いにしない。
- 投稿完了確認では、ツール表示だけでなく、X予約キューとWordPress投稿状態も確認する。

### 事前バックアップ例

PowerShellから実行する場合は、ローカル側で日付展開させないために、VPS上のPythonでバックアップを作る。
```powershell
@'
import shutil, datetime, os
base="/var/lib/umbrella-comic-studio"
suffix=datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
for name in ["x-scheduled-posts.json", "client-state.json"]:
    path=os.path.join(base, name)
    shutil.copy2(path, f"{path}.bak-{suffix}")
print("backup ok", suffix)
'@ | ssh -i "C:\Users\myabe\.ssh\umbrella-comic-studio-13.key" ubuntu@133.18.122.18 "python3 -"
```

## 作業前チェック

Codexが作業を始める時は、以下を確認する。

```powershell
ssh -i "C:\Users\myabe\.ssh\umbrella-comic-studio-13.key" ubuntu@133.18.122.18 "systemctl is-active umbrella-comic-studio || systemctl --user is-active umbrella-comic-studio"
curl.exe -s -o NUL -w "%{http_code}`n" https://comic.umbrellaparade13.com/tool
curl.exe -s https://comic.umbrellaparade13.com/health
```

期待値:

- サービス状態: `active`
- `/tool`: `200`
- `/health`: JSONが返る

## 作業全体フロー

1. キャラクターを決める。
2. 投稿予定日と投稿時間を確認する。
3. ネタを生成する、または指定ネタから整形する。
4. AI編集者で台本を確認する。
5. 漫画画像を生成する。
6. 画像を確認し、キープまたは予約リストへ追加する。
7. 投稿文、ハッシュタグ、投稿先、日時を確認する。
8. `予約投稿をセット` を押す。
9. X予約キューとWordPress予約を確認する。

## 1. キャラクター選択

ツール上部またはホームで対象キャラクターを選ぶ。

主なキャラクター:

- `ヴェル13世`
- `カーラ・マンソン`
- `べるぼ`
- `アマモリ`
- `アマヨミ`

キャラクター変更後に確認するもの:

- 固定ハッシュタグ
- SNS投稿文設定
- 画像パターン
- X OAuth状態
- WordPress設定
- 次の投稿予定日

注意:

- スマホではXログインセッションが別アカウントに寄ることがある。X投稿前に対象キャラのトークン確認を行う。
- べるぼ、ヴェル、カーラでWordPressサイトが異なる。キャラクターを変えたらWordPress設定対象も確認する。

## 2. ネタ生成

### 自動生成

通常は `ネタ` タブで `ネタ自動生成` を使う。

確認項目:

- AIプロバイダー
- APIキー
- キャラクター
- `過去ネタと重複しない` の有無
- 投稿文を自動生成するか
- ハッシュタグを自動生成するか

生成後に見る欄:

- タイトル
- サブコピー
- テーマ
- 狙い
- 1から4コマ目
- 投稿文
- ネタ用ハッシュタグ

### 指定内容から生成

ユーザーが文章や告知文を渡している場合は、`指定内容` 欄に貼り、`指定内容からネタ生成` を使う。

既に以下の形式になっている場合は、AI生成せず `指定内容を各枠に反映` でもよい。

```text
タイトル:
サブコピー:
テーマ:
狙い:
1コマ目:
セリフ:
2コマ目:
セリフ:
3コマ目:
セリフ:
4コマ目:
セリフ:
```

指定内容から生成する時の方針:

- 元文章の主旨を変えない。
- 4コマ漫画として短くする。
- 投稿者キャラの口調に寄せる。
- べるぼは基本的に丁寧でやわらかい情報発信口調にする。
- カーラは情緒、依存、本音、揺れを残す。ただしステージ上の弱気は観客に失礼にならない範囲にする。
- ヴェルは説教せず、未完成なまま並走する口調にする。

## 3. AI編集者

ネタ生成後は、必要に応じてAI編集者を使う。

判定基準:

- 75点以上: そのまま画像生成へ進んでよい。
- 60から74点: ブラッシュアップ推奨。1回だけブラッシュアップする。
- 59点以下: ネタ再生成推奨。

注意:

- 75点以上で過剰に直さない。
- ブラッシュアップで別作品にしない。
- 元ネタの核、キャラ、テーマを維持する。

## 4. 画像生成

`画像` タブで、未作成ネタを選ぶ。

基本手順:

1. `未作成ネタ` で対象ネタが選択されているか確認する。
2. 画像パターンと登場キャラクターを確認する。
3. 参考画像が正しくセットされているか確認する。
4. 必要なら画像成功率AIでプロンプトを確認する。
5. `API生成（認証済み向け）` を押す。

外部生成を使う場合:

1. `プロンプトコピー` で画像生成プロンプトを取得する。
2. ChatGPTなどにキャラクター参考画像を手動添付して生成する。
3. 生成画像をダウンロードする。
4. ツールの `外部生成画像を取り込む` またはVPS画像取り込みで読み込む。

### 画像確認ポイント

- 4コマになっている。
- タイトルとサブコピーが出ている。
- テーマや狙いの文章が漫画内に入っていない。
- キャラクターが混ざっていない。
- 2人以上いる場合、吹き出しが話者の近くにある。
- 文字がスマホで読める。
- ロゴやシリーズ名がキャラクターに合っている。
- 重大な崩れがない。

問題がある場合:

- キャラが混ざる: 登場キャラを減らすか、1コマ1会話に寄せる。
- 吹き出しが混ざる: 「同じコマで2人が同時に話す」構成を避ける。
- 文字が小さい: セリフを短くする。
- ちびキャラ感が消える: プロンプトにチビキャラ、デフォルメ、低身長、頭身固定を明示する。

## 5. 予約リストへ追加

画像が問題なければ、表示中画像の操作から予約リストへ追加する。

期待される状態:

- 画像がキープ保存される。
- 対象ネタが作成済みに移動する。
- `予約投稿前` に予約アイテムが追加される。
- 追加された予約が選択状態になる。

確認する項目:

- タイトル
- キャラクター
- 画像ファイル名
- 投稿文
- ハッシュタグ
- 予定日
- 予約時間
- 投稿先

## 6. 投稿文とハッシュタグ

### 投稿文

投稿文設定には主に2系統がある。

- 手動投稿文
- ネタ用投稿文

チェックの意味:

- `投稿文も一緒に投稿する`: 手動投稿文を使う。
- `ネタ用投稿文も一緒に投稿する`: AI生成の投稿文を使う。

注意:

- チェックが入っているのに本文が空なら、投稿前に止める。
- 投稿文が漫画内容と大きく違う場合は警告を確認する。
- Xの無料枠を考えるなら、140文字以内モードを使う。
- 長文告知を使う時は、文字制限なしモードまたは手動投稿文を使う。

### ハッシュタグ

ハッシュタグは3パターン。

- 固定ハッシュタグのみ
- ネタ用ハッシュタグのみ
- 固定ハッシュタグとネタ用ハッシュタグをミックス

ミックス時は重複タグを避ける。

## 7. 予約投稿

`投稿` タブで行う。

通常の予約:

1. `予約投稿前` から対象予約を選ぶ。
2. 予定日と予約時間を確認する。
3. `X予約投稿をセットした時にWordPressにも投稿/予約` のチェックを確認する。
4. `予約投稿をセット` を押す。
5. 成功メッセージを確認する。

成功時の期待値:

- X予約キューに `pending` で追加される。
- WordPress連携が有効なら、WordPressに `future` 投稿が作られる。
- ツール内では `予約投稿完了` に移動する。
- 次回予定日は自動で次の日へ進む。

今すぐ投稿:

1. `予約投稿前` から対象予約を選ぶ。
2. `今すぐXに投稿` を押す。
3. 必要ならWordPressも公開される。

注意:

- 今すぐ投稿では、次の予定日は変更しない仕様。
- カレンダーには実行日で投稿済み表示される。

## 8. 作業後確認

### X予約確認

```powershell
curl.exe -s https://comic.umbrellaparade13.com/schedule-list
```

またはVPS上で確認する。

```powershell
@'
import json, os
from datetime import datetime, timezone, timedelta
base="/var/lib/umbrella-comic-studio"
JST=timezone(timedelta(hours=9))
jobs=json.load(open(os.path.join(base,"x-scheduled-posts.json"),encoding="utf-8"))
def jst(s):
    if not s: return ""
    return datetime.fromisoformat(str(s).replace("Z","+00:00")).astimezone(JST).strftime("%Y-%m-%d %H:%M")
for j in jobs:
    if j.get("status") in ("pending","failed"):
        print(j.get("status"), jst(j.get("scheduledAt")), j.get("character"), j.get("title"), j.get("id"))
'@ | ssh -i "C:\Users\myabe\.ssh\umbrella-comic-studio-13.key" ubuntu@133.18.122.18 "python3 -"
```

### ツール予約リスト確認

```powershell
@'
import json, os
state=json.load(open("/var/lib/umbrella-comic-studio/client-state.json",encoding="utf-8"))
reservations=state.get("umbrellaMangaReservations",{}).get("value",[])
for r in reservations:
    if r.get("reservationStatus") in ("before","done"):
        print(r.get("reservationStatus"), r.get("date"), r.get("time"), r.get("character"), r.get("title"), r.get("xScheduleStatus"), r.get("wpStatus"))
'@ | ssh -i "C:\Users\myabe\.ssh\umbrella-comic-studio-13.key" ubuntu@133.18.122.18 "python3 -"
```

### WordPress確認

WordPressは投稿IDが保存されていればREST APIで確認できる。秘密情報は出力しない。

確認する値:

- `status`: `future` または `publish`
- `date`: サイト時間
- `date_gmt`: UTC
- `link`

## 9. 日時変更

ツールUIで行う場合:

1. `投稿` タブで対象予約を選ぶ。
2. カレンダー下の日時変更欄に変更後の日付と時間を入れる。
3. `選択予約の日時を更新` を押す。

期待値:

- ツール予約リストの日付が変わる。
- X予約キューの `scheduledAt` が変わる。
- WordPress投稿IDがあり、状態が `future` ならWordPress予約日時も変わる。

直接修正する場合:

- `x-scheduled-posts.json` の対象job `scheduledAt` を変更する。
- `client-state.json` の対象reservation `date`, `time`, `xScheduledAt`, `wpScheduledAt` を変更する。
- WordPressは `/update-wordpress-schedule` で更新する。
- 変更後は必ずX、予約リスト、WordPressの3点を確認する。

## 10. よくあるトラブル

### localStorage quota exceeded

原因:

- ブラウザ保存の `umbrellaMangaIdeaStock` が大きすぎる。

現在の方針:

- VPSにフルデータを保存する。
- ブラウザには軽量メモだけ保存する。

対応:

- ツールを再読み込みする。
- それでも出る場合は、VPS上の `client-state.json` は消さず、ブラウザ側の保存だけを軽くする。

### X OAuthが違うアカウントに寄る

原因:

- ブラウザのXログイン状態が別アカウントになっている。

対応:

- 対象キャラのXアカウントにブラウザ側でログインしてからOAuth取得する。
- 必要なら `x.com` と `twitter.com` のCookieを削除する。
- ツール側の対象キャラ、Expected username、OAuth Client ID/Secretを確認する。

### X投稿が403

確認:

- 対象キャラのUser Context tokenか。
- App only tokenやBearer tokenを入れていないか。
- `tweet.write`, `media.write`, `offline.access` があるか。
- X Developer App側の権限がRead and Writeか。

### WordPressが403

主な原因:

- XSERVERのWAF
- 国外IPアクセス制限
- REST API制限
- Application Password誤り

対応:

- 対象キャラのWordPress設定を確認する。
- `WordPress接続確認` を押す。
- 403の場合はサーバー側制限を疑う。

### WordPressだけ入っていない

確認:

- 予約時に `X予約投稿をセットした時にWordPressにも投稿/予約` がオンだったか。
- 対象キャラのWordPress設定が保存されているか。
- 投稿画像が予約に紐づいているか。
- WordPress投稿状態が `future` または `publish` になっているか。

### 予約投稿が実行されない

確認:

- VPSサービスが `active` か。
- `x-scheduled-posts.json` に対象jobが `pending` で存在するか。
- `scheduledAt` がJST換算で意図した時刻か。
- `x-post-server.log` にエラーがないか。

```powershell
ssh -i "C:\Users\myabe\.ssh\umbrella-comic-studio-13.key" ubuntu@133.18.122.18 "tail -n 80 /var/lib/umbrella-comic-studio/x-post-server.log"
```

## 11. Codexがユーザーへ報告する内容

作業完了時は、最低限以下を報告する。

- 作成したキャラクター
- タイトル
- 予約日時
- X予約の状態
- WordPress予約の状態
- 画像生成に問題があった場合は、その内容
- ツール更新が必要な場合は、再読み込みが必要であること

例:

```text
ヴェル13世の「タイトル名」を 2026-07-12 06:50 に予約しました。
X予約キューは pending、WordPressは future で確認済みです。
```

## 12. Codexが勝手にやらないこと

- 秘密情報の表示
- 既存予約の削除
- 公開済み投稿の削除
- WordPress記事本文の大幅な変更
- 既存ネタストックの一括削除
- XアカウントをまたぐOAuth再取得

これらが必要な場合は、理由を明確にしてから実行する。

## 13. 実装変更時の検証

ツールやサーバーを変更した場合は、最低限以下を実行する。

```powershell
npm.cmd run check
node -e "const fs=require('fs'); const html=fs.readFileSync('漫画半自動制作ツール.html','utf8'); const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).join('\n'); new Function(scripts); console.log('script syntax ok')"
```

VPS反映後:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://comic.umbrellaparade13.com/tool
ssh -i "C:\Users\myabe\.ssh\umbrella-comic-studio-13.key" ubuntu@133.18.122.18 "systemctl is-active umbrella-comic-studio || systemctl --user is-active umbrella-comic-studio"
```

GitHubに残す場合:

```powershell
git status --short
git add -- <変更ファイル>
git commit -m "<内容が分かる短いメッセージ>"
git push origin main
```

## 14. 最短チェックリスト

Codexがネタ生成から予約投稿まで実行する時の短縮手順。

```text
1. /tool を開く
2. キャラを選ぶ
3. 予定日・時間を確認
4. ネタ自動生成、または指定内容からネタ生成
5. AI編集者で75点以上、またはブラッシュアップ1回
6. 画像生成
7. 画像確認
8. この画像で予約リスト追加
9. 投稿文・ハッシュタグ確認
10. WordPress同時予約チェック確認
11. 予約投稿をセット
12. X schedule-list確認
13. WordPress future確認
14. 完了報告
```

