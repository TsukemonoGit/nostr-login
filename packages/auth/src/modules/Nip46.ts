// packages/auth/src/modules/Nip46.ts
// rx-nostr ベースの NIP-46 RPC 実装

import { validateEvent, verifyEvent, finalizeEvent } from 'nostr-tools';
import { createRxNostr, createRxForwardReq, createRxBackwardReq, type RxNostr } from 'rx-nostr';
import { verifier } from '@rx-nostr/crypto';
import { Subscription, filter, delay } from 'rxjs';
import { EventEmitter } from 'tseep';
import { PrivateKeySigner } from './Signer';
import { NIP46_REQUEST_TIMEOUT } from '../const';

// ─── Types ──────────────────────────────────────────────────────────

export interface NostrEvent {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
  pubkey: string;
  id?: string;
  sig?: string;
}

export interface RpcRequest {
  id: string;
  pubkey: string;
  method: string;
  params: string[];
  event: NostrEvent;
}

export interface RpcResponse {
  id: string;
  result: string;
  error: string;
  event: NostrEvent;
}

export type Filter = {
  'kinds'?: number[];
  '#p'?: string[];
  'since'?: number;
  'until'?: number;
  'limit'?: number;
  'authors'?: string[];
  'ids'?: string[];
};

// ─── Errors ─────────────────────────────────────────────────────────

export type Nip46ErrorCode = 'TIMEOUT' | 'RELAY_DISCONNECTED' | 'SIGNER_REJECTED' | 'CANCELLED' | 'UNKNOWN';

export class Nip46Error extends Error {
  public code: Nip46ErrorCode;
  constructor(message: string, code: Nip46ErrorCode) {
    super(message);
    this.name = 'Nip46Error';
    this.code = code;
  }
  get retryable() {
    return this.code === 'TIMEOUT' || this.code === 'RELAY_DISCONNECTED';
  }
}

// ─── RelayPool (rx-nostr ベース) ────────────────────────────────────

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

// ─── NostrRpc ───────────────────────────────────────────────────────

class NostrRpc extends EventEmitter {
  public pool: RelayPool;
  protected _signer: PrivateKeySigner;
  protected requests: Set<string> = new Set();
  private unsub?: () => void;
  private lastSubscribeFilter?: Filter;
  private requestTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  protected _useNip44: boolean = false;

  public constructor(pool: RelayPool, signer: PrivateKeySigner) {
    super();
    this.pool = pool;
    this._signer = signer;
  }

  public subscribe(filter: Filter): void {
    filter.kinds = filter.kinds?.filter(k => k === 24133);
    this.lastSubscribeFilter = { ...filter };

    this.unsub = this.pool.subscribe(filter, async (event: NostrEvent) => {
      try {
        const parsedEvent = await this.parseEvent(event);
        if ((parsedEvent as RpcRequest).method) {
          this.emit('request', parsedEvent);
        } else {
          this.emit('response-' + parsedEvent.id, parsedEvent);
        }
      } catch (e) {
        console.error('error parsing event in subscription', e);
      }
    });
  }

  public ensureSubscription(): void {
    if (this.unsub) return;
    const pubkey = this._signer.pubkey;
    console.log('ensureSubscription: subscribing for', pubkey);
    this.subscribe({
      'kinds': [24133],
      '#p': [pubkey],
    });
  }

  public stop() {
    if (this.unsub) {
      this.unsub();
      this.unsub = undefined;
    }
  }

  public resubscribe(): void {
    if (!this.lastSubscribeFilter) {
      console.warn('resubscribe: no previous filter to resubscribe with');
      return;
    }
    console.log('resubscribe: re-subscribing with filter', this.lastSubscribeFilter);
    this.stop();
    this.subscribe(this.lastSubscribeFilter);
  }

  public isSubscriptionActive(): boolean {
    if (!this.lastSubscribeFilter) return true;
    return !!this.unsub;
  }

  public clearPendingRequests() {
    for (const [id, timer] of this.requestTimers.entries()) {
      clearTimeout(timer);
      this.requestTimers.delete(id);
    }
    this.requests.clear();
    console.log('clearPendingRequests: all pending requests cleared');
  }

  public setUseNip44(useNip44: boolean) {
    this._useNip44 = useNip44;
  }

  private isNip04(ciphertext: string) {
    const l = ciphertext.length;
    if (l < 28) return false;
    return ciphertext[l - 28] === '?' && ciphertext[l - 27] === 'i' && ciphertext[l - 26] === 'v' && ciphertext[l - 25] === '=';
  }

  public async parseEvent(event: NostrEvent): Promise<RpcRequest | RpcResponse> {
    const senderPubkey = event.pubkey;
    const decrypt = this.isNip04(event.content) ? this._signer.decrypt : this._signer.decryptNip44;
    const decryptedContent = await decrypt.call(this._signer, { pubkey: senderPubkey }, event.content);
    const parsedContent = JSON.parse(decryptedContent);
    const { id, method, params, result, error } = parsedContent;

    if (method) {
      return { id, pubkey: event.pubkey, method, params, event };
    } else {
      return { id, result, error, event };
    }
  }

  public async parseNostrConnectReply(reply: any, secret: string) {
    const event = reply as NostrEvent;
    const parsedEvent = await this.parseEvent(event);
    console.log('nostr connect parsedEvent', parsedEvent);
    if (!(parsedEvent as RpcRequest).method) {
      const response = parsedEvent as RpcResponse;
      if (response.result !== secret) throw new Error(response.error || 'Invalid secret in reply');
      return event.pubkey;
    } else {
      throw new Error('Bad nostr connect reply');
    }
  }

  public async listen(nostrConnectSecret: string): Promise<string> {
    const pubkey = this._signer.pubkey;
    console.log('nostr-login listening for conn to', pubkey, 'expecting secret:', nostrConnectSecret);

    return new Promise<string>((ok, err) => {
      const timeout = setTimeout(() => {
        err(new Error('Connection timeout: no response from signer'));
      }, 60000);

      const listenFilter: Filter = {
        'kinds': [24133],
        '#p': [pubkey],
      };

      this.stop();
      this.lastSubscribeFilter = listenFilter;

      this.unsub = this.pool.subscribe(listenFilter, async (event: NostrEvent) => {
        try {
          const parsedEvent = await this.parseEvent(event);

          if ((parsedEvent as RpcRequest).method) {
            this.emit('request', parsedEvent);
          } else {
            this.emit('response-' + parsedEvent.id, parsedEvent);
          }

          if (!(parsedEvent as RpcRequest).method) {
            const response = parsedEvent as RpcResponse;

            if (response.result === 'auth_url') {
              console.log('Ignoring auth_url response in listen');
              return;
            }

            if (response.result === nostrConnectSecret) {
              clearTimeout(timeout);
              console.log('Connection established with signer:', event.pubkey);
              ok(event.pubkey);
            } else if (response.result === 'ack') {
              console.warn('Received "ack" instead of secret.');
              clearTimeout(timeout);
              ok(event.pubkey);
            } else {
              console.error('Invalid response:', response);
              clearTimeout(timeout);
              err(new Error(response.error || 'Invalid connection response'));
            }
          }
        } catch (e) {
          console.error('Error parsing event in listen', e);
        }
      });
    });
  }

  public async connect(pubkey: string, token?: string, perms?: string) {
    console.log('Sending connect request to', pubkey, 'with perms:', perms);

    this.ensureSubscription();

    return new Promise<void>((ok, err) => {
      const timeout = setTimeout(() => {
        err(new Error('Connect timeout: no response from signer'));
      }, 30000);

      // NIP-46仕様: connect params = [<remote_user_pubkey>, <optional_secret>, <optional_permissions>]
      const connectParams = [pubkey!, token || '', perms || ''];
      this.sendRequest(pubkey!, 'connect', connectParams, 24133, (response: RpcResponse) => {
        clearTimeout(timeout);

        if (response.result === 'ack') {
          console.log('Connect acknowledged by signer');
          ok();
        } else {
          console.error('Connect failed:', response.error);
          err(new Error(response.error || 'Connection rejected by signer'));
        }
      });
    });
  }

  protected getId(): string {
    return Math.random().toString(36).substring(7);
  }

  public async sendRequest(remotePubkey: string, method: string, params: string[] = [], kind = 24133, cb?: (res: RpcResponse) => void): Promise<RpcResponse> {
    const id = this.getId();

    this.setResponseHandler(id, cb);

    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);
    console.log('sendRequest', { event, method, remotePubkey, params });

    await this.pool.publish(event);

    // @ts-ignore
    return undefined as RpcResponse;
  }

  protected setResponseHandler(id: string, cb?: (res: RpcResponse) => void) {
    let authUrlSent = false;
    let authUrlReceived = false;
    const now = Date.now();

    const cleanup = () => {
      const timer = this.requestTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.requestTimers.delete(id);
      }
      this.requests.delete(id);
    };

    const getTimeout = () => (authUrlReceived ? NIP46_REQUEST_TIMEOUT * 4 : NIP46_REQUEST_TIMEOUT);

    const startTimer = () => {
      const existing = this.requestTimers.get(id);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        console.warn('nip46 request ' + id + ' timed out after ' + (Date.now() - now) + 'ms (authUrl=' + authUrlReceived + ')');
        cleanup();
        if (cb) {
          cb({ id, result: '', error: 'Request timeout', event: undefined as any });
        }
      }, getTimeout());
      this.requestTimers.set(id, timer);
    };

    startTimer();

    return new Promise<RpcResponse>(() => {
      const responseHandler = (response: RpcResponse) => {
        if (response.result === 'auth_url') {
          this.once('response-' + id, responseHandler);
          if (!authUrlSent) {
            authUrlSent = true;
            authUrlReceived = true;
            this.emit('authUrl', response.error);
            startTimer();
          }
        } else if (cb) {
          if (this.requests.has(id)) {
            cleanup();
            console.log('nostr-login processed nip46 request in', Date.now() - now, 'ms');
            cb(response);
          }
        }
      };

      this.once('response-' + id, responseHandler);
    });
  }

  protected async createRequestEvent(id: string, remotePubkey: string, method: string, params: string[] = [], kind = 24133): Promise<NostrEvent> {
    this.requests.add(id);
    const request = { id, method, params };

    const content = JSON.stringify(request);
    const useNip44 = this._useNip44 && method !== 'create_account';
    const encrypt = useNip44 ? this._signer.encryptNip44 : this._signer.encrypt;
    const encryptedContent = await encrypt.call(this._signer, { pubkey: remotePubkey }, content);

    const template = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', remotePubkey]],
      content: encryptedContent,
    };

    const signed = finalizeEvent(template, this._signer.secretKey);

    return signed as unknown as NostrEvent;
  }
}

// ─── IframeNostrRpc ─────────────────────────────────────────────────

export class IframeNostrRpc extends NostrRpc {
  private peerOrigin?: string;
  private iframePort?: MessagePort;
  private iframeRequests = new Map<string, { id: string; pubkey: string }>();
  private pingInterval?: ReturnType<typeof setInterval>;

  public constructor(pool: RelayPool, localSigner: PrivateKeySigner, iframePeerOrigin?: string) {
    super(pool, localSigner);
    this.peerOrigin = iframePeerOrigin;
  }

  public override subscribe(filter: Filter): void {
    if (!this.peerOrigin) {
      super.subscribe(filter);
      return;
    }
    // iframe経由の場合はリレー購読不要
  }

  public setWorkerIframePort(port: MessagePort) {
    if (!this.peerOrigin) throw new Error('Unexpected iframe port');

    this.iframePort = port;

    // 前回のpingインターバルがあればクリア
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      console.log('iframe-nip46 ping');
      this.iframePort!.postMessage('ping');
    }, 5000);

    port.onmessage = async ev => {
      console.log('iframe-nip46 got response', ev.data);
      if (typeof ev.data === 'string' && ev.data.startsWith('errorNoKey')) {
        const event_id = ev.data.split(':')[1];
        const { id = '', pubkey = '' } = this.iframeRequests.get(event_id) || {};
        if (id && pubkey && this.requests.has(id)) this.emit('iframeRestart-' + pubkey);
        return;
      }

      try {
        const event = ev.data;

        if (!validateEvent(event)) throw new Error('Invalid event from iframe');
        if (!verifyEvent(event)) throw new Error('Invalid event signature from iframe');
        const parsedEvent = await this.parseEvent(event as NostrEvent);

        if (!(parsedEvent as RpcRequest).method) {
          console.log('parsed response', parsedEvent);
          this.emit('response-' + parsedEvent.id, parsedEvent);
        }
      } catch (e) {
        console.log('error parsing event', e, ev.data);
      }
    };
  }

  public override async sendRequest(remotePubkey: string, method: string, params: string[] = [], kind = 24133, cb?: (res: RpcResponse) => void): Promise<RpcResponse> {
    const id = this.getId();

    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);

    this.setResponseHandler(id, cb);

    if (this.iframePort) {
      this.iframeRequests.set(event.id || '', { id, pubkey: remotePubkey });

      console.log('iframe-nip46 sending request to', this.peerOrigin, event);
      this.iframePort.postMessage(event);
    } else {
      await this.pool.publish(event);
    }

    // @ts-ignore
    return undefined as RpcResponse;
  }

  public override stop() {
    super.stop();
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }
}

// ─── ReadyListener ──────────────────────────────────────────────────

export class ReadyListener {
  origin: string;
  messages: string[];
  promise: Promise<any>;

  constructor(messages: string[], origin: string) {
    this.origin = origin;
    this.messages = messages;
    this.promise = new Promise<any>(ok => {
      console.log(new Date(), 'started listener for', this.messages);

      const onReady = async (e: MessageEvent) => {
        const originHostname = new URL(origin!).hostname;
        const messageHostname = new URL(e.origin).hostname;
        const validHost = messageHostname === originHostname || messageHostname.endsWith('.' + originHostname);
        if (!validHost || !Array.isArray(e.data) || !e.data.length || !this.messages.includes(e.data[0])) {
          return;
        }

        console.log(new Date(), 'got ready message from', e.origin, e.data);
        window.removeEventListener('message', onReady);
        ok(e.data);
      };
      window.addEventListener('message', onReady);
    });
  }

  async wait(): Promise<any> {
    console.log(new Date(), 'waiting for', this.messages);
    const r = await this.promise;
    console.log(new Date(), 'finished waiting for', this.messages, r);
    return r;
  }
}

// ─── Nip46Signer ────────────────────────────────────────────────────

export class Nip46Signer extends EventEmitter {
  public rpc: IframeNostrRpc;
  public bunkerPubkey: string;
  public userPubkey: string = '';

  constructor(pool: RelayPool, localSigner: PrivateKeySigner, signerPubkey: string, iframeOrigin?: string) {
    super();

    this.bunkerPubkey = signerPubkey;

    this.rpc = new IframeNostrRpc(pool, localSigner, iframeOrigin);
    this.rpc.setUseNip44(true);
    this.rpc.on('authUrl', (url: string) => {
      this.emit('authUrl', url);
    });
  }

  private async setSignerPubkey(signerPubkey: string, sameAsUser: boolean = false) {
    console.log('setSignerPubkey', signerPubkey);

    this.bunkerPubkey = signerPubkey;

    this.rpc.on('iframeRestart-' + signerPubkey, () => {
      this.emit('iframeRestart');
    });

    await this.initUserPubkey(sameAsUser ? signerPubkey : '');
  }

  public async initUserPubkey(hintPubkey?: string) {
    if (this.userPubkey) {
      console.warn('initUserPubkey already called, pubkey:', this.userPubkey);
      return;
    }

    if (hintPubkey) {
      this.userPubkey = hintPubkey;
      console.log('User pubkey set from hint:', this.userPubkey);
      return;
    }

    console.log('Requesting user pubkey from signer:', this.bunkerPubkey);

    this.userPubkey = await new Promise<string>((ok, err) => {
      if (!this.bunkerPubkey) throw new Error('Signer pubkey not set');

      const timeout = setTimeout(() => {
        err(new Error('Timeout getting user pubkey'));
      }, 30000);

      console.log('get_public_key', this.bunkerPubkey);
      this.rpc.sendRequest(this.bunkerPubkey, 'get_public_key', [], 24133, (response: RpcResponse) => {
        clearTimeout(timeout);

        if (response.error) {
          err(new Error(response.error));
        } else {
          console.log('User pubkey received:', response.result);
          ok(response.result);
        }
      });
    });
  }

  public async listen(nostrConnectSecret: string) {
    const signerPubkey = await this.rpc.listen(nostrConnectSecret);
    await this.setSignerPubkey(signerPubkey);
  }

  public async connect(token?: string, perms?: string) {
    if (!this.bunkerPubkey) throw new Error('No signer pubkey');
    await this.rpc.connect(this.bunkerPubkey, token, perms);
    await this.setSignerPubkey(this.bunkerPubkey);
  }

  public async setListenReply(reply: any, nostrConnectSecret: string) {
    const signerPubkey = await this.rpc.parseNostrConnectReply(reply, nostrConnectSecret);
    await this.setSignerPubkey(signerPubkey, true);
  }

  /**
   * NIP-46 remote signing: signer にイベントの署名を依頼する。
   * signerが返したsigned eventにpubkey/idが含まれていれば完全なオブジェクトを返す。
   * そうでなければsig文字列のみ返す。
   */
  public async sign(event: any): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const eventPayload = JSON.stringify(event);
      this.rpc.sendRequest(this.bunkerPubkey, 'sign_event', [eventPayload], 24133, (response: RpcResponse) => {
        if (response.error) {
          if (response.error.includes('timeout') || response.error === 'Request timeout') {
            reject(new Nip46Error(response.error, 'TIMEOUT'));
          } else {
            reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
          }
        } else {
          try {
            const signedEvent = JSON.parse(response.result);
            // signerが完全なsigned eventを返した場合はそのまま返す
            if (signedEvent.sig && signedEvent.pubkey && signedEvent.id) {
              resolve(signedEvent);
            } else if (signedEvent.sig) {
              resolve(signedEvent.sig);
            } else {
              resolve(response.result);
            }
          } catch {
            resolve(response.result);
          }
        }
      });
    });
  }

  /**
   * NIP-46 remote encrypt (NIP-04)
   */
  public async encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.rpc.sendRequest(this.bunkerPubkey, 'nip04_encrypt', [recipientPubkey, plaintext], 24133, (response: RpcResponse) => {
        if (response.error) {
          reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
        } else {
          resolve(response.result);
        }
      });
    });
  }

  /**
   * NIP-46 remote decrypt (NIP-04)
   */
  public async decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.rpc.sendRequest(this.bunkerPubkey, 'nip04_decrypt', [senderPubkey, ciphertext], 24133, (response: RpcResponse) => {
        if (response.error) {
          reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
        } else {
          resolve(response.result);
        }
      });
    });
  }

  public async createAccount2({ bunkerPubkey, name, domain, perms = '' }: { bunkerPubkey: string; name: string; domain: string; perms?: string }) {
    const params = [name, domain, '', perms];

    const r = await new Promise<RpcResponse>((ok, err) => {
      const timeout = setTimeout(() => {
        err(new Error('Timeout creating account'));
      }, 60000);

      this.rpc.sendRequest(bunkerPubkey, 'create_account', params, undefined, response => {
        clearTimeout(timeout);
        ok(response);
      });
    });

    console.log('create_account response', r);
    if (r.result === 'error' || r.error) {
      throw new Error(r.error || 'Failed to create account');
    }

    return r.result;
  }
}
