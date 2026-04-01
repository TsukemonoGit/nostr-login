// ─── RelayHealthManager ─────────────────────────────────────────────
// リレー接続の監視・再接続・subscription 復旧を担当する。
// AuthNostrService から委譲される。

import { RelayPool } from './nip46';
import { DEFAULT_NIP46_RELAYS } from '../const';
import type { Info } from '@konemono/nostr-login-components/dist/types/types';

interface RelayHealthContext {
  pool: RelayPool;
  /** 現在のsignerのRPC (resubscribe / isSubscriptionActive を持つ) */
  getRpc(): any | null;
  /** 保存済みユーザー情報 */
  getUserInfo(): Info | null;
}

export class RelayHealthManager {
  private ctx: RelayHealthContext;

  constructor(ctx: RelayHealthContext) {
    this.ctx = ctx;
  }

  /**
   * 強制的にリレーに再接続し、subscriptionを再開する。
   */
  async forceReconnect(): Promise<void> {
    console.log('forceReconnect: forcing relay reconnection...');

    this.ensureRelaysInPool();

    for (const url of this.ctx.pool.relayUrls) {
      try {
        this.ctx.pool.reconnect(url);
      } catch (e) {
        console.warn('forceReconnect: failed to reconnect', url, e);
      }
    }

    await this.ctx.pool.waitForConnection(5000);
    this.ensureSubscription();
  }

  /**
   * リレー接続とsubscriptionが生きていることを保証する。
   */
  async ensureRelayConnection(): Promise<void> {
    this.ensureRelaysInPool();

    const isRelayConnected = this.ctx.pool.isAnyConnected();
    const rpc = this.ctx.getRpc();
    const isSubActive = rpc ? rpc.isSubscriptionActive?.() !== false : true;

    if (!isRelayConnected) {
      console.log('ensureRelayConnection: no relay connected, triggering reconnect...');

      for (const url of this.ctx.pool.relayUrls) {
        try {
          this.ctx.pool.reconnect(url);
        } catch (e) {
          console.warn('ensureRelayConnection: reconnect failed', url, e);
        }
      }

      await this.ctx.pool.waitForConnection(5000);
      this.ensureSubscription();
    } else if (!isSubActive) {
      console.log('ensureRelayConnection: relay connected but subscription dead, resubscribing...');
      this.ensureSubscription();
    }
  }

  /**
   * リレープールが空なら保存済みリレーまたはデフォルトリレーを追加する。
   */
  ensureRelaysInPool(): void {
    if (this.ctx.pool.relayUrls.length === 0) {
      console.warn('ensureRelaysInPool: no relays in pool, adding relays');
      const userInfo = this.ctx.getUserInfo();
      const relays = userInfo?.relays?.length ? userInfo.relays : DEFAULT_NIP46_RELAYS;
      for (const r of relays) {
        this.ctx.pool.addRelay(r);
      }
    }
  }

  /**
   * subscriptionを再開する。
   */
  ensureSubscription(): void {
    const rpc = this.ctx.getRpc();
    if (rpc) {
      try {
        rpc.resubscribe?.();
        console.log('ensureSubscription: subscription re-established');
      } catch (e) {
        console.warn('ensureSubscription: failed to resubscribe', e);
      }
    }
  }
}
