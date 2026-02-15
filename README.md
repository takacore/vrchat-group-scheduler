# VRChat Group Notify Scheduler

A secure, local Electron application for scheduling VRChat group announcements.
VRChatのグループお知らせ投稿を予約管理するための、セキュアなローカルElectronアプリケーションです。

---

## 🇺🇸 English

### Overview
VRChat Group Notify Scheduler is a desktop application designed to help Group Owners and Moderators schedule announcements in advance. It runs locally on your machine, ensuring that your tokens and data remains in your control.

### Features
- **Secure Authentication**: Supports VRChat 2FA login. Credentials are encrypted using OS-native keychains (Electron `safeStorage`).
- **Schedule Posts**: Create, edit, and schedule group announcements for future dates.
- **Local Data Persistence**: All data (posts, sessions) is stored locally in your OS's user data directory.
- **Group Management**: Automatically fetches joined groups and identifies groups where you have permission to post.
- **Safety**: No external database or server. Your data never leaves your machine.

### Security
- **Token Encryption**: Login cookies are encrypted using your OS account's credentials. They cannot be decrypted on other machines.
- **Git Friendly**: `.gitignore` is configured to exclude all sensitive data (`data/` directory).

### Installation (Development)
1. Clone the repository.
   ```bash
   git clone https://github.com/TakaAizu/vrchat-group-notify-scheduler.git
   cd vrchat-group-notify-scheduler
   ```
2. Install dependencies.
   ```bash
   npm install
   ```
3. Run in development mode.
   ```bash
   npm run dev
   ```

### Build (Release)
To create an executable for your platform:

- **Windows (x64 / Portable)**:
  ```bash
  npm run build:win
  ```
  Output: `dist/VRChat Group Scheduler X.X.X.exe`

- **macOS (.dmg)**:
  ```bash
  npm run build:mac
  ```
  Output: `dist/VRChat Group Scheduler-X.X.X.dmg`

### Tech Stack
- Electron
- Next.js (Nextron)
- Node Schedule

### Author
**TakaAizu**

---

## 🇯🇵 日本語

### 概要
VRChat Group Notify Scheduler は、VRChatのグループお知らせ（Announcement）を予約投稿するためのデスクトップアプリケーションです。
ローカルPC上で動作し、大切なアカウント情報や予約データを外部サーバーに送信することなく安全に管理できます。

### 機能
- **セキュアな認証**: VRChatの2段階認証（2FA）ログインに対応。認証情報はOS標準の機能を用いて暗号化されます。
- **予約投稿**: 日時を指定してお知らせを予約できます。指定時刻になると自動で投稿されます（アプリ起動が必要）。
- **ローカル保存**: 全てのデータはPC内のユーザーデータフォルダに保存されます。
- **グループ管理**: 参加しているグループを自動取得し、投稿権限のあるグループを識別します。
- **安全性**: 外部サーバーやDBは一切不使用。データはあなたのPC内でのみ完結します。

### セキュリティについて
- **トークン暗号化**: ログイン情報は Electron `safeStorage` APIにより暗号化されます。万が一ファイルが流出しても、他のPCでは復号できません。
- **Git管理**: 安全のため、`data/` ディレクトリ（認証情報や投稿データ）は `.gitignore` で除外されています。

### インストール・起動 (開発用)
1. リポジトリをクローンします。
   ```bash
   git clone https://github.com/TakaAizu/vrchat-group-notify-scheduler.git
   cd vrchat-group-notify-scheduler
   ```
2. ライブラリをインストールします。
   ```bash
   npm install
   ```
3. 開発モードで起動します。
   ```bash
   npm run dev
   ```

### ビルド (配布用)
配布用の実行ファイルを作成するには以下のコマンドを実行します。

- **Windows用 (x64 / ポータブル版)**:
  ```bash
  npm run build:win
  ```
  出力先: `dist/VRChat Group Scheduler X.X.X.exe`
  ※インストール不要でそのまま動くExeファイルが生成されます。

- **macOS用 (.dmg)**:
  ```bash
  npm run build:mac
  ```
  出力先: `dist/VRChat Group Scheduler-X.X.X.dmg`

### 技術スタック
- Electron
- Next.js (Nextron)
- Node Schedule

### 作者
**TakaAizu**
