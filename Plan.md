NDKを使用している前提で修正計画を再構成します。

## NDKの接続管理特性

**NDK接続の特徴**
```
- NDKPoolが複数リレーへの接続を管理
- connect()は冪等性あり（既接続時は何もしない）
- タブ非アクティブ時のWebSocket切断はNDK内部で検知されない場合がある
```

## 問題の特定

**NDKでの接続状態不一致**
```
ndk.pool.connectedRelays() // 接続済みと判定
  ↓
実際のWebSocket状態: CLOSED
  ↓
署名リクエスト送信 → 失敗
```

## 修正計画（NDK版）

### 1. 署名時の接続確立処理

**実装例**
```javascript
async function signEvent(event) {
  // 署名前に接続を確実に確立
  await ensureNDKConnection();
  
  // NIP-46署名リクエスト
  const signedEvent = await ndk.signer.sign(event);
  return signedEvent;
}

async function ensureNDKConnection() {
  // NDKの接続を強制的に再確立
  await ndk.connect();
  
  // 接続確認（タイムアウト付き）
  await waitForConnection(ndk, 5000);
}

function waitForConnection(ndk, timeout) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    
    const check = () => {
      const relays = ndk.pool.connectedRelays();
      
      if (relays.size > 0) {
        resolve();
      } else if (Date.now() - start > timeout) {
        reject(new Error('接続タイムアウト'));
      } else {
        setTimeout(check, 100);
      }
    };
    
    check();
  });
}
```

### 2. NDKインスタンスの再接続強制

**パターンA: connect()の冪等性を利用**
```javascript
// 既接続でも問題なく実行可能
await ndk.connect();
```

**パターンB: 明示的な切断後再接続**
```javascript
// 全リレーを切断してから再接続
for (const relay of ndk.pool.relays.values()) {
  relay.disconnect();
}
await ndk.connect();
```

### 3. NIP-46 Signer固有の処理

**nostr-login + NDKの場合**
```javascript
// NIP-46 remote signerの接続確認
async function ensureNIP46Connection() {
  // NDK全体の接続
  await ndk.connect();
  
  // NIP-46用リレーの接続確認
  if (ndk.signer?.relayUrls) {
    for (const url of ndk.signer.relayUrls) {
      const relay = ndk.pool.getRelay(url);
      if (relay && relay.status !== 1) { // 1 = CONNECTED
        await relay.connect();
      }
    }
  }
}
```

### 4. ログイン時の自動接続抑制

**NDKインスタンス生成時**
```javascript
// 自動接続しない設定
const ndk = new NDK({
  explicitRelayUrls: [...],
  autoConnectUserRelays: false,
  autoFetchUserMutelist: false
});

// ログイン処理
await nostrLogin.launch();

// この時点では接続しない
// 署名時のみ接続
```

### 5. タブ可視性対応（NDK版）

```javascript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // タブアクティブ時に接続状態をリセット
    ndk.pool.relays.forEach(relay => {
      if (relay.status !== 1) {
        relay.connect();
      }
    });
  }
});
```

## 実装優先順位

1. **署名関数へのensureNDKConnection()追加**
2. **waitForConnection()実装**
3. **NDK初期化時の自動接続オプション確認・無効化**
4. **NIP-46専用リレーの接続確認処理**
5. **タブ可視性対応**（オプション）

## テスト項目

```
- タブ切り替え後の署名
- ndk.pool.connectedRelays().size === 0の状態での署名
- 連続署名時のパフォーマンス
- NIP-46リレーのみ切断状態での署名
```

## 注意点

```
- ndk.connect()は既接続時も安全に実行可能
- NIP-46 signerは専用リレーを使用する場合がある
- NDKのバージョンによって挙動が異なる可能性
```

NDKの`connect()`メソッドの冪等性を活用し、署名時に毎回接続確立を試みる方式が最も確実です。