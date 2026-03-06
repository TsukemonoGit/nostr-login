# nostr-login 現状分析レポート

## 目次

1. [プロジェクト概要](#1-プロジェクト概要)
2. [よいところ（強み）](#2-よいところ強み)
3. [改善が必要なところ（課題）](#3-改善が必要なところ課題)
4. [こうしたらもっと良くなる（提案）](#4-こうしたらもっと良くなる提案)

---

## 1. プロジェクト概要

### 構成

| パッケージ                                      | 役割                           | 主要技術                                 |
| ----------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `@konemono/nostr-login` (auth)                  | 認証ロジック・リレー管理・署名 | TypeScript, rx-nostr, nostr-tools, tseep |
| `@konemono/nostr-login-components` (components) | UI コンポーネント群            | Stencil.js, Tailwind CSS, @stencil/store |

### アーキテクチャ

```
[アプリ] ←→ window.nostr (NIP-07互換)
              ↕
         NostrLoginInitializer (Mediator)
              ↕
   ┌──────────┼──────────────┐
   ↓          ↓              ↓
AuthNostr   ModalManager   BannerManager
Service     (UIフロー管理)  (状態表示)
   ↕                ↕
Nip46.ts        nl-auth / nl-banner
(RelayPool,     (Web Components)
 NostrRpc,
 Nip46Signer)
```

### フォーク固有の改善（upstream からの差分）

- rx-nostr ベースのリレー管理（自動再接続、lazy-keep、リアクティブ監視）
- 複数 NIP-46 リレー対応
- QR コードスキャン
- NIP-46 署名の自動リトライ（最大3回）
- subscription 再開の改善
- オフライン復帰の改善
- nsec ログイン

---

## 2. よいところ（強み）

### 2.1 アーキテクチャ

- **Mediator パターン**: `NostrLoginInitializer` が全モジュール間のイベント配線を一手に担い、各モジュールの疎結合を実現。モジュール同士が直接依存しない設計
- **イベント駆動設計**: `tseep` の `EventEmitter` ベースで各モジュール間を疎結合に接続。`document` のカスタムイベント (`nlAuth`, `nlLaunch` 等) で外部アプリとも疎結合に連携
- **Web Components**: Stencil.js による Shadow DOM 対応で、フレームワーク非依存。React/Vue/Svelte/素のHTML、どこにでも組み込み可能
- **パッケージ分離**: ロジック (auth) と UI (components) が明確に分離されており、UI だけ差し替えることも理論上可能

### 2.2 rx-nostr 導入（フォーク改善）

- **自動再接続**: 指数バックオフ + ジッター付きリトライ（最大5回）が自動で行われ、リトライ上限到達後も30秒後に自動再接続
- **lazy-keep 接続戦略**: subscription/send 時にオンデマンド接続し、デフォルトリレーから外れるまで維持。不要な常時接続を排除
- **リアクティブ接続監視**: `createConnectionStateObservable()` でポーリング不要の接続待機を実現（CPU 無駄遣いの排除）
- **ベストエフォート送信**: `cast()` で少なくとも1リレーに送れたら完了。NIP-46 RPC に最適な送信方式
- **公式 verifier**: `@rx-nostr/crypto` の `verifier` を使用（nostr-tools の `verifyEvent` を `as any` でラップする必要がなくなった）

### 2.3 NIP-46 署名の堅牢性（フォーク改善）

- **自動リトライ**: 最大3回のリトライ。ユーザーの明示的拒否・キャンセル時はリトライしない（`Nip46Error.retryable` で判別）
- **構造化エラー**: `Nip46Error` にエラーコード (`TIMEOUT`, `RELAY_DISCONNECTED`, `SIGNER_REJECTED`, `CANCELLED`) と `retryable` プロパティを持たせ、リトライ可否を判断可能にした
- **オフライン復帰**: タイムアウト時に signer を破棄せず保持。オンライン復帰後にそのまま再開可能
- **subscription 再開**: リレー再接続時に kind:24133 の subscription を確実に再開（EOSE 待ちでハングしない方式）

### 2.4 認証フローの網羅性

- NIP-46 (Nostr Connect)、ブラウザ拡張 (NIP-07)、nsec 直接入力、読み取り専用、OTP、ローカルサインアップの **6方式** をフルカバー
- QR コードスキャンによる bunker URL 入力サポート
- アカウント切り替え、インポート/エクスポート、鍵移行案内まで一貫して提供
- `methods` オプションで認証方式の取捨選択が可能

### 2.5 UI / UX

- **5テーマ** (`default`, `ocean`, `lemonade`, `purple`, `crab`) + ダークモード + RTL 対応の基盤
- `1画面 = 1コンポーネント` の原則が守られ、コンポーネント粒度が適切
- ナビゲーション履歴（`path` 配列）による戻る操作のサポート
- nsec ログイン時のセキュリティ警告表示が適切
- `sr-only` テキストでスクリーンリーダー対応が一部実装されている

### 2.6 開発基盤

- `strict: true` (auth パッケージ) で型安全性を確保
- Prettier 設定がパッケージ間で統一
- `noUnusedLocals: true`, `noUnusedParameters: true` (components) で未使用コード検出
- ビルド後 CSS 最適化（`post-build-plugin.js` で重複 CSS 文字列を共通化）
- localStorage ベースのアカウント永続化が充実（`upgradeInfo()` で古い形式の自動マイグレーション）

---

## 3. 改善が必要なところ（課題）

### 3.1 巨大ファイル / God Object

| ファイル              | 行数  | 問題                                                                                                            |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `AuthNostrService.ts` | 925行 | 認証フロー管理、署名、リレー管理、アカウント管理が1クラスに混在                                                 |
| `Nip46.ts`            | 862行 | `RelayPool`, `NostrRpc`, `IframeNostrRpc`, `ReadyListener`, `Nip46Signer`, `Nip46Error` の6クラス+型が1ファイル |
| `ModalManager.ts`     | 718行 | `launch()` メソッドが約400行。内部に `login`, `signup`, `nostrConnect` 等のクロージャを定義                     |

これらは単一責任原則に反しており、変更時の影響範囲が広く、テストも書きにくい。

### 3.2 型安全性の問題

- **`@ts-ignore` の多用**: `index.ts`, `iife-module.ts`, `Nostr.ts`, `AuthNostrService.ts`, `nl-auth.tsx` に散在。型の不整合を場当たり的に抑制
- **`as any` キャスト**: `AuthNostrService.ts` の `(this.signer.rpc as any)` など、型情報を捨てた操作が複数箇所
- **components の `strict: true` 未設定**: null安全性チェックが掛かっておらず、ランタイムエラーのリスク
- **`window.nostr` の NIP-07 型未定義**: `NostrExtensionService.ts` が `// @ts-ignore` でアクセス

### 3.3 セキュリティ上の懸念

| 問題                                                 | 箇所                                           | リスク                                                    |
| ---------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| `nostrConnectSecret` の生成が `Math.random()` ベース | `AuthNostrService.ts`                          | **暗号学的に不適切**。`crypto.getRandomValues` を使うべき |
| nsec が CustomEvent の detail に平文で載る           | `nl-signin-nsec.tsx` → `nlLoginNsec.emit()`    | イベントリスナーで秘密鍵を傍受可能                        |
| `signupNjump()` でインラインHTML生成                 | `ModalManager.ts` L293-346                     | XSS リスク                                                |
| `ReadyListener` のサブドメインマッチが寛容           | `Nip46.ts` の `endsWith('.' + originHostname)` | origin 偽装の可能性                                       |
| iframe URL の検証なし                                | `nl-banner.tsx` の `<iframe src={this.url}>`   | 任意 URL 注入の可能性                                     |
| `Info.sk` にメモリ上で秘密鍵を平文保持               | `types/index.ts`                               | 型定義レベルの設計上の問題                                |

### 3.4 定数・設定の管理

- **`OUTBOX_RELAYS` の重複定義**: `utils/index.ts` と `AuthNostrService.ts` で**異なる値**のリレーリストが定義されている
  - utils: `['wss://purplepag.es', 'wss://relay.nos.social', 'wss://user.kindpag.es', 'wss://relay.damus.io', 'wss://nos.lol']`
  - AuthNostrService: `['wss://user.kindpag.es', 'wss://purplepag.es', 'wss://relay.nos.social']`
- **`NOSTRCONNECT_APPS` がハードコード**: バンカーサービスのリストが `AuthNostrService.ts` に直書き
- **`NIP46_CONNECT_TIMEOUT` がデッドコード**: 定義はあるが使用箇所がない
- **マジックナンバーの散在**: `setTimeout(() => dialog.close(), 300)`, `5秒タイムアウト`, `8秒プロフィールフェッチ` 等がコード中に直書き

### 3.5 Components パッケージの問題

- **イベント命名の不統一**: `nl-auth` 系は `nlCloseModal`, `nlLogin`（`nl` プレフィックス）、`nl-banner` 系は `handleLoginBanner`, `handleLogoutBanner`（`handle` プレフィックス）
- **render() 内の副作用**:
  - `nl-banner`: `deepQuerySelectorAll('dialog')` で毎レンダリングごとにフル DOM 走査
  - `nl-auth`: `this.prevPath = currentModule` を render 内で代入
- **SVG アイコンの重複**: 同じアイコン SVG が複数コンポーネントにコピペで埋め込まれている
- **未使用 State**: `nl-signin` の `isGood` が宣言されているが値が変更されない
- **ストアが1ファイルにフラット**: `store/index.ts` に全画面の状態が集約。スケールしにくい

### 3.6 アクセシビリティ (WCAG 2.1 AA 未達の可能性)

| 項目                                | 状態                                        |
| ----------------------------------- | ------------------------------------------- |
| input 要素の `label` / `aria-label` | **なし** — 全 input に label がない         |
| モーダルのフォーカストラップ        | **未実装** — Tab キーでモーダル外に脱出可能 |
| Escape キーでモーダル閉じ           | **未実装**                                  |
| キーボードのみでの操作完結          | **未検証**                                  |
| カラーコントラスト                  | テーマ依存。検証不十分                      |
| スクリーンリーダー                  | `sr-only` が一部ボタンにあるが不完全        |
| `dir="ltr"` ハードコード            | RTL 対応と矛盾の可能性                      |

### 3.7 テスト・CI の欠如

- **ユニットテスト**: テストファイルが **1つも存在しない** (`.test.ts`, `.spec.ts` ゼロ)
- **E2E テスト**: なし（Stencil は Jest + Puppeteer 対応だが未使用）
- **CI/CD パイプライン**: `.github/` ディレクトリがなく、GitHub Actions 等の自動テスト・ビルド・デプロイが未設定
- **ESLint**: 設定ファイルなし。コード品質の静的チェックがなされていない

### 3.8 依存関係の問題

| 問題                                                  | 詳細                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `@rx-nostr/crypto` のバージョンが `^0.0.0`            | プレリリース依存はリスクが高い                                                     |
| `@konemono/nostr-login-components` が devDependencies | ランタイムで `import` されるため、peerDependencies が適切                          |
| `@noble/*`, `@scure/base` が暗黙的依存                | 直接 import しているが `package.json` に未記載（nostr-tools 経由で解決される前提） |
| `tailwindcss` 等が dependencies                       | ビルド時依存のため `devDependencies` が適切                                        |
| `components.d.ts` がエクスポート不足                  | 30 コンポーネント中 4 つだけが `index.ts` でエクスポート                           |

### 3.9 その他の技術的負債

- コメントアウトされたコードが多数残存（`nl-signup`, `nl-signin`, `store/index.ts` 等）
- `// ???`, `// FIXME`, `// TODO` コメントが散在（技術的負債の自覚はあるが未解決）
- `getRelays()` が空オブジェクトを返すハードコード（FIXME コメントあり）
- `getIcon()` が常に `/favicon.ico` を返す（FIXME コメントあり）
- `localStorageGetItem()` の catch が空 — JSON パースエラーが無視される
- `Nip44` クラスのキャッシュ `Map` にサイズ制限なし（メモリリーク可能性）

---

## 4. こうしたらもっと良くなる（提案）

### 4.1 🔴 高優先度

#### A. テスト基盤の構築

**現状**: テストが0件。リファクタリングや機能追加のたびに手動テストが必要。

**提案**:

1. auth パッケージに **Vitest** を導入（Rollup + ESM と親和性が高い）
2. components パッケージに Stencil 内蔵の **Jest + Testing Library** を活用
3. 優先的にテストすべき箇所:
   - `Nip46.ts` の RPC 通信フロー
   - `AuthNostrService.ts` の `signEvent` リトライロジック
   - `utils/index.ts` の localStorage 操作・URL パース
   - `store/index.ts` のナビゲーション状態管理

#### B. セキュリティ修正

```typescript
// ❌ 現状: Math.random() ベース
const nostrConnectSecret = Math.random().toString(36).substring(7);

// ✅ 改善: crypto.getRandomValues ベース
const nostrConnectSecret = Array.from(
  crypto.getRandomValues(new Uint8Array(16)),
  (b) => b.toString(16).padStart(2, "0"),
).join("");
```

- nsec イベント送信時の最小化（必要な変換後のデータのみ emit）
- `signupNjump()` のインライン HTML を DOM API に置き換え（XSS 対策）
- iframe URL のホワイトリスト検証

#### C. アクセシビリティ強化

1. 全 `<input>` に `<label>` または `aria-label` を追加
2. モーダルにフォーカストラップを実装（`focusTrap` ライブラリ or 自前実装）
3. Escape キーでモーダルを閉じる機能を追加
4. ARIA ロール・ステートの適切な付与 (`role="dialog"`, `aria-modal="true"` 等)

### 4.2 🟡 中優先度

#### D. AuthNostrService の責務分割

```
AuthNostrService (925行)
  ↓ 分割
  ├── AuthFlowManager    — 認証フロー制御 (nostrConnect, createAccount, etc.)
  ├── SigningService      — 署名処理 + リトライ (signEvent, encrypt/decrypt)
  ├── RelayHealthManager  — リレー接続監視 + 再接続
  └── AccountManager      — アカウント管理 (switchAccount, setLocal, etc.)
```

#### E. Nip46.ts の分割

```
Nip46.ts (862行)
  ↓ 分割
  ├── nip46/RelayPool.ts       — rx-nostr ベースのリレー管理
  ├── nip46/NostrRpc.ts        — NIP-46 RPC プロトコル
  ├── nip46/IframeNostrRpc.ts  — iframe 経由 RPC
  ├── nip46/Nip46Signer.ts     — リモート署名ファサード
  ├── nip46/ReadyListener.ts   — postMessage 準備完了待ち
  ├── nip46/errors.ts          — Nip46Error
  └── nip46/types.ts           — 型定義
```

#### F. 定数の一元管理

```typescript
// const/index.ts に統合
export const OUTBOX_RELAYS = [
  "wss://purplepag.es",
  "wss://relay.nos.social",
  "wss://user.kindpag.es",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

export const NOSTRCONNECT_APPS = [
  /* ... */
];
// ↑ ハードコードされたバンカーリストも定数に外出し
```

- `NIP46_CONNECT_TIMEOUT` を使うか、削除するかを決定
- マジックナンバーを名前付き定数に変換

#### G. イベント命名の統一

```
// ❌ 現状: 混在
handleLoginBanner, handleLogoutBanner, handleNotifyConfirmBanner

// ✅ 統一: nl プレフィックス
nlBannerLogin, nlBannerLogout, nlBannerNotifyConfirm
```

#### H. @ts-ignore の排除

```typescript
// NIP-07 window.nostr の型定義を追加
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: UnsignedEvent): Promise<SignedEvent>;
      nip04?: { encrypt; decrypt };
      nip44?: { encrypt; decrypt };
    };
  }
}
```

- `StartScreens` 型に `'confirm-logout'` を追加して `@ts-ignore` を排除
- `iife-module.ts` の `methods` 型変換を型安全に

### 4.3 🟢 低優先度（改善レベル）

#### I. CI/CD パイプラインの構築

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint .
```

#### J. ESLint の導入

- `@typescript-eslint/eslint-plugin` で型安全性チェック
- `no-explicit-any` ルールの段階的適用
- `no-ts-ignore` / `no-ts-comment` ルールで `@ts-ignore` の新規追加を防止

#### K. SVG アイコンの共通化

```
方法1: アイコンコンポーネント (nl-icon) を作成し、name Prop でアイコンを切り替え
方法2: SVG スプライトシート + <use href="#icon-name"> で参照
```

#### L. Store の構造化

```typescript
// 現状: フラットな1ファイル
state.screen, state.nlSignin.loginName, state.nlSignup.name, ...

// 改善: ドメイン別に分割
const navigationStore = createStore({ screen, prevScreen, path });
const signinStore = createStore({ loginName, domain });
const signupStore = createStore({ name, servers });
```

#### M. render() 内副作用の除去

```typescript
// ❌ nl-banner: render内でDOM走査
render() {
  const dialogs = deepQuerySelectorAll(document, 'dialog');
  // ...
}

// ✅ lifecycle メソッドで事前計算
componentWillRender() {
  this.hasOpenDialog = /* dialog検出ロジック */;
}
```

#### N. iife-module.ts のDRY化

```typescript
// ❌ 現状: 各属性を個別に取得
const darkMode = cs?.getAttribute("data-dark-mode");
const bunkers = cs?.getAttribute("data-bunkers");
const startScreen = cs?.getAttribute("data-start-screen");
// ... 18回繰り返し

// ✅ マッピングテーブルで自動変換
const ATTR_MAP = {
  "data-dark-mode": { key: "darkMode", type: "boolean" },
  "data-bunkers": { key: "bunkers", type: "string" },
  "data-start-screen": { key: "startScreen", type: "string" },
  // ...
};
const opts = Object.fromEntries(
  Object.entries(ATTR_MAP)
    .filter(([attr]) => cs?.hasAttribute(attr))
    .map(([attr, { key, type }]) => [
      key,
      convert(cs.getAttribute(attr), type),
    ]),
);
```

#### O. 依存関係の整理

- `@noble/*`, `@scure/base` を `package.json` の `dependencies` に明示
- `tailwindcss` 等を `devDependencies` に移動
- `@konemono/nostr-login-components` を `peerDependencies` に変更
- `@rx-nostr/crypto` のバージョンを安定版にアップデート（リリースされ次第）

#### P. ドキュメント改善

- 各モジュールの JSDoc コメントの充実（特に `AuthNostrService`, `Nip46.ts`）
- API リファレンスの自動生成（TypeDoc 等）
- CONTRIBUTING.md の追加
- CHANGELOG.md の追加（lerna-changelog 等）

---

## まとめ

### 総合評価

| 観点             | 評価  | コメント                                                               |
| ---------------- | ----- | ---------------------------------------------------------------------- |
| 機能の網羅性     | ★★★★★ | NIP-46, NIP-07, nsec, OTP, read-only, ローカルの6方式を完全カバー      |
| rx-nostr 導入    | ★★★★★ | 接続管理が大幅に改善。自動再接続・リアクティブ監視が堅牢               |
| 署名の堅牢性     | ★★★★☆ | リトライ・構造化エラー・オフライン復帰が実装済み。さらなる改善余地あり |
| コード品質       | ★★★☆☆ | 巨大ファイルの分割、型安全性の向上、技術的負債の清算が必要             |
| セキュリティ     | ★★★☆☆ | `Math.random()` の秘密値生成、インラインHTML生成等に対処が必要         |
| アクセシビリティ | ★★☆☆☆ | フォーカストラップ、label、Escape キー等の基本対応が不足               |
| テスト           | ★☆☆☆☆ | テスト0件。CI/CD もなし。最大の改善ポイント                            |
| ドキュメント     | ★★★★☆ | README が充実。JSDoc・API リファレンスが不足                           |

### 優先度別ロードマップ

```
Phase 1 (高優先度) — 品質と安全性の基盤
  ├── テスト基盤の構築 (Vitest / Jest)
  ├── セキュリティ修正 (crypto.getRandomValues, XSS 対策)
  └── アクセシビリティ基本対応 (label, フォーカストラップ, Escape)

Phase 2 (中優先度) — 保守性の向上
  ├── AuthNostrService の責務分割
  ├── Nip46.ts の分割
  ├── 定数の一元管理
  ├── イベント命名統一
  └── @ts-ignore の排除

Phase 3 (低優先度) — 開発体験の向上
  ├── CI/CD パイプライン構築
  ├── ESLint 導入
  ├── SVG アイコン共通化
  ├── Store 構造化
  └── ドキュメント改善
```

---

## 5. 実装対応ログ

### Phase 1B: セキュリティ修正 ✅

- `AuthNostrService.ts`: `Math.random().toString(36).substring(7)` → `crypto.getRandomValues(new Uint8Array(16))` に置換（`nostrConnectSecret` 生成）
- `Nip46.ts` (`getId()`): `Math.random()` → `crypto.getRandomValues(new Uint8Array(8))` に置換
- 暗号学的に安全な乱数生成を全箇所で使用するように修正

### Phase 1C: アクセシビリティ ✅

- 9コンポーネントの `<input>` 要素に `aria-label` を追加:
  - `nl-signup`, `nl-signin`, `nl-signin-read-only`, `nl-signin-otp`, `nl-signin-nsec`, `nl-signin-connection-string`, `nl-signin-bunker-url`, `nl-nip46-relay-settings`, `nl-local-signup`
- `nl-auth.tsx`: `role="dialog"`, `aria-modal="true"`, `aria-label="Nostr Login"` を追加
- `nl-auth.tsx`: Escapeキーでモーダルを閉じる `@Listen('keydown')` ハンドラ追加
- `nl-nip46-relay-settings.tsx`: 非推奨 `onKeyPress` → `onKeyDown` に修正

### Phase 2F: 定数集約 ✅

- `const/index.ts` を拡張: `OUTBOX_RELAYS`, `DEFAULT_SIGNUP_RELAYS`, `NOSTRCONNECT_APPS` を追加
- `AuthNostrService.ts`, `utils/index.ts` からローカル定義を削除、`../const` からインポートに変更
- 未使用の `NIP46_CONNECT_TIMEOUT` を削除

### Phase 2H: @ts-ignore 排除 ✅

- `types.ts`: `StartScreens` 型に `'confirm-logout'`, `'login-nsec'` を追加
- `index.ts`: `window.nostr` を `(window as any).nostr` で型安全にアクセス
- `Nostr.ts`: `signEvent` パラメータに適切な型定義追加
- `ProcessManager.ts`: `return result` → `return result as T`
- `iife-module.ts`: `AuthMethod` 型インポート追加、`as AuthMethod[]` キャスト
- `NostrExtensionService.ts`: 全面リライト — `const win = window as Record<string, any>` パターンで8箇所の @ts-ignore を解消
- `ModalManager.ts`: `removeChild` 呼び出しにnullチェック追加
- `Nip46.ts`: `undefined as unknown as RpcResponse` パターン使用
- `nl-auth.tsx`: コメントアウト済みデバッグコード（@ts-ignore付き）を削除

### Phase 2E: Nip46.ts 分割 ✅

- 862行の単一ファイルを7つの論理モジュールに分割:
  - `nip46/types.ts` — NostrEvent, RpcRequest, RpcResponse, Filter 型定義
  - `nip46/errors.ts` — Nip46ErrorCode, Nip46Error クラス
  - `nip46/RelayPool.ts` — rx-nostr ベースのリレープール管理（230行）
  - `nip46/NostrRpc.ts` — NIP-46 RPC プロトコル実装（260行）
  - `nip46/IframeNostrRpc.ts` — iframe 経由 RPC 拡張（95行）
  - `nip46/ReadyListener.ts` — postMessage リスナー（35行）
  - `nip46/Nip46Signer.ts` — リモートサイナーファサード（170行）
  - `nip46/index.ts` — barrel re-export
- 全インポートパス更新（AuthNostrService, BannerManager, utils/index）
- 旧 `Nip46.ts` 削除

### Phase 2D: AuthNostrService リファクタリング ✅

- `utils/nostrJson.ts` — `fetchNostrJson` + キャッシュロジックを抽出
- `modules/RelayHealthManager.ts` — リレー接続監視・再接続・subscription復旧を独立クラスに抽出
  - `forceReconnect()`, `ensureRelayConnection()`, `ensureRelaysInPool()`, `ensureSubscription()` を委譲
- AuthNostrService.ts: コンテキストインターフェース (`RelayHealthContext`) 経由で依存注入
- 完全なクラス分割ではなく、実用的な責務分離（tightly coupled な状態を維持しつつロジック抽出）

### Phase 2G: イベント命名統一 ✅

- `handle*` プレフィックスを `nl*` プレフィックスに全面統一:
  - `nl-banner.tsx`: 8イベント (`handleNotifyConfirmBanner` → `nlNotifyConfirmBanner` 等)
  - `nl-change-account.tsx`: 2イベント (`handleSwitchAccount` → `nlSwitchAccount` 等)
  - `nl-confirm-logout.tsx`: 2イベント (`handleLogoutBanner` → `nlLogoutBanner` 等)
  - `nl-loading.tsx`: `stopFetchHandler` → `nlStopFetch`, `handleContinue` → `nlContinue`
  - `nl-signup.tsx`, `nl-local-signup.tsx`: `fetchHandler` → `nlFetchStatus`
- auth パッケージ側リスナー更新:
  - `BannerManager.ts`: 9箇所の `addEventListener` を新イベント名に
  - `ModalManager.ts`: 3箇所 (`handleContinue`, `stopFetchHandler`, `handleLogoutBanner`)
- `packages/components/src/index.html` (デモページ): 6箇所更新

### ビルド検証 ✅

- `npx rollup -c` で ESM (`dist/index.esm.js`) 及び IIFE (`dist/unpkg.js`) のビルド成功を確認
- 既存の警告のみ (tseep の eval 使用、ModalManager↔index の循環参照)
- 新規の警告・エラーなし

### Phase 3 対応判断

以下の Phase 3 項目は今回のスコープでは見送り:

- **CI/CD**: リポジトリ設定に依存するため、コード変更のみでは完結しない
- **ESLint**: 設定ファイル追加は可能だが、既存コードの大量修正が発生するため別PRが適切
- **SVG共通化**: UIデザイン判断が必要
- **Store構造化**: コンポーネントの内部設計変更が広範囲
- **ドキュメント**: README, JSDoc 改善は独立タスクとして推奨

### バグ修正: イベント名リネーム後のビルド不整合 ✅

**症状**: スイッチプロフィール（およびバナーからの全操作）をクリックしても何も表示されない

**根本原因**: Phase 2G でイベント名を `handle*` → `nl*` にリネームした際、auth パッケージ側のリスナーは更新したが、コンポーネントパッケージ (`packages/components`) の再ビルドを行わなかったため、`dist/` 出力が古い `handle*` イベント名のままだった。auth 側は `nlSwitchAccount` をリッスンしているのに、コンパイル済みコンポーネントは `handleSwitchAccount` を発火 → イベントがキャッチされず何も起きない。

**影響範囲**: バナーからの全操作（ログイン、ログアウト、スイッチアカウント、インポート、確認通知、キャンセルタイムアウト）

**修正**:

1. `packages/components` の Stencil ビルド (`npm run build`) を再実行 → `dist/` のイベント名が `nl*` に更新
2. `components.d.ts` が自動再生成され、古い `handle*` 型定義が除去
3. `packages/auth` の Rollup ビルドも再実行して整合性確認
4. git index から旧 `Nip46.ts` を `git rm --cached` で除去（Windows ケース非依存FSでの `Nip46.ts` vs `nip46/` 競合を解消）

**教訓**: イベント名変更はエミット側（コンポーネント）とリスナー側（auth）の両パッケージを必ず同時にビルド・テストすること。
