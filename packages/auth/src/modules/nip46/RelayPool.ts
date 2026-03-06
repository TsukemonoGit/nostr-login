// ─── RelayPool (rx-nostr ベース) ────────────────────────────────────

import { createRxNostr, createRxForwardReq, createRxBackwardReq, type RxNostr } from 'rx-nostr';
import { verifier } from '@rx-nostr/crypto';
import { Subscription, filter, delay } from 'rxjs';
import { Nip46Error } from './errors';
import type { NostrEvent, Filter } from './types';

/**
 * rx-nostr ベースのリレープール。
 * 接続管理・再接続・pub/sub をすべて rx-nostr に委譲する。
 */
export class RelayPool {
  public rxNostr: RxNostr;
  private _relayUrls: string[] = [];
  private _owned: boolean;
  private _connStateSub?: Subscription;

  /**
   * @param rxNostr 外部から渡す場合は既存インスタンスを再利用。省略時は新規作成。
   */
  constructor(rxNostr?: RxNostr) {
    if (rxNostr) {
      this.rxNostr = rxNostr;
      this._owned = false;
    } else {
      this.rxNostr = createRxNostr({
        verifier,
        connectionStrategy: 'lazy-keep',
        retry: { strategy: 'exponential', maxCount: 5, initialDelay: 1000 },
        eoseTimeout: 10000,
        okTimeout: 10000,
        skipFetchNip11: true,
      });
      this._owned = true;
    }

    // error 状態（リトライ上限到達）のリレーを 30 秒後に自動再接続
    this._connStateSub = this.rxNostr
      .createConnectionStateObservable()
      .pipe(
        filter(p => p.state === 'error'),
        delay(30000),
      )
      .subscribe(packet => {
        console.log('RelayPool: auto-reconnecting error relay:', packet.from);
        try {
          this.rxNostr.reconnect(packet.from);
        } catch (e) {
          console.warn('RelayPool: auto-reconnect failed', packet.from, e);
        }
      });
  }

  addRelay(url: string): void {
    if (this._relayUrls.includes(url)) return;
    this._relayUrls.push(url);
    this._syncRelays();
  }

  removeRelay(url: string): void {
    this._relayUrls = this._relayUrls.filter(r => r !== url);
    this._syncRelays();
  }

  removeAllRelays(): void {
    this._relayUrls = [];
    this.rxNostr.setDefaultRelays([]);
  }

  private _syncRelays(): void {
    this.rxNostr.setDefaultRelays(this._relayUrls);
  }

  /**
   * 接続をトリガーする。rx-nostr は lazy 戦略なので subscription/send 時に自動接続するが、
   * 互換のため明示的に接続状態を待機する。
   * createConnectionStateObservable() でリアクティブに接続完了を検知する。
   */
  async connect(timeoutMs = 10000): Promise<void> {
    this._syncRelays();
    if (this.isAnyConnected()) return;

    return new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        connSub.unsubscribe();
        resolve(); // タイムアウトしても例外にはしない
      }, timeoutMs);

      const connSub = this.rxNostr.createConnectionStateObservable().subscribe(packet => {
        if (packet.state === 'connected') {
          clearTimeout(timeout);
          connSub.unsubscribe();
          resolve();
        }
      });
    });
  }

  disconnectAll(): void {
    this.rxNostr.setDefaultRelays([]);
  }

  dispose(): void {
    this._connStateSub?.unsubscribe();
    if (this._owned) {
      this.rxNostr.dispose();
    }
  }

  isAnyConnected(): boolean {
    const statuses = this.rxNostr.getAllRelayStatus();
    return Object.values(statuses).some(s => s.connection === 'connected');
  }

  get relayUrls(): string[] {
    return [...this._relayUrls];
  }

  /**
   * イベントを全デフォルトリレーに発行する。
   * cast() は send() + completeOn:'sent' 相当で、少なくとも1つのリレーに送信できたら resolve する。
   * 接続済みリレーがない場合は EmptyError になるため、ベストエフォートで処理する。
   */
  async publish(event: NostrEvent): Promise<void> {
    try {
      await this.rxNostr.cast(event as any);
    } catch (e: any) {
      if (e?.name === 'EmptyError') {
        console.warn('RelayPool: publish - no connected relays, event may not have been sent');
      } else {
        throw e;
      }
    }
  }

  /**
   * 指定リレー（一時リレー）にイベントを発行する。
   * 一時リレーは送信完了後に自動切断される。
   */
  async publishToRelays(event: NostrEvent, relays: string[]): Promise<void> {
    try {
      await this.rxNostr.cast(event as any, { on: { relays } });
    } catch (e: any) {
      if (e?.name === 'EmptyError') {
        console.warn('RelayPool: publishToRelays - no connected relays, event may not have been sent');
      } else {
        throw e;
      }
    }
  }

  /**
   * forward req でリアルタイム購読する。戻り値の関数を呼ぶと解除。
   */
  subscribe(filter: Filter, onevent: (event: NostrEvent) => void): () => void {
    const req = createRxForwardReq();
    const rxSub: Subscription = this.rxNostr.use(req).subscribe({
      next: packet => {
        onevent(packet.event as unknown as NostrEvent);
      },
    });
    req.emit(filter as any);
    return () => {
      rxSub.unsubscribe();
    };
  }

  /**
   * backward (oneshot) req で過去イベントを取得する。
   */
  subscribeOnce(filter: Filter, onevent: (event: NostrEvent) => void, relays?: string[]): () => void {
    const req = createRxBackwardReq();
    const options = relays ? { on: { relays } } : undefined;
    const rxSub: Subscription = this.rxNostr.use(req, options).subscribe({
      next: packet => {
        onevent(packet.event as unknown as NostrEvent);
      },
    });
    req.emit(filter as any);
    req.over();
    return () => {
      rxSub.unsubscribe();
    };
  }

  /**
   * reconnect a specific relay
   */
  reconnect(url: string): void {
    this.rxNostr.reconnect(url);
  }

  /**
   * 少なくとも1つのリレーが接続状態になるまでリアクティブに待機する。
   * createConnectionStateObservable() を使用し、ポーリングではなくイベント駆動で待つ。
   */
  waitForConnection(timeoutMs: number): Promise<void> {
    if (this.isAnyConnected()) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        connSub.unsubscribe();
        reject(new Nip46Error('Failed to connect to any relay', 'RELAY_DISCONNECTED'));
      }, timeoutMs);

      const connSub = this.rxNostr.createConnectionStateObservable().subscribe(packet => {
        if (packet.state === 'connected') {
          clearTimeout(timeout);
          connSub.unsubscribe();
          resolve();
        }
      });
    });
  }
}

// ── 後方互換エイリアス ──
export { RelayPool as RxRelayPool };
