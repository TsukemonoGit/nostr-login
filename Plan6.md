# Plan6 — NIP-46 仕様合致

## 目的

NIP-46 spec との差分を解消する。必須メソッド `ping`, `switch_relays`, `logout` の実装と、接続確立時の自動 `switch_relays` 呼び出しを行う。

## 現状の差異（Spec vs 実装）

| メソッド | Spec | 実装状況 | 備考 |
|---------|------|---------|------|
| `connect` | ✓ | ✅ `NostrRpc.connect()` | params: `[pubkey, token?, perms?]` — 合致 |
| `sign_event` | ✓ | ✅ `Nip46Signer.sign()` | params: `[json_stringified(event)]` — 合致 |
| `ping` | ✓ | ❌ 未実装 | Spec: `[] → "pong"` |
| `get_public_key` | ✓ | ✅ `Nip46Signer.initUserPubkey()` | 合致 |
| `nip04_encrypt` | ✓ | ✅ `Nip46Signer.encrypt()` | 合致 |
| `nip04_decrypt` | ✓ | ✅ `Nip46Signer.decrypt()` | 合致 |
| `nip44_encrypt` | ✓ | ✅ `AuthNostrService.encrypt44()` | `codec_call`経由で実装済み |
| `nip44_decrypt` | ✓ | ✅ `AuthNostrService.decrypt44()` | `codec_call`経由で実装済み |
| `switch_relays` | ✓ | ❌ 未実装 | **Spec: 接続確立後に即時送信必須** |
| `logout` | ✓ | ⚠️ ローカルクリーンアップのみ | NIP-46 RPC `logout` 呼び出しなし |
| `create_account` | 別NIPへ移動 | ⚠️ 未だ残っている | 非推奨化が必要 |

## 変更ファイル

1. `packages/auth/src/modules/nip46/Nip46Signer.ts` — `ping()`, `switchRelays()`, `logout()`, `nip44Encrypt()`, `nip44Decrypt()` メソッド追加 / `createAccount2()` 非推奨化
2. `packages/auth/src/modules/AuthNostrService.ts` — 接続確立後の `switch_relays` 自動呼び出し組み込み、`logout()` で NIP-46 RPC 呼び出し追加
3. `packages/auth/src/const/index.ts` — （必要に応じて `ping` タイムアウト定数追加）

## 実装内容

### 1. `ping()` メソッド追加

Nip46Signer に追加。signer の死活確認用。

```ts
/** NIP-46 ping — signer の死活確認 */
public async ping(): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    this.rpc.sendRequest(this.bunkerPubkey, 'ping', [], 24133, (response: RpcResponse) => {
      if (response.error) {
        reject(new Nip46Error(response.error, 'TIMEOUT'));
      } else {
        resolve(response.result === 'pong');
      }
    });
  });
}
```

### 2. `switchRelays()` メソッド追加

Spec: 接続確立後に client が即時送信、signer が relay リストを返す。
Spec の result フィールドは `string` または `json_stringified` オブジェクトとなりうる（`Nip46Signer.sign()` と同じパターンで `try-catch` 処理する）。

```ts
/** NIP-46 switch_relays — リレーリストの更新 */
public async switchRelays(): Promise<string[] | null> {
  return new Promise<string[] | null>((resolve, reject) => {
    this.rpc.sendRequest(this.bunkerPubkey, 'switch_relays', [], 24133, (response: RpcResponse) => {
      if (response.error) {
        reject(new Nip46Error(response.error, 'TIMEOUT'));
      } else {
        // result は JSON 文字列: ["wss://...", ...] または "null"
        try {
          const parsed = JSON.parse(response.result);
          resolve(Array.isArray(parsed) ? parsed : null);
        } catch {
          resolve(null);
        }
      }
    });
  });
}
```

### 3. `logout()` RPC メソッド追加

```ts
/** NIP-46 logout — リモート signer にセッション終了を通知 */
public async logout(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    this.rpc.sendRequest(this.bunkerPubkey, 'logout', [], 24133, (response: RpcResponse) => {
      if (response.error) {
        reject(new Nip46Error(response.error, 'TIMEOUT'));
      } else {
        resolve();
      }
    });
  });
}
```

### 4. `nip44Encrypt()` / `nip44Decrypt()` を Nip46Signer に移動

現在 `AuthNostrService.codec_call()` 経由で実装されているが、Nip46Signer に統一して追加する。

`codec_call()` の実態（`AuthNostrService.ts:836-850`）:
```ts
private async codec_call(method: string, pubkey: string, param: string) {
  return new Promise<string>((resolve, reject) => {
    this.signer!.rpc.sendRequest(this.signer!.bunkerPubkey!, method, [pubkey, param], 24133, (response: RpcResponse) => {
      if (!response.error) {
        resolve(response.result);
      } else {
        if (response.error.includes('timeout') || response.error === 'Request timeout') {
          reject(new Nip46Error(response.error, 'TIMEOUT'));
        } else {
          reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
        }
      }
    });
  });
}
```

現行の `encrypt44()` / `decrypt44()` はこの `codec_call()` 経由で呼び出しているため、`Nip46Signer` にメソッドを追加後、`AuthNostrService` 側で `signer.nip44Encrypt/Decrypt` を呼び出すように変更する。

```ts
/** NIP-46 remote encrypt (NIP-44) */
public async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    this.rpc.sendRequest(this.bunkerPubkey, 'nip44_encrypt', [recipientPubkey, plaintext], 24133, (response: RpcResponse) => {
      if (response.error) {
        reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
      } else {
        resolve(response.result);
      }
    });
  });
}

/** NIP-46 remote decrypt (NIP-44) */
public async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    this.rpc.sendRequest(this.bunkerPubkey, 'nip44_decrypt', [senderPubkey, ciphertext], 24133, (response: RpcResponse) => {
      if (response.error) {
        reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
      } else {
        resolve(response.result);
      }
    });
  });
}
```

### 5. 接続確立時に `switch_relays` を自動呼び出し（Spec 必須）

`AuthNostrService.initSigner()` で `listen()` / `connect()` / `initUserPubkey()` 完了後、`info.pubkey` 代入直前に `switchRelays()` を呼び出す。
返ってきた relay リストがあれば `RelayPool` を更新し、`Resubscribe()` する。

```ts
// AuthNostrService.initSigner() 内、listen/connect/initUserPubkey 完了後、info.pubkey 代入直前
const newRelays = await this.signer!.switchRelays();
if (newRelays && newRelays.length > 0) {
  // relay pool を更新
  this.pool.removeAllRelays();
  for (const r of newRelays) {
    this.pool.addRelay(r);
  }
  // subscription を再登録
  this.signer!.rpc.resubscribe();
}
```

### 6. `logout()` で NIP-46 RPC 呼び出しを追加

`AuthNostrService.logout()` でローカルクリーンアップ前に NIP-46 RPC `logout` を呼び出す。

```ts
public async logout(keepSigner = false) {
  // NIP-46 logout を送信（signer が session を削除）
  if (this.signer && !keepSigner) {
    try {
      await this.signer.logout();
    } catch (e) {
      console.warn('NIP-46 logout RPC failed (non-fatal):', e);
    }
  }

  if (!keepSigner) this.releaseSigner();
  localStorageRemoveCurrentAccount();
  this.onAuth('logout');
  this.emit('updateAccounts');
}
```

### 7. `createAccount2()` を非推奨化

```ts
/**
 * @deprecated NIP-46 spec から create_account は別 NIP へ移動済み。
 * 将来的に削除されます。
 */
public async createAccount2(...): Promise<any> {
  console.warn('[DEPRECATED] createAccount2 is deprecated per NIP-46 spec. Will be removed in a future version.');
  // ... 既存の処理をそのまま
}
```

## 影響範囲

| ファイル | 変更内容 | 規模 |
|---------|---------|------|
| `Nip46Signer.ts` | 5 メソッド追加 / 1 メソッド非推奨化 | 中規模 (+80行) |
| `AuthNostrService.ts` | `switch_relays` 自動呼び出し / `logout` RPC 追加 | 小規模 (+25行) |
| `AuthNostrService.ts` | `nip44Encrypt` / `nip44Decrypt` を `signer.nip44Encrypt` へ移行 | 小規模 |

## 注意点

- `ping` / `switch_relays` / `logout` は非同期で `Nip46Error` を投げる可能性がある
- `switch_relays` 後の relay 変更は既存のサブスクリプションに影響するため、`resubscribe()` を呼び出す
- `logout` RPC の失敗はローカルクリーンアップを妨げてはならない（`catch` で警告のみ出力）
- `createAccount2` の既存呼び出し箇所（`createAccount` メソッド内）は動作するまま
- `nip44` メソッドは `AuthNostrService` から `Nip46Signer` へ統一（`codec_call` を置き換え）

## テスト（手動確認）

- `ping` — signer 応答で `pong` が返るか確認
- `switch_relays` — signer から relay リストが返り、pool に反映されるか確認
- `logout` — NIP-46 RPC `logout` が送信され、ローカルセッションが削除されるか確認
- `nip44` 暗号化復号 — `Nip46Signer` 経由で正しく動作するか確認
- `create_account` — 警告ログが出ることを確認
- 接続フロー — 接続確立後、自動的に `switch_relays` が呼ばれることを確認

## 実行コマンド

```bash
# 1. 実装
# 2. フォーマット
npm run format --workspace=@konemono/nostr-login
# 3. ビルド
npm run build --workspace=@konemono/nostr-login
```
