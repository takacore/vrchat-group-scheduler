# VRChat Group Notify Scheduler

A secure, fully-local **Chrome extension (Manifest V3)** for scheduling VRChat group announcements.
VRChatのグループお知らせ投稿を予約管理するための、セキュアでローカル完結な **Chrome拡張機能（Manifest V3）** です。

使い方動画
https://drive.google.com/file/d/19oLJXNCheJwVyDH7iHtjL9J8E4tvRUyE/preview

---


## 🇯🇵 日本語

### 概要
VRChat Group Notify Scheduler は、VRChatのグループお知らせ（Announcement）を予約投稿するための Chrome 拡張機能です。
ログイン中のブラウザプロファイルをそのまま利用して動作し、大切なアカウント情報や予約データを外部サーバーに送信することなく、お使いのブラウザ内で安全に管理できます。

### 機能
- **予約投稿**: 日時を指定してお知らせを予約できます。指定時刻になると拡張機能が自動で投稿します。
- **X（Twitter）同時投稿**: 同じ内容を X（x.com）にも同時に投稿できます。画像付きの投稿にも対応しています。
- **繰り返し予約**: 毎日・毎週などの繰り返し投稿に対応しています。
- **画像添付**: お知らせに画像を添付して投稿できます。
- **投稿権限グループの自動判別**: 参加しているグループを自動取得し、お知らせ投稿権限のあるグループのみを識別して表示します。
- **キュー & ゴミ箱**: 予約済みの投稿をキューで一覧管理し、削除した投稿はゴミ箱から復元・完全削除できます。
- **ローカル保存**: 全てのデータは `chrome.storage.local` にローカル保存されます。外部サーバーやDBは一切不使用です。

### 前提条件
- 同じブラウザプロファイルで **VRChat（vrchat.com）にログイン済み**であること。
- X 同時投稿機能を使う場合は、同じプロファイルで **X（x.com）にもログイン済み**であること。

拡張機能はあなた自身のログインセッション（Cookie）を利用して、正規クライアントと同じ手順でAPIを呼び出します。別途パスワードやトークンを拡張機能へ入力する必要はありません。

### VRChat APIの利用と規約準拠について
本拡張機能は、VRChatの利用規約（Terms of Service）およびコミュニティガイドラインに違反しないよう、慎重に設計されています。
https://hello.vrchat.com/creator-guidelines


- **Community APIの利用**: VRChatが公開しているクライアント向けAPI（通称: Community API）を利用して、正規のクライアントと同様の手順で投稿を行います。
https://vrchat.community/reference/add-group-post

- **完全ローカル動作**: 一般的なBotサービスとは異なり、**あなたのブラウザ内でローカルに動作**します。これにより、「第三者（サーバー運営者）へのアカウント情報の共有」を回避し、安全に自動化機能を利用できます。
- **クレデンシャルの保護**: 認証はブラウザのログインセッションを利用するため、パスワードやトークンを拡張機能に入力・保存することはありません。

### プライバシー / セキュリティ
- **ローカル保存**: 予約データや設定はすべて `chrome.storage.local` にローカル保存され、外部に送信されません。
- **Cookieの利用範囲**: ブラウザのCookieは、あなた本人による VRChat / X のAPI呼び出しにのみ使用され、外部サーバーへ送信されることはありません。
- **declarativeNetRequest**: X への投稿時に必要な認証Cookieを付与するために `declarativeNetRequest` を使用します。
- **外部サーバー不使用**: 外部のDB・サーバーは一切使用しません。すべての処理はあなたのブラウザ内で完結します。

### セットアップ・ビルド
1. リポジトリをクローンします。
   ```bash
   git clone https://github.com/TakaAizu/vrchat-group-notify-scheduler.git
   cd vrchat-group-notify-scheduler
   ```
2. ライブラリをインストールします。
   ```bash
   npm install
   ```
3. 拡張機能をビルドします（`next build && node fix-extension.js` を実行し、読み込み可能な `out/` を生成します）。
   ```bash
   npm run build
   ```
4. Chrome で `chrome://extensions` を開き、**デベロッパーモード**を有効化します。
5. **「パッケージ化されていない拡張機能を読み込む」**をクリックし、生成された **`out/` ディレクトリ**を選択します。

> 💡 `npm run dev`（`next dev`）はUIの見た目を素早く確認するためのものです。`chrome.runtime` などの拡張機能API（VRChat認証・グループ取得・予約投稿・X同時投稿）は通常のブラウザタブでは動作しないため、実機能の確認には `npm run build` 後の `out/` を「パッケージ化されていない拡張機能を読み込む」で読み込んでください。

> ⚠️ **重要**: 単独で `next build` / `npx next build` を実行しないでください。
> Next.js は出力を `out/_next/` に生成しますが、Chrome は `_` で始まるパスを拒否するため、そのままでは拡張機能を読み込めなくなります（`Cannot load extension with file or directory name _next` エラー）。
> 必ず `npm run build` を使ってください。`fix-extension.js` が `out/_next` → `out/assets` へのリネームと参照の書き換えを行い、結果を検証します。
> もし `out/` が壊れてしまった場合は、`npm run verify` を実行すると再ビルドなしで修復・再検証できます。

詳細は [`CLAUDE.md`](./CLAUDE.md) を参照してください。

### 使い方
1. ツールバーの拡張機能アイコンをクリックしてポップアップ（フルページUI）を開きます。
2. 投稿先の**グループ**を選択します（お知らせ投稿権限のあるグループのみ表示されます）。
3. **タイトル / 本文 / 投稿日時**を入力します。
4. 必要に応じて、**繰り返し予約**・**画像添付**・**X同時投稿**・**通知**を設定します。
5. **Schedule** を押すと予約が確定し、キューに追加されます。
6. 予約済みの投稿は**キュー**で確認・管理できます。削除した投稿は**ゴミ箱**へ移動し、復元または完全削除が可能です。

### 技術スタック
- Chrome Extension (Manifest V3)
- Next.js (static export)
- React

### 作者
**TakaAizu**
https://x.com/TakaAizu

--

## 🇺🇸 English

### Overview
VRChat Group Notify Scheduler is a Chrome extension (Manifest V3) that lets Group Owners and Moderators schedule VRChat group announcements in advance. It runs entirely inside your browser using your existing login session, so your account information and scheduled data never leave your machine.

### Features
- **Schedule Posts**: Create and schedule group announcements for future dates. The extension posts automatically at the scheduled time.
- **X (Twitter) Cross-posting**: Post the same content to X (x.com) at the same time, including image attachments.
- **Recurring Schedules**: Supports repeating posts (e.g. daily, weekly).
- **Image Attachments**: Attach images to your announcements.
- **Auto-detect Postable Groups**: Automatically fetches your joined groups and shows only the ones where you have permission to post announcements.
- **Queue & Trash**: Manage scheduled posts in a queue; deleted posts move to the Trash where they can be restored or permanently removed.
- **Local Storage**: All data is stored locally in `chrome.storage.local`. No external database or server is used.

### Requirements
- You must be **logged into VRChat (vrchat.com)** in the same browser profile.
- To use X cross-posting, you must also be **logged into X (x.com)** in the same profile.

The extension uses your own login session (cookies) to call the APIs the same way the official client does. You never enter or store a password or token in the extension.

### VRChat API & ToS Compliance (Important)
This extension is designed with strict adherence to VRChat's Terms of Service and Community Guidelines.
https://hello.vrchat.com/creator-guidelines


- **Community API**: It uses the standard VRChat Client API (a.k.a. the Community API) to perform actions on your behalf, the same way the official client does.
https://vrchat.community/reference/add-group-post


- **Local Execution**: Unlike cloud-based scheduling bots, this extension runs **locally inside your browser**. This allows you to use automation tools without sharing your credentials with third-party servers, ensuring compliance with account security policies.
- **Credential Protection**: Authentication relies on your existing browser login session, so no password or token is ever entered into or stored by the extension.

### Privacy & Security
- **Local Storage**: All scheduled data and settings are stored locally in `chrome.storage.local` and are never sent anywhere.
- **Cookie Usage**: Browser cookies are used only for your own VRChat / X API calls and are never sent to any external server.
- **declarativeNetRequest**: The `declarativeNetRequest` API is used to attach the required authentication cookies when posting to X.
- **No External Servers**: No external database or server is used. Everything runs inside your browser.

### Setup & Build
1. Clone the repository.
   ```bash
   git clone https://github.com/TakaAizu/vrchat-group-notify-scheduler.git
   cd vrchat-group-notify-scheduler
   ```
2. Install dependencies.
   ```bash
   npm install
   ```
3. Build the extension (runs `next build && node fix-extension.js` to produce a loadable `out/`).
   ```bash
   npm run build
   ```
4. Open `chrome://extensions` in Chrome and enable **Developer mode**.
5. Click **Load unpacked** and select the generated **`out/` directory**.

> 💡 `npm run dev` (`next dev`) only previews the UI shell. Extension APIs such as `chrome.runtime` (VRChat auth, group fetching, scheduling, X cross-posting) do **not** work in a plain browser tab — to exercise real functionality, run `npm run build` and load the generated `out/` via **Load unpacked**.

> ⚠️ **Important**: Do **not** run `next build` / `npx next build` on its own.
> Next.js emits output under `out/_next/`, but Chrome rejects any path starting with `_`, leaving an extension that cannot be loaded (`Cannot load extension with file or directory name _next`).
> Always use `npm run build`. `fix-extension.js` renames `out/_next` → `out/assets`, rewrites references, and verifies the result.
> If `out/` ever ends up broken, run `npm run verify` to repair and re-validate in place — no full rebuild needed.

See [`CLAUDE.md`](./CLAUDE.md) for details.

### Usage
1. Click the extension icon in the toolbar to open the popup (full-page UI).
2. Select the target **group** (only groups where you can post announcements are shown).
3. Enter the **title, body, and scheduled date/time**.
4. Optionally configure **recurring schedule**, **image attachment**, **X cross-posting**, and **notifications**.
5. Press **Schedule** to confirm the reservation and add it to the queue.
6. Manage scheduled posts in the **Queue**. Deleted posts move to the **Trash**, where they can be restored or permanently removed.

### Tech Stack
- Chrome Extension (Manifest V3)
- Next.js (static export)
- React

### Author
**TakaAizu**
https://x.com/TakaAizu
