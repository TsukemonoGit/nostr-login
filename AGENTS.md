# AGENTS.md

## リポジトリ概要

`nostr-login` は `window.nostr` プロバイダーのフォーク。NIP-46 (Nostr Connect)、ブラウザ拡張、読み取り専用ログイン、nsec 入力ログインなどを提供する。

- **元リポジトリ**: [nostrband/nostr-login](https://github.com/nostrband/nostr-login)
- **パッケージ**: `@konemono/nostr-login` (auth core), `@konemono/nostr-login-components` (UI components)

## 構造

```
packages/
  auth/            # @konemono/nostr-login — 認証ロジック本体
    src/
      index.ts              # NostrLoginInitializer — 全モジュールの統合
      iife-module.ts        # unpkg 用 IIFE bundle エントリ
      const/index.ts        # タイムアウト定数他、全フェーズの定数一元管理
      modules/
        nip46/              # rx-nostr ベース NIP-46 実装 (RelayPool, NostrRpc, Nip46Signer等)
      ...
    rollup.config.js        # ESM + IIFE 2バウンドル
    tsconfig.json           # strict: true, target: esnext
  components/              # @konemono/nostr-login-components — Stencil Web Components
    src/components/         # nl-xxx コンポーネント群
    stencil.config.ts       # Tailwind + sass プラグイン
```

## 開発コマンド

| 操作 | コマンド |
|------|---------|
| 全体ビルド | `npm run build` (→ lerna run build) |
| auth ビルド | `npm run build --workspace=@konemono/nostr-login` (rollup -c) |
| components ビルド | `npm run build --workspace=@konemono/nostr-login-components` (stencil build) |
| components 開発 | `npm run dev --workspace=@konemono/nostr-login-components` (watch モード) |
| フォーマット | 各パッケージ内で `npm run format` (prettier) |
| components テスト | `npm run test --workspace=@konemono/nostr-login-components` (stencil test) |

> **注意**: テストファイルは存在しない (components の `stencil test` は skeleton のみ)。

## 重要なお知らせ

- **テストなし**: このリポジトリにはテストコードがない。`npm run test` は skeleton のみ実行。
- **CI なし**: `.github/` 配下に CI ワークフローなし。
- **lint コマンドなし**: TypeScript の型チェックは rollup-plugin-typescript2 / stencil build に委ねている。独立した lint コマンドは定義されていない。
- **フォーマットはパッケージ単位**: ルートに `.prettierrc` はなし。各パッケージごとに同一設定で個別に実行する。
- **build 出力は gitignore**: `packages/auth/dist/`, `packages/components/dist/`, `www/`, `loader/` は除外。
- **Next.js SSR 対策**: `document` にアクセスするため、`useEffect` 内での dynamic import が必要 (`README.md` 参照)。

## rx-nostr 実装に関する注意

`packages/auth/src/modules/nip46/` 配下の NIP-46 実装は **rx-nostr v3** を使用している。
このリポジトリで rx-nostr 関連の実装を行う場合は、事前に rx-nostr スキルをロードすること:

```
(skill rx-nostr)
```

## NIP-46 仕様の管理

- **local spec file**: `NIP-46.md`（冒頭に公式 spec の commit ハッシュ・取得日を記録）
- **公式 spec**: [nostr-protocol/nips#46.md](https://github.com/nostr-protocol/nips/blob/master/46.md)
- **実装合致確認**: `diff NIP-46.md <(curl -s https://raw.githubusercontent.com/nostr-protocol/nips/master/46.md)` で差分確認
- **現在の合致状況**: 2026-06-21 時点で公式 spec と機能的に一致（差分は見出し形式のみ）

### NIP-46 の実装履歴

| 日付 | コミット | 内容 |
|------|---------|------|
| 2026-01-06 | e90dadb | NDK 削除 → nostr-tools 実装 |
| 2026-03-06 | f987447 (v1.15.0) | rx-nostr ベース nip46/ ディレクトリ新規作成（現在のコードベース） |
| 2026-04-01 | 5ac39ed | Plan5 対応（rx-nostr 安定化） |

### 非推奨ファイル

- `nip46-signing-analysis.md` — NDK 時代（e90dadb 以前）の分析。現在の rx-nostr 実装には非適用。
- `Plan.md` — NDK 時代の設計案。現在の実装（rx-nostr）には非適用。

## 定数の場所

タイムアウト値等の定数は `packages/auth/src/const/index.ts` で一元管理。
変更時はまずここを確認。

## 変更時のチェックリスト

1. フォーマット: 変更対象パッケージ内で `npm run format` を実行
2. ビルド: 該当パッケージの build を再実行し、ビルドエラーがないか確認
3. 影響範囲: `packages/auth/src/index.ts` (NostrLoginInitializer) は全モジュールの結合点 — 変更時は注意
