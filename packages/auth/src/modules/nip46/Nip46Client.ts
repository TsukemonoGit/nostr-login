import { SimplePool, Event as NostrEvent, getPublicKey, nip04 } from 'nostr-tools';
import { Nip44 } from '../../utils/nip44';
import { EventEmitter } from 'tseep';
import { Nip46Request, Nip46Response, PendingRequest, Nip46ClientOptions } from './types';
import { getEventHash, getSignature } from 'nostr-tools';

export class Nip46Client extends EventEmitter {
  private pool: SimplePool;
  private localPrivateKey: string;
  private remotePubkey: string;
  private relays: string[];
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private defaultTimeoutMs: number;
  private useNip44: boolean;
  private subscription: any = null;
  private isSubscribed: boolean = false;
  private nip44Codec: Nip44 = new Nip44();

  constructor(options: Nip46ClientOptions) {
    super();
    this.pool = new SimplePool();
    this.localPrivateKey = options.localPrivateKey;
    this.remotePubkey = options.remotePubkey;
    this.relays = options.relays;
    this.defaultTimeoutMs = options.timeoutMs || 30000;
    this.useNip44 = options.useNip44 || false;
  }

  get localPubkey(): string {
    return getPublicKey(this.localPrivateKey);
  }

  /**
   * NIP-46リクエストを送信
   */
  async sendRequest(method: string, params: string[] = [], timeoutMs?: number): Promise<string> {
    const timeout = timeoutMs || this.defaultTimeoutMs;
    const id = this.generateId();
    const request: Nip46Request = { id, method, params };

    console.log('[Nip46Client] Sending request:', { id, method, params });

    // レスポンス購読を開始（まだの場合）
    if (!this.isSubscribed) {
      this.subscribeToResponses();
    }

    // リクエストイベントを作成・送信
    await this.publishRequest(request);

    // レスポンスを待つPromise
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        const error = new Error(`Request ${id} (${method}) timed out after ${timeout}ms`);
        console.error('[Nip46Client]', error.message);
        reject(error);
      }, timeout);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
        method,
      });
    });
  }

  /**
   * リクエストイベントを作成して送信
   */
  private async publishRequest(request: Nip46Request): Promise<void> {
    const content = JSON.stringify(request);

    // 暗号化
    const encrypted = this.useNip44
      ? await this.nip44Codec.encrypt(this.localPrivateKey, this.remotePubkey, content)
      : await nip04.encrypt(this.localPrivateKey, this.remotePubkey, content);

    // イベント作成
    const event: NostrEvent = {
      kind: 24133,
      pubkey: this.localPubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', this.remotePubkey]],
      content: encrypted,
      id: '',
      sig: '',
    };

    // ID計算
    event.id = getEventHash(event);

    // 署名
    event.sig = getSignature(event, this.localPrivateKey);

    // リレーに送信
    await Promise.any(this.pool.publish(this.relays, event));
    console.log('[Nip46Client] Request published:', request.id);
  }

  /**
   * レスポンスイベントを購読
   */
  private subscribeToResponses(): void {
    if (this.isSubscribed) return;

    const filter = {
      'kinds': [24133],
      '#p': [this.localPubkey],
      'since': Math.floor(Date.now() / 1000) - 60,
    };

    console.log('[Nip46Client] Subscribing to responses');

    // SimplePool subscription
    this.subscription = this.pool.sub(this.relays, [filter]);
    this.subscription.on('event', async (event: NostrEvent) => {
      await this.handleResponseEvent(event);
    });
    this.subscription.on('eose', () => {
      console.log('[Nip46Client] EOSE received');
    });

    this.isSubscribed = true;
  }

  /**
   * レスポンスイベントを処理
   */
  private async handleResponseEvent(event: NostrEvent): Promise<void> {
    try {
      // 復号化
      const decrypted = this.isNip04(event.content)
        ? await nip04.decrypt(this.localPrivateKey, event.pubkey, event.content)
        : await this.nip44Codec.decrypt(this.localPrivateKey, event.pubkey, event.content);

      const response: Nip46Response = JSON.parse(decrypted);

      console.log('[Nip46Client] Response received:', {
        id: response.id,
        hasResult: !!response.result,
        hasError: !!response.error,
      });

      // Emit response event for consumers (include sender pubkey)
      this.emit('response', { response, pubkey: event.pubkey });

      // auth_urlの特別処理
      if (response.result === 'auth_url') {
        console.log('[Nip46Client] Auth URL received:', response.error);
        this.emit('authUrl', response.error);
        return;
      }

      // 保留中のリクエストを解決
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.id);

        if (response.error) {
          console.error('[Nip46Client] Request failed:', {
            id: response.id,
            method: pending.method,
            error: response.error,
          });
          pending.reject(new Error(response.error));
        } else if (response.result !== undefined) {
          console.log('[Nip46Client] Request succeeded:', {
            id: response.id,
            method: pending.method,
          });
          pending.resolve(response.result);
        } else {
          pending.reject(new Error('Invalid response: no result or error'));
        }
      } else {
        console.warn('[Nip46Client] Received response for unknown request:', response.id);
      }
    } catch (error) {
      console.error('[Nip46Client] Failed to parse response event:', error);
    }
  }

  /**
   * NIP-04かNIP-44かを判定
   */
  private isNip04(ciphertext: string): boolean {
    const l = ciphertext.length;
    if (l < 28) return false;
    return ciphertext[l - 28] === '?' && ciphertext[l - 27] === 'i' && ciphertext[l - 26] === 'v' && ciphertext[l - 25] === '=';
  }

  /**
   * ランダムIDを生成
   */
  private generateId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  /**
   * NIP-44を使用するかどうかを設定
   */
  setUseNip44(useNip44: boolean): void {
    this.useNip44 = useNip44;
  }

  /**
   * クリーンアップ
   */
  cleanup(): void {
    console.log('[Nip46Client] Cleaning up');

    // すべての保留中リクエストをキャンセル
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client cleanup'));
    }
    this.pendingRequests.clear();

    // 購読を停止
    if (this.subscription) {
      // SimplePool subscriptions may use `unsub` or `close`
      try {
        if (typeof this.subscription.unsub === 'function') this.subscription.unsub();
        if (typeof this.subscription.close === 'function') this.subscription.close();
      } catch (e) {
        // ignore
      }
      this.subscription = null;
      this.isSubscribed = false;
    }

    // リレー接続を閉じる
    this.pool.close(this.relays);

    // イベントリスナーをクリア
    this.removeAllListeners();
  }

  /**
   * 接続状態を確認
   */
  isConnected(): boolean {
    return this.isSubscribed;
  }
}
