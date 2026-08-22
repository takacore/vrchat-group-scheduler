# VRChat Group Notify Scheduler (Chrome 拡張機能 / MV3)

VRChatのグループお知らせ（Announcement）を予約投稿するための **Chrome 拡張機能（Manifest V3）** です。
投稿に**画像を添付**することもできます。

> 旧バージョンは Electron デスクトップアプリでしたが、現在は Chrome 拡張機能に移行しています。本READMEは現行のMV3拡張の挙動を説明します。

使い方動画（旧UIの参考）:
https://drive.google.com/file/d/19oLJXNCheJwVyDH7iHtjL9J8E4tvRUyE/preview

---

## 概要

ブラウザにログイン済みの **VRChat のセッション（Cookie）を利用**して、指定した日時にグループお知らせを自動投稿します。
サーバーを介さず、あなたのブラウザ上（拡張機能のバックグラウンド）で動作します。

## 主な機能

- **予約投稿**: 日時を指定してお知らせを予約。`chrome.alarms` により指定時刻に自動投稿します。
- **定期投稿**: 毎日 / 毎週（曜日指定） / 毎月の繰り返しに対応。発火後に次回を自動で再スケジュールします。
- **画像添付（任意）**: VRChat の画像付き投稿に対応（後述の制限あり）。
- **バックアップ / 復元**: 予約投稿を JSON にエクスポート／インポート。更新時や別PCへの移行でデータを引き継げます。
- **グループ権限スキャン**: 参加グループのうち、お知らせ投稿権限のあるグループを抽出（結果はキャッシュ）。

## 認証とデータの取り扱い（重要・正確な仕様）

正直なところを明記します。旧Electron版の「OSキーチェーンで暗号化」「データは一切外部に出ない」といった説明は、**この拡張機能には当てはまりません**。

- **認証はブラウザのログインセッションに依存**します。拡張機能はパスワードを受け取らず保存もしません。VRChat に**ブラウザでログイン済み**であることが前提です。
- **予約データの保存先は `chrome.storage.local`（平文）** です。OSキーチェーン等による暗号化は行っていません。添付画像は base64 として同ストレージに保存されます（このため `unlimitedStorage` 権限を使用）。
- **「外部に出ない」わけではありません**: 本来の目的どおり、投稿内容は **VRChat API（`vrchat.com`）** へ送信されます。これ以外の第三者サーバーへの送信・テレメトリは行いません。
- Cookie やトークンを**ログ出力・外部送信することはありません**。

### 通信先（host_permissions）
`vrchat.com` のみ。

### 使用権限（manifest）
`storage`, `unlimitedStorage`, `alarms`, `cookies`, `notifications`。

## 制限・注意

- **画像添付（VRChat側）には VRC+ サブスクライブが必要**です（`/file/image` の権限要件）。未加入の場合は画像なしで投稿を継続します。VRChat 側は概ね 512×512px 以上を推奨。

## VRChat 利用規約への配慮
VRChat の利用規約・ガイドラインに反しないよう、正規クライアントと同様の手順（Cookie セッション）でローカルに動作する設計です。
- https://hello.vrchat.com/creator-guidelines
- https://vrchat.community/reference/add-group-post

## インストール（パッケージ化されていない拡張機能として読み込み）

1. このリポジトリを取得し、依存をインストールします。
   ```bash
   npm install
   ```
2. 拡張機能をビルドします（`next build` 後に `fix-extension.js` が `out/_next` を `out/assets` にリネームし、相対パスへ置換します）。
   ```bash
   npm run build
   ```
   生成物: `out/`
3. Chrome で `chrome://extensions/` を開き、**デベロッパーモード**を ON。
4. 「**パッケージ化されていない拡張機能を読み込む**」で `out/` フォルダを選択。
5. 権限の確認ダイアログが出たら承認します。

> 更新時のデータ引き継ぎ: 「パッケージ化されていない拡張機能」の保存領域は読み込み元のIDに紐づきます。**同じフォルダに上書きして「更新」**すればデータは保持されます。フォルダを変える/別PCに移す場合は、拡張機能内の **Backup / Restore** をご利用ください。

## 開発

```bash
npm run dev   # Next.js 開発サーバ（UIの見た目確認用。chrome.* API はモックされません）
```

## 技術スタック

- Chrome 拡張機能（Manifest V3, Service Worker）
- Next.js（静的エクスポート → ポップアップ/全画面UI）
- `chrome.alarms` によるスケジューリング

## 作者
**TakaAizu**
