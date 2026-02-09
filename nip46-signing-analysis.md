# NIP-46 署名フロー分析と改善提案

## 1. 現状の署名フロー概要

### 署名リクエストの全体フロー

```
window.nostr.signEvent(event)
  → Nostr.signEvent()
    → ensureAuth()              // 認証状態の確認
    → processManager.wait()     // タイムアウト管理付きで実行
      → AuthNostrService.signEvent()
        → ensureRelayConnection()   // リレー接続確認
        → signer.sign(event)        // NIP-46 RPC で署名要求を送信
          → rpc.sendRequest("sign_event", ...)
            → event.publish()       // リレーに kind:24133 イベントを publish
            → レスポンス待ち (setResponseHandler)
```

---

## 2. リレー接続状態の確認

### 現状の実装 (`AuthNostrService.ensureRelayConnection`)

```typescript
private async ensureRelayConnection() {
  const connected = Array.from(this.ndk.pool.relays.values())
    .some(relay => relay.status === 1); // 1 = CONNECTED

  if (!connected) {
    console.log('Relay disconnected, reconnecting...');
    await this.ndk.connect();
  }
}
```

### 問題点

| #       | 問題                                        | 詳細                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **2-1** | **接続確認のタイミングが `signEvent` のみ** | `ensureRelayConnection()` は `signEvent`, `encrypt04`, `decrypt04`, `encrypt44`, `decrypt44` の各メソッド冒頭で呼ばれているが、**RPC subscription（kind:24133 の受信側）が生きているかの確認がない**。リレーに再接続しても、subscription が再開されなければレスポンスを受信できない。 |
| **2-2** | **`ndk.connect()` の成功確認がない**        | `await this.ndk.connect()` は接続を**開始**するだけで、WebSocket が OPEN になったことを保証しない。再接続直後に `sendRequest` しても publish に失敗する可能性がある。                                                                                                                 |
| **2-3** | **接続状態のステータス値がハードコード**    | `relay.status === 1` としているが、NDK のステータス定数を使っていないため、NDK のバージョンアップで壊れるリスクがある。                                                                                                                                                               |
| **2-4** | **リレーが 0 個のケースが考慮されていない** | `releaseSigner()` で `ndk.pool.removeRelay()` により全リレーが除去されるが、次の `signEvent` 呼び出し時に `pool.relays` が空の場合、`some()` は `false` を返して `ndk.connect()` が呼ばれるものの、explicit relay が追加されていないので再接続先がない。                              |

### 改善提案

1. **再接続後に subscription を再開する仕組みを追加**

   - `ensureRelayConnection()` でリレー再接続した場合、`NostrRpc.subscribe()` を再実行して kind:24133 の subscription を張り直す
   - `Nip46Signer` に `resubscribe()` メソッドを追加

2. **接続待ちを明示的に行う**

   ```typescript
   private async ensureRelayConnection() {
     const connected = Array.from(this.ndk.pool.relays.values())
       .some(relay => relay.status === WebSocket.OPEN);

     if (!connected) {
       await this.ndk.connect();
       // 少なくとも1つのリレーがOPENになるまで待つ
       await this.waitForAtLeastOneRelay(5000);
     }
   }
   ```

3. **リレーが空の場合のフォールバック**
   - `ensureRelayConnection()` で `pool.relays.size === 0` の場合、保存済みの `info.relays` または `DEFAULT_NIP46_RELAYS` を再追加する

---

## 3. 署名待機

### 現状の実装

署名待機は以下の2層で管理されている：

#### 層1: ProcessManager（UIタイムアウト）

- `CALL_TIMEOUT = 5000ms`（5秒）でタイムアウト
- タイムアウト後に `onCallTimeout` イベントを発火 → バナーに "timeout" 通知を表示
- **署名自体はキャンセルされない**（UI表示のみ）

#### 層2: NDK RPC レスポンス待ち（setResponseHandler）

- `sendRequest()` → `setResponseHandler()` でレスポンスを待機
- **タイムアウトが設定されていない** (無期限に待ち続ける)
- `auth_url` レスポンスが来た場合は待機を延長

### 問題点

| #       | 問題                                      | 詳細                                                                                                                                                           |
| ------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3-1** | **署名リクエストにタイムアウトがない**    | `setResponseHandler` はレスポンスが来るまで**永久に待つ**。リレーが切断されたり signer がオフラインの場合、Promise が resolve も reject もされずにリークする。 |
| **3-2** | **`CALL_TIMEOUT` が短すぎる**             | 5秒のタイムアウトは UI 通知用だが、nsec.app などでユーザー確認が必要な署名では、ユーザーが確認する前にタイムアウト通知が出てしまう。                           |
| **3-3** | **`requests` Set のクリーンアップがない** | `NostrRpc.requests` に追加された ID は、正常レスポンス時にのみ `delete` される。タイムアウトやエラー時に残り続け、メモリリークになる。                         |
| **3-4** | **auth_url 後の待機状態が不透明**         | `auth_url` レスポンスが来た後、実際の署名レスポンスを待ち続けるが、ユーザーにはどの状態なのか分かりにくい。                                                    |

### 改善提案

1. **署名リクエストにタイムアウトを追加**

   ```typescript
   // setResponseHandler にタイムアウトを追加
   protected setResponseHandler(id: string, cb?, timeout = NIP46_REQUEST_TIMEOUT) {
     const timer = setTimeout(() => {
       this.requests.delete(id);
       cb?.({ id, result: '', error: 'Request timeout' });
     }, timeout);

     // レスポンス時にタイマーをクリア
   }
   ```

2. **`CALL_TIMEOUT` を auth_url の有無で動的に変更**

   - auth_url が発生した場合は UI タイムアウトを延長（例: 120秒）

3. **`requests` の定期クリーンアップ**
   - 古い（例: 5分以上前の）リクエストを自動削除

---

## 4. 署名失敗後の動作

### 現状の実装

署名失敗は主に以下の経路で処理される：

```
ProcessManager.wait()
  → cb() が throw → error をキャッチ
  → callCount-- / callTimer クリア
  → 'onCallEnd' 発火
  → error を再 throw

Nostr.signEvent()
  → processManager.wait() が throw
  → 呼び出し元に error を伝搬
```

### 問題点

| #       | 問題                                       | 詳細                                                                                                                                                                                         |
| ------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **4-1** | **エラー種別の区別がない**                 | ネットワークエラー、タイムアウト、signer拒否、ユーザーキャンセルのすべてが同じ `Error` として伝搬される。呼び出し元がリトライすべきか判断できない。                                          |
| **4-2** | **署名失敗後に signer 状態が汚れる可能性** | `signer.sign()` の失敗後、NDK 内部の RPC イベントハンドラは解除されないため、遅延レスポンスが来た際に予期しない動作をする可能性がある。                                                      |
| **4-3** | **`cancelAllPendingCalls` の副作用**       | バナーの "Cancel" ボタンで `cancelAllPendingCalls` が呼ばれるが、これは `pendingCalls` の全 Promise を reject するのみ。RPC 側の `requests` Set や event listener はクリーンアップされない。 |
| **4-4** | **エラー後のUIリセットが不完全**           | `ModalManager` では `isLoading`, `authUrl`, `iframeUrl` がリセットされるが、`BannerManager` では `onCallEnd` のみで notify モードの確実なリセットが保証されない。                            |

### 改善提案

1. **エラー種別を定義する**

   ```typescript
   class Nip46Error extends Error {
     constructor(
       message: string,
       public code:
         | "TIMEOUT"
         | "RELAY_DISCONNECTED"
         | "SIGNER_REJECTED"
         | "CANCELLED"
         | "UNKNOWN",
     ) {
       super(message);
     }
     get retryable() {
       return this.code === "TIMEOUT" || this.code === "RELAY_DISCONNECTED";
     }
   }
   ```

2. **キャンセル時に RPC 側もクリーンアップ**

   ```typescript
   public cancelAllPendingCalls() {
     // 既存の処理に加えて
     if (this.signer?.rpc) {
       (this.signer.rpc as NostrRpc).clearPendingRequests();
     }
   }
   ```

3. **エラー後の遅延レスポンスを無視する仕組み**
   - リクエスト ID を `requests` Set から削除することで、遅延レスポンスが来ても `setResponseHandler` のコールバックが呼ばれないようにする（現状は一部実装済みだが不完全）

---

## 5. 再署名時のリレー確認

### 現状の実装

再署名（失敗後のリトライやユーザーの次の操作）時：

1. `window.nostr.signEvent()` が再度呼ばれる
2. `ensureAuth()` → `ensureRelayConnection()` → `signEvent()`
3. `ensureRelayConnection()` でリレー接続を確認・再接続

### 問題点

| #       | 問題                                                 | 詳細                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5-1** | **再接続後に RPC subscription が復活しない**         | `ensureRelayConnection()` はリレーの WebSocket を再接続するが、**kind:24133 の subscription は再開しない**。そのため再署名リクエストを publish しても、signer からのレスポンスを受信できない。**これが最大の問題。** |
| **5-2** | **前回失敗したリクエストのリスナーが残る**           | `setResponseHandler` で設定された `once` リスナーが解除されないまま残り、次のリクエストと競合する可能性がある。                                                                                                      |
| **5-3** | **リレー再接続と署名送信の間にレースコンディション** | `ndk.connect()` → `sendRequest()` の間にリレーがまだ OPEN でない場合、publish が失敗する（ただしエラーにならずに drop される）。                                                                                     |
| **5-4** | **再署名のリトライロジックがない**                   | アプリ側（`window.nostr` の呼び出し元）にリトライの判断を任せており、nostr-login 側では一切リトライしない。一時的なネットワーク断のケースでは自動リトライが有効。                                                    |

### 改善提案

1. **`ensureRelayConnection` で subscription を再開**

   ```typescript
   private async ensureRelayConnection() {
     const connected = Array.from(this.ndk.pool.relays.values())
       .some(relay => relay.status === 1);

     if (!connected) {
       console.log('Relay disconnected, reconnecting...');
       await this.ndk.connect();

       // subscription を再開
       if (this.signer) {
         await (this.signer.rpc as NostrRpc).resubscribe();
       }
     }
   }
   ```

2. **自動リトライの導入**

   ```typescript
   public async signEvent(event: any) {
     const maxRetries = 2;
     for (let i = 0; i <= maxRetries; i++) {
       try {
         await this.ensureRelayConnection();
         return await this.signer?.sign(event);
       } catch (e) {
         if (i === maxRetries || !isRetryableError(e)) throw e;
         console.warn(`Sign attempt ${i + 1} failed, retrying...`);
         await this.forceReconnect();
       }
     }
   }
   ```

3. **リレー接続状態の監視**
   - NDK の relay イベント (`connect`, `disconnect`) を listen して、切断を検知したら proactive に再接続する
   - `ndk.pool.on('relay:disconnect', ...)` で検知

---

## 6. 優先度別まとめ

### 🔴 高優先度（署名が実際に失敗する問題）

| #   | 問題                                 | 対応                                               |
| --- | ------------------------------------ | -------------------------------------------------- |
| 5-1 | 再接続後に subscription が復活しない | `ensureRelayConnection` に subscription 再開を追加 |
| 3-1 | 署名リクエストにタイムアウトがない   | `setResponseHandler` にタイムアウトを追加          |
| 2-2 | `ndk.connect()` の成功確認がない     | 接続完了を待つ処理を追加                           |

### 🟡 中優先度（信頼性・UX に影響）

| #   | 問題                                  | 対応                                    |
| --- | ------------------------------------- | --------------------------------------- |
| 2-4 | リレーが 0 個のケースが未考慮         | デフォルトリレーへのフォールバック      |
| 4-1 | エラー種別の区別がない                | `Nip46Error` クラスの導入               |
| 4-3 | キャンセル時の RPC クリーンアップ不足 | `clearPendingRequests()` メソッドの追加 |
| 5-4 | リトライロジックがない                | 自動リトライ（最大2回）の導入           |

### 🟢 低優先度（改善レベル）

| #   | 問題                          | 対応                                                 |
| --- | ----------------------------- | ---------------------------------------------------- |
| 2-3 | ステータス値のハードコード    | NDK の定数を使用                                     |
| 3-2 | `CALL_TIMEOUT` が短い         | auth_url 発生時に動的延長                            |
| 3-3 | `requests` Set のメモリリーク | 定期クリーンアップ                                   |
| 4-4 | エラー後のUIリセット不完全    | UIリセットの統一                                     |
| 5-3 | レースコンディション          | 接続確認後に遅延を入れるか、publish の成功確認を追加 |
