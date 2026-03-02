# リレー管理をrx-nostrに置き換える

## 概要

現在の `RelayPool` クラス（`Nip46.ts`）は `nostr-tools` の `Relay` を直接管理する自前実装。
これを `rx-nostr` (v3.6.2) に置き換えて、接続管理・再接続・pub/sub を委譲する。

## 現状の構成

- **`Nip46.ts`**: `RelayPool` クラスが `Relay.connect()` で個別リレー接続を管理
  - `NostrRpc`: `RelayPool.subscribe()` / `RelayPool.publish()` を使用
  - `IframeNostrRpc`: iframe経由の場合はリレー不要、それ以外は `RelayPool` 経由
  - `Nip46Signer`: `IframeNostrRpc` を内部で使用
- **`AuthNostrService.ts`**: `pool: RelayPool` と `profilePool: RelayPool` の2つを保持
  - `pool`: NIP-46 RPC通信用
  - `profilePool`: kind:0 プロフィール取得用（OUTBOX_RELAYS に接続）
- **`utils/index.ts`**: `fetchProfile()` と `createProfile()` が `RelayPool` を直接使用

## 変更計画

1. `rx-nostr` を依存関係に追加
2. `RelayPool` クラスを `rx-nostr` ベースの `RxRelayPool` に置換
3. `NostrRpc` / `IframeNostrRpc` を `RxRelayPool` 経由に変更
4. `AuthNostrService` の pool 管理を `rx-nostr` に変更
5. `utils/index.ts` の `fetchProfile` / `createProfile` を更新

## 作業ログ

### 1. rx-nostr インストール (完了)

- `rx-nostr@^3.6.2` を `packages/auth` に追加
- 依存: `rxjs` も一緒にインストールされた

### 2. Nip46.ts - RelayPool を rx-nostr ベースに置き換え (完了)

**変更前**: `nostr-tools` の `Relay` クラスを直接管理する `RelayPool` クラス

- `Relay.connect(url)` で個別接続
- `relay.subscribe()` / `relay.publish()` で個別リレー操作
- `relay.close()` で手動切断

**変更後**: `rx-nostr` の `RxNostr` をラップする `RelayPool` クラス

- `createRxNostr()` で作成、`lazy-keep` 接続戦略 + 指数バックオフ再接続
- `setDefaultRelays()` / `addDefaultRelays()` でリレー管理
- `createRxForwardReq()` でリアルタイム購読 (`subscribe()`)
- `createRxBackwardReq()` で過去イベント取得 (`subscribeOnce()`)
- `rxNostr.send()` でイベント発行 (`publish()` / `publishToRelays()`)
- `rxNostr.reconnect()` で手動再接続

**新メソッド**:

- `publishToRelays(event, relays)`: 指定リレーへの発行
- `subscribeOnce(filter, cb, relays?)`: ワンショット取得 (backward req)
- `reconnect(url)`: 個別リレーの再接続
- `dispose()`: リソース解放

**rx-nostr設定**:

```typescript
createRxNostr({
  verifier: async (event) => verifyEvent(event),
  connectionStrategy: "lazy-keep",
  retry: { strategy: "exponential", maxCount: 5, initialDelay: 1000 },
  eoseTimeout: 10000,
  okTimeout: 10000,
  skipFetchNip11: true,
});
```

### 3. utils/index.ts - fetchProfile / createProfile 更新 (完了)

- `fetchProfile()`: `relay.subscribe()` 直接呼びから `profilePool.subscribeOnce()` に変更
- `createProfile()`: `Relay.connect()`→`relay.publish()`→`relay.close()` のループから `profilePool.publishToRelays()` に変更
- `nostr-tools` の `Relay` インポートを除去

### 4. AuthNostrService.ts 更新 (完了)

- `pool.connect(10000)` 呼び出しを削除（rx-nostr が lazy-keep で自動接続）
- `profilePool.connect()` 呼び出しを削除（同上）
- `forceReconnect()`: `pool.disconnectAll()` → `pool.reconnect(url)` に変更
  - error/rejected 状態のリレーのみ手動再接続、それ以外はrx-nostrの自動リトライに任せる
- `ensureRelayConnection()`: 同様に rx-nostr の状態API を使って必要な場合のみ再接続

### 5. ビルド確認 (完了)

- `npx rollup -c` でビルド成功
- 既存の警告（eval in tseep, circular dependency）のみ、新規エラーなし
- 出力: `dist/index.esm.js` (562KB), `dist/unpkg.js` (564KB)

## rx-nostr 導入による改善点

- **自動再接続**: 指数バックオフ付きのリトライが自動で行われる
- **接続管理の一元化**: `RxNostr` が全リレーのWebSocket接続を管理、個別の `Relay` インスタンス管理が不要に
- **lazy-keep 戦略**: 使用時に自動接続、非デフォルトになったら切断
- **Observable ベース**: 購読のライフサイクル管理が `Subscription.unsubscribe()` で統一
- **重複接続の排除**: rx-nostr が同一リレーへの接続を内部で多重化

---

## 追加最適化 (Phase 2)

### 6. verifier を公式 `@rx-nostr/crypto` に置き換え (完了)

**変更前**: `nostr-tools` の `verifyEvent` を無理やりラップ

```typescript
verifier: async event => verifyEvent(event as any),
```

- `as any` キャストが必要（型不一致）
- nostr-tools の同期関数を async でラップする無駄

**変更後**: 公式パッケージ `@rx-nostr/crypto` の `verifier` を使用

```typescript
import { verifier } from '@rx-nostr/crypto';
// ...
verifier,
```

- `@rx-nostr/crypto` を依存関係に追加
- rx-nostr が推奨する @noble/@scure ベースの署名検証

### 7. `publish()` / `publishToRelays()` を `cast()` に置き換え (完了)

**変更前**: `send()` を手動 Promise ラップ + 5秒 setTimeout でベストエフォート送信

```typescript
async publish(event): Promise<void> {
  return new Promise((resolve, reject) => {
    const sub = this.rxNostr.send(event, { completeOn: 'sent' }).subscribe({
      error: ..., complete: ...
    });
    setTimeout(() => { sub.unsubscribe(); resolve(); }, 5000);
  });
}
```

**変更後**: rx-nostr 公式の `cast()` を使用（1行）

```typescript
async publish(event): Promise<void> {
  await this.rxNostr.cast(event as any);
}
async publishToRelays(event, relays): Promise<void> {
  await this.rxNostr.cast(event as any, { on: { relays } });
}
```

- `cast()` = `send()` + `completeOn: 'sent'` 相当の Promise
- 少なくとも1つのリレーに送信できたら resolve
- NIP-46 RPC の用途に最適（全リレーへの到達保証は不要）

### 8. 接続待ちをポーリングから `createConnectionStateObservable()` に変更 (完了)

**変更前**: 300ms ポーリングループで接続待機

```typescript
async connect(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (this.isAnyConnected()) return;
    await new Promise(r => setTimeout(r, 300));
  }
}
```

**変更後**: rx-nostr の Observable でリアクティブに接続完了を検知

```typescript
async connect(timeoutMs = 10000): Promise<void> {
  if (this.isAnyConnected()) return;
  return new Promise(resolve => {
    const timeout = setTimeout(() => { connSub.unsubscribe(); resolve(); }, timeoutMs);
    const connSub = this.rxNostr.createConnectionStateObservable()
      .subscribe(packet => {
        if (packet.state === 'connected') {
          clearTimeout(timeout); connSub.unsubscribe(); resolve();
        }
      });
  });
}
```

- CPU を無駄に使うポーリングが不要に
- `connected` パケットが来た瞬間に即座に resolve

### 9. RelayPool に自動再接続 Observable をセットアップ (完了)

**変更前**: AuthNostrService の `forceReconnect()` / `ensureRelayConnection()` が `pool.rxNostr.getRelayStatus()` を手動イテレートして error/rejected なリレーを再接続

**変更後**: RelayPool コンストラクタで自動再接続パイプラインを構築

```typescript
// error 状態（リトライ上限到達）のリレーを 30 秒後に自動再接続
this._connStateSub = this.rxNostr
  .createConnectionStateObservable()
  .pipe(
    filter((p) => p.state === "error"),
    delay(30000),
  )
  .subscribe((packet) => {
    this.rxNostr.reconnect(packet.from);
  });
```

- 公式ドキュメント推奨パターン（Monitoring Connections ページ）
- AuthNostrService 側の `pool.rxNostr` 直接参照を完全排除
- `dispose()` で `_connStateSub` も解除

### 10. `waitForConnection()` を RelayPool に追加 / AuthNostrService を簡素化 (完了)

**変更前**: AuthNostrService に `waitForAtLeastOneRelay()` が 300ms ポーリングループで存在

**変更後**:

- RelayPool に `waitForConnection(timeoutMs)` を追加（`createConnectionStateObservable()` ベース）
- AuthNostrService の `waitForAtLeastOneRelay()` を削除
- `forceReconnect()` / `ensureRelayConnection()` が `pool.waitForConnection(8000)` に委譲
- AuthNostrService から `pool.rxNostr` への直接参照を完全排除（カプセル化の改善）

### since フィルタについて (見送り)

Forward subscription（NIP-46 RPC レスポンス受信用）に `since` / lazy `since` を追加するか検討したが、見送り。

- RPC レスポンスハンドラは `once('response-' + id)` で登録されるため、再接続で重複受信しても無害
- `since` を追加すると、切断中に届いたレスポンスを取りこぼすリスクがある
- NIP-46 RPC では取りこぼしの方が重大な問題
