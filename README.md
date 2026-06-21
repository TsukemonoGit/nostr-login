## 🔀 このフォークについて

このリポジトリは [nostrband/nostr-login](https://github.com/nostrband/nostr-login) のフォークです。
元リポジトリに対し、以下の機能を追加・改善しています：

| 機能                            | 説明                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **NIP-46 仕様合致**             | `ping`, `switch_relays`, `logout` メソッドの実装。接続確立時の自動 `switch_relays` 呼び出し。NIP-46 仕様に準拠                                        |
| **nip44 暗号化の統合**          | `nip44_encrypt` / `nip44_decrypt` を Nip46Signer に統一。`codec_call` から `signer` メソッドへ移行                                                 |
| **createAccount2 非推奨化**     | NIP-46 仕様から `create_account` が別 NIP へ移動したため、deprecated 警告付きで維持                                                              |
| **rx-nostr ベースのリレー管理** | 自前の WebSocket 管理を [rx-nostr](https://github.com/penpenpng/rx-nostr) v3 に置き換え。自動再接続・lazy-keep 接続戦略・リアクティブな接続監視 |
| **複数 NIP-46 リレー対応**      | 単一リレー固定 → UI上で任意の複数リレーを追加・削除・リセット可能                                                                               |
| **QR コード読み取り**           | bunker URL の手入力のみ → カメラで QR コードをスキャンして接続                                                                                  |
| **NIP-46 署名のリトライ**       | リレー切断・タイムアウト時に自動リトライ（最大3回）& 強制再接続                                                                                 |
| **オフライン復帰の改善**        | タイムアウト時に signer を破壊せず保持し、オンライン復帰後に再利用                                                                              |
| **subscription 再開の改善**     | リレー再接続時に subscription を確実に再開し、署名ハングを防止                                                                                  |
| **ダイアログ閉じ時の安定性**    | ログイン済みでダイアログを開閉しても signer が破壊されないように修正                                                                            |
| **安定性改善**                  | 無限ローディング問題の解消、タイムアウト管理、キャンセル機能                                                                                    |
| **nsec ログイン**               | 外部で作成した秘密鍵（nsec）を直接入力してログイン可能                                                                                          |
| **バナー位置調整**              | バナーの表示位置を `top` / `center` / `bottom` から選択可能                                                                                     |
| **バナー動的表示切替**          | `setBannerVisible()` で初期化後もバナーの表示/非表示を動的に切り替え可能                                                                        |
| **NIP-46 エラーメッセージ改善** | リレー接続不可・署名機応答なし等のエラーをユーザーフレンドリーなメッセージで表示                                                                |
| **タイムアウト短縮**            | リレー接続待機を10秒→5秒に短縮し、キャンセル可能であることをヒント表示                                                                          |

### インストール

```bash
npm install @konemono/nostr-login
```

| パッケージ                         | npm                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@konemono/nostr-login`            | [![npm](https://img.shields.io/npm/v/@konemono/nostr-login)](https://www.npmjs.com/package/@konemono/nostr-login)                       |
| `@konemono/nostr-login-components` | [![npm](https://img.shields.io/npm/v/@konemono/nostr-login-components)](https://www.npmjs.com/package/@konemono/nostr-login-components) |

---

# Nostr-Login

`window.nostr` プロバイダーライブラリです。Nostr Connect (NIP-46)、ブラウザ拡張、読み取り専用ログイン、アカウント切り替え、OAuthライクなサインアップなどのUIを提供します。アプリ側は `window.nostr` と対話するだけで、認証は `nostr-login` が処理します。

## パッケージとして使う

```javascript
import { init as initNostrLogin } from "@konemono/nostr-login";

// window.nostr を呼ぶ前に init を実行
initNostrLogin({
  // options（後述）
});
```

`window.nostr` が初期化され、未認証時は初回呼び出しで自動的に認証フローが起動します。

認証フローを手動で起動する場合：

```javascript
import { launch as launchNostrLoginDialog } from "@konemono/nostr-login";

// init() を先に呼んでおくこと
launchNostrLoginDialog({
  startScreen: "signup",
});
```

### Next.js (SSR) 対応

`nostr-login` は `document` にアクセスするため、サーバーサイドレンダリング時にエラーになります。`useEffect` 内で動的インポートしてください：

```javascript
useEffect(() => {
  import("@konemono/nostr-login")
    .then(async ({ init }) => {
      init({
        // options
      });
    })
    .catch((error) => console.log("Failed to load nostr-login", error));
}, []);
```

> `"use client"` を記述していても、この対応が必要な場合があります。

---

## API

| 関数                        | 説明                                       |
| --------------------------- | ------------------------------------------ |
| `init(opts)`                | `window.nostr` を nostr-login にマッピング |
| `launch(opts)`              | 認証UIを表示                               |
| `logout()`                  | 現在のNIP-46接続を切断しログアウト         |
| `setDarkMode(dark)`         | ダークモードの切り替え                     |
| `setBannerVisible(visible)` | バナーの表示/非表示を動的に切り替え        |
| `setAuth(method, info)`     | プログラマティックにログイン/ログアウト    |
| `cancelNeedAuth()`          | Nostr Connect フローのキャンセル           |

---

## オプション（`init()` / `data-*` 属性）

パッケージとして使う場合は `init()` にオブジェクトとして渡します。

| `init()` オプション       | `data-*` 属性               | 説明                                                                                                                                                            |
| ------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `darkMode`                | `data-dark-mode`            | `true`/`false`。デフォルトはブラウザのカラーテーマに従う                                                                                                        |
| `theme`                   | `data-theme`                | カラーテーマ: `default`, `ocean`, `lemonade`, `purple`                                                                                                          |
| `bunkers`                 | `data-bunkers`              | NIP-46プロバイダーのドメイン名（カンマ区切り） 例: `nsec.app,highlighter.com`                                                                                   |
| `perms`                   | `data-perms`                | リクエストする[パーミッション](https://github.com/nostr-protocol/nips/blob/master/46.md#requested-permissions)（カンマ区切り） 例: `sign_event:1,nip04_encrypt` |
| `startScreen`             | `data-start-screen`         | 起動時の画面（下記参照）                                                                                                                                        |
| `noBanner`                | `data-no-banner`            | `true` でバナーを非表示にする（イベントディスパッチで手動起動）                                                                                                 |
| `bannerPosition`          | `data-banner-position`      | バナーの表示位置: `top`, `center`（デフォルト）, `bottom`                                                                                                       |
| `methods`                 | `data-methods`              | 許可する認証方法（カンマ区切り）: `connect`, `extension`, `readOnly`, `local`, `nsec`                                                                           |
| `title`                   | `data-title`                | ウェルカム画面のタイトル                                                                                                                                        |
| `description`             | `data-description`          | ウェルカム画面の説明文                                                                                                                                          |
| `otpRequestUrl`           | `data-otp-request-url`      | OTPリクエスト用URL                                                                                                                                              |
| `otpReplyUrl`             | `data-otp-reply-url`        | OTP応答用URL                                                                                                                                                    |
| `signupRelays`            | `data-signup-relays`        | ローカルサインアップ時のnip65公開先リレー（カンマ区切り）                                                                                                       |
| `outboxRelays`            | `data-outbox-relays`        | ローカルサインアップ時にnip65イベントに追加するリレー（カンマ区切り）                                                                                           |
| `signupNstart`            | `data-signup-nstart`        | `true` で start.njump.me を使用                                                                                                                                 |
| `followNpubs`             | `data-follow-npubs`         | njump.meサインアップ時にフォローするnpub（カンマ区切り）                                                                                                        |
| `devOverrideBunkerOrigin` | —                           | テスト用: バンカーoriginのオーバーライド                                                                                                                        |
| `dev`                     | `data-dev`                  | 開発モード                                                                                                                                                      |
| `onAuth`                  | —                           | `nlAuth` イベントの代わりに使うコールバック `(npub, options) => void`                                                                                           |
| `customNostrConnect`      | `data-custom-nostr-connect` | `true` でモーダルを表示せず `nlNeedAuth` イベントを発火                                                                                                         |

### startScreen の選択肢

`welcome` · `welcome-login` · `welcome-signup` · `signup` · `local-signup` · `login` · `login-nsec` · `otp` · `connect` · `login-bunker-url` · `login-read-only` · `connection-string` · `switch-account` · `import`

---

## UIの更新

ユーザーが認証操作を行うと `nlAuth` イベントが `document` にディスパッチされます：

```javascript
document.addEventListener("nlAuth", (e) => {
  // e.detail.type: 'login' | 'signup' | 'logout'
  if (e.detail.type === "login" || e.detail.type === "signup") {
    onLogin(); // window.nostr で pubkey を取得してプロフィール表示
  } else {
    onLogout(); // ローカルデータをクリア
  }
});
```

## イベントディスパッチ

コードからモーダル表示やログアウトをトリガーできます：

```javascript
// 認証UIの起動
document.dispatchEvent(new CustomEvent("nlLaunch", { detail: "welcome" }));

// ログアウト
document.dispatchEvent(new Event("nlLogout"));

// ダークモード切り替え
document.dispatchEvent(new CustomEvent("nlDarkMode", { detail: true }));

// プログラマティックなログイン/ログアウト
document.dispatchEvent(
  new CustomEvent("nlSetAuth", { detail: { method, info } }),
);

// Nostr Connect キャンセル
document.dispatchEvent(new Event("nlNeedAuthCancel"));
```

---

## フォーク固有の機能

### NIP-46 仕様合致

NIP-46 仕様に準拠するため、以下の実装を追加しました：

- **`ping()`** — signer の死活確認（`[] → "pong"`）
- **`switchRelays()`** — リレーリストの更新。接続確立時に自動的に呼び出し、signer から返されたリレーリストにプールを更新
- **`logout()`** — NIP-46 RPC 経由でリモート signer にセッション終了を通知。失敗してもローカルクリーンアップは継続（非致命的エラー）
- **`nip44Encrypt()` / `nip44Decrypt()`** — NIP-44 暗号化・復号を Nip46Signer に統一
- **`createAccount2()`** — NIP-46 仕様から `create_account` が別 NIP へ移動したため deprecated 化。警告ログを出力しながら一時的に維持

`switch_relays` は NIP-46 Spec で "should"（MUST ではない）と定義されており、失敗時は警告出力のみの非致命的エラーとして扱います。

### rx-nostr ベースのリレー管理

リレーの WebSocket 接続管理を [rx-nostr](https://github.com/penpenpng/rx-nostr) v3 に置き換えています。

- **自動再接続**: 指数バックオフ＋ジッター付きリトライ（最大5回）。リトライ上限到達後も30秒後に自動再接続を試行
- **lazy-keep 接続戦略**: リレーへの接続は subscription/send 時にオンデマンドで行い、デフォルトリレーから外れるまで接続を維持
- **リアクティブな接続監視**: `createConnectionStateObservable()` による接続状態の監視（ポーリング不要）
- **ベストエフォート送信**: `cast()` で少なくとも1つのリレーに送れたら完了（NIP-46 RPC に最適）
- **署名検証**: `@rx-nostr/crypto` の公式 `verifier` を使用（@noble/@scure ベース）

### 複数 NIP-46 リレー設定

UI上の **Advanced: Relay Settings** から NIP-46 接続に使用するリレーを追加・削除できます。設定は `localStorage` に自動保存され、次回以降も引き継がれます。「Reset to defaults」で初期値（`wss://relay.nsec.app/`, `wss://ephemeral.snowflare.cc/`）にリセットされます。

### QR コードスキャン

bunker URL 入力画面で **Scan QR Code** ボタンからカメラを起動し、`bunker://` または `nostrconnect://` で始まるQRコードを読み取って自動入力できます。

### NIP-46 署名の自動リトライ

リレー切断やタイムアウトで署名が失敗した場合、最大3回まで自動リトライします。リトライ前にリレーの強制再接続とsubscriptionの再開を行います。ユーザーによる明示的な拒否やキャンセル時はリトライしません。

### タイムアウト設計

各フェーズで異なるタイムアウトを設定しています。

| フェーズ                | タイムアウト | 定数 / 箇所                                  | 説明                                           |
| ----------------------- | ------------ | -------------------------------------------- | ---------------------------------------------- |
| リレー接続待ち          | **5秒**      | `RelayPool.connect()` / `RelayHealthManager` | リレーへの WebSocket 接続確立を待つ時間        |
| EOSE / OK 待ち          | **5秒**      | `eoseTimeout` / `okTimeout` (rx-nostr)       | リレーからの EOSE・OK メッセージの待機         |
| バナー通知表示          | **5秒**      | `CALL_TIMEOUT`                               | 署名開始からバナーにローディング通知を出すまで |
| NIP-46 RPC リクエスト   | **30秒**     | `NIP46_REQUEST_TIMEOUT`                      | 署名機への署名・暗号化リクエストの応答待ち     |
| auth_url 受信後         | **120秒**    | `NIP46_REQUEST_TIMEOUT × 4`                  | ユーザーが署名機アプリで操作する時間           |
| 初回接続（listen）      | **60秒**     | `NostrRpc.listen()`                          | Nostr Connect 初回接続の確立待ち               |
| connect リクエスト      | **30秒**     | `NostrRpc.connect()`                         | connect メソッドの応答待ち                     |
| エラーリレー自動再接続  | **30秒**     | `RelayPool` (delay)                          | リトライ上限到達後の自動再接続までの待機       |
| auth_url 後のバナー通知 | **120秒**    | `AUTH_URL_CALL_TIMEOUT`                      | auth_url 受信後のバナータイムアウト通知延長    |

> 定数は `packages/auth/src/const/index.ts` で一元管理しています。

### subscription の再開改善

リレー再接続後に NIP-46 の subscription（kind:24133）が死んでいた場合、EOSE待ちでハングしない方式で確実に再サブスクライブします。10秒のタイムアウトも設け、万が一のハングを防止します。

### オフライン復帰の改善

オフラインでタイムアウトした場合、signer インスタンスを破壊せず進行中のRPCリクエストだけをキャンセルします。オンライン復帰後にそのまま署名を再開できます。

### nsec ログイン

Log in 画面の「With nsec」ボタンから、外部で生成した秘密鍵（nsec）を直接入力してログインできます。入力画面には警告メッセージが表示され、秘密鍵の直接入力は推奨されない旨と、キーストアサービスへの移行を案内します。ログイン後はインポートフロー（キーストアへの鍵移行案内）が表示されます。

> **注意**: nsec はローカルストレージに保存されます。セキュリティ上、キーストアサービス（nsec.app 等）への移行を推奨します。

---

## OTP ログイン

`otpRequestUrl` と `otpReplyUrl` の両方を設定すると、ウェルカム画面に「Login with DM」ボタンが表示されます。

1. ユーザーが nip05 または npub を入力 → `<otpRequestUrl>?pubkey=<user-pubkey>` に GET リクエスト。サーバーはDMでワンタイムコードを送信し200を返す。
2. ユーザーがコードを入力 → `<otpReplyUrl>?pubkey=<user-pubkey>&code=<code>` に GET リクエスト。サーバーは検証後200とオプションのペイロードを返す。

ペイロードは `nlAuth` イベントの `otpData` フィールドとして配信され、`localStorage` に保存されてページリロード時にも再配信されます。

## サンプル

- [Basic HTML Example](./examples/usage.html)

## ライセンス

MIT
