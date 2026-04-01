2026/03/30 まだ未対応

- Plan4.mdでの未修正部分についての整理、分析
- バナーの位置調整機能、バナー表示のオンオフ機能の実装についての検討
- nip46未使用時のリレー接続状態についての確認（nip07等接続不要な時にリレーに接続していないかの確認）
- Nostr Login Versin:1.7.11って書いてあるページがあるけどこれ現状のバージョンに合わせて。

  - あと、This is an open-source tool by Nostr.Band. ってかいてそれぞれへのリンクがついてるけど、このフォークの方の説明と、フォークの方のソースコードへのリンクも追加したい。
  - または、元の情報はフォークのソースコードにとんだらわかるから、元のby Nostr.Band.とかの情報書き換えるとか？？
  - どっちかいいほうに

- NIP46処理できないときに、バグってるのかリレーに接続できてないだけなのかわからない。どのリレーにも接続できていないときのエラー（リレーへの接続ができません。リレー設定を見直してくださいとかの案内）
- エラーの種類、署名機からの応答がありませんでしたとか。

- リレー接続されていないとき(自主てきにキャンセルしないかぎり)最長10秒待機しないといけないのちょっとながいから5秒にしよう。(自主てきにキャンセルできる機能に気付かない人もいるので。)
- ばつボタンでキャンセルできることをどうにかしてわかりやすくできるだろうか？

- 他気になる部分があれば

- ***

## 対応状況 (2026/04/01)

### ✅ 1. Plan4.md未修正部分の整理・分析

- Plan4.mdの内容を分析。Phase 1B(セキュリティ), 1C(アクセシビリティ), 2E(Nip46分割), 2F(定数), 2H(@ts-ignore修正) は完了済み。
- 残りの大項目: テストゼロ件、CI/CD未整備、巨大ファイル問題（AuthNostrService 925行、ModalManager 718行）は継続課題。

### ✅ 2. バナー位置調整機能・表示オンオフ機能

- **表示オンオフ（初期値）**: `noBanner` オプション（`hidden-mode` 属性）で初期化時に設定。
- **表示オンオフ（動的切替）**: `setBannerVisible(visible: boolean)` APIを新規追加。初期化後いつでもバナーの表示/非表示を切り替え可能。
  - 使い方: `import { setBannerVisible } from '@konemono/nostr-login'` → `setBannerVisible(false)` で非表示、`setBannerVisible(true)` で再表示。
  - 修正ファイル: `packages/auth/src/modules/BannerManager.ts`, `packages/auth/src/index.ts`
- **位置調整**: `bannerPosition` オプション追加（`'top'` | `'center'` | `'bottom'`）。
  - 修正ファイル: `packages/auth/src/types.ts`, `packages/auth/src/modules/BannerManager.ts`, `packages/components/src/components/nl-banner/nl-banner.tsx`
  - 使い方: `init({ bannerPosition: 'bottom' })` で下部に配置可能。

### ✅ 3. NIP46未使用時のリレー接続確認

- **NIP-07 (extension)**: `NostrExtensionService` は `window.nostr` をラップするのみ。リレー接続なし。✅問題なし
- **nsec (PrivateKeySigner)**: ローカル暗号操作のみ。リレー接続なし。✅問題なし
- **read-only**: リレー接続なし。✅問題なし
- **NIP-46のみ**: `lazy-keep` 戦略で subscribe/send 時にのみ接続。✅適切な動作

### ✅ 4. バージョン表示・リンク修正

- `nl-info.tsx` の Version を `1.7.11` → `1.15.2`（authパッケージのバージョン）に更新。
- リンクを更新: 元の Nostr.Band のクレジットを残しつつ、フォーク元（nostrband/nostr-login）とフォーク先（nicofighter45/nostr-login）の両方のリンクを表示。

### ✅ 5. NIP46エラーメッセージ改善

- `Nip46Error` クラスに `userMessage` プロパティと `toString()` オーバーライドを追加。
  - `RELAY_DISCONNECTED` → "Cannot connect to relay. Please check your relay settings."
  - `TIMEOUT` → "No response from signer. Please check your key storage app."
  - `SIGNER_REJECTED` → "The request was rejected by the signer."
  - `CANCELLED` → "The operation was cancelled."
- バナーのタイムアウト表示メッセージも改善: "Keys not responding..." → "No response from signer. Check your key storage app."

### ✅ 6. タイムアウト10秒→5秒に短縮

- `RelayPool.ts`: `eoseTimeout` 10000→5000, `okTimeout` 10000→5000, `connect()` デフォルト 10000→5000
- `RelayHealthManager.ts`: `waitForConnection()` 8000→5000（forceReconnectとensureRelayConnectionの両方）

### ✅ 7. キャンセルボタンのUX改善

- `nl-loading.tsx`: ローディング中(接続中)にスピナーの下に "Press Cancel to abort" のヒントテキストを追加。Cancelボタンは接続先URL未取得の初期ローディング状態で明確に表示される。

### 各タイマーの妥当性

| フェーズ                   | 現在値 | 評価          | コメント                                                                                                                                              |
| -------------------------- | ------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **リレー接続待ち**         | 5秒    | ✅ 妥当       | WebSocket接続は通常1-3秒。5秒あれば遅いネットワークでも十分。10秒は長すぎた                                                                           |
| **EOSE/OK待ち**            | 5秒    | ✅ 妥当       | NIP-46はリアルタイムsubscription主体なのでEOSEは初回のみ。5秒で十分                                                                                   |
| **バナー通知表示**         | 5秒    | ⚠️ やや長い？ | ユーザーは操作後3秒程度で「何も起きてない？」と不安になる。**3秒**のほうがUX的に良い可能性あり。ただし高速署名（2-3秒で完了）でチラつかない利点もある |
| **NIP-46 RPC**             | 30秒   | ✅ 妥当       | 自動承認は通常2-5秒で完了。署名機オフラインやリレー遅延の安全マージンとして30秒は適切                                                                 |
| **auth_url受信後**         | 120秒  | ✅ 妥当       | モバイルでアプリ切り替え→確認→戻る操作を考慮すると2分は必要。60秒だと足りないケースあり                                                               |
| **初回接続 listen**        | 60秒   | ✅ 妥当       | QR読み取り→署名機アプリ起動→接続完了のフローを考えると1分は適切                                                                                       |
| **connect リクエスト**     | 30秒   | ⚠️ やや長い？ | listenで既にリレー接続済みなので15-20秒でも足りそう。ただし安全マージンとしては問題なし                                                               |
| **エラーリレー自動再接続** | 30秒   | ✅ 妥当       | 短すぎるとサーバーに負荷、長すぎると復帰が遅い。30秒は良いバランス                                                                                    |
| **auth_url後バナー通知**   | 120秒  | ✅ 妥当       | auth_url受信後のRPCタイムアウトと一致。整合性あり                                                                                                     |

**総評**: 全体的にバランスが取れた設計です。致命的な問題はありません。

**唯一検討の余地があるのは `CALL_TIMEOUT`（バナー通知）**です。現在5秒ですが、これは署名開始後「タイムアウト警告」をバナーに出すまでの時間です。正常な署名が2-5秒で完了するなら、ぎりぎり表示されない or されるかのライン。**3秒に短縮**すれば、署名機が応答しない場合にユーザーへのフィードバックが早まります。

変更しますか？それとも現状の5秒で様子を見ますか？
