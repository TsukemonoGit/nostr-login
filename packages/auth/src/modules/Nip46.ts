// packages/auth/src/modules/Nip46.ts

import NDK, { NDKEvent, NDKFilter, NDKNip46Signer, NDKNostrRpc, NDKRpcRequest, NDKRpcResponse, NDKSubscription, NDKSubscriptionCacheUsage, NostrEvent } from '@nostr-dev-kit/ndk';
import { validateEvent, verifySignature } from 'nostr-tools';
import { PrivateKeySigner } from './Signer';
import { NIP46_REQUEST_TIMEOUT } from '../const';

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

class NostrRpc extends NDKNostrRpc {
  protected _ndk: NDK;
  protected _signer: PrivateKeySigner;
  protected requests: Set<string> = new Set();
  private sub?: NDKSubscription;
  private lastSubscribeFilter?: NDKFilter;
  private requestTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  protected _useNip44: boolean = false;

  public constructor(ndk: NDK, signer: PrivateKeySigner) {
    super(ndk, signer, ndk.debug.extend('nip46:signer:rpc'));
    this._ndk = ndk;
    this._signer = signer;
  }

  public async subscribe(filter: NDKFilter): Promise<NDKSubscription> {
    filter.kinds = filter.kinds?.filter(k => k === 24133);
    this.lastSubscribeFilter = { ...filter };

    // NDKNostrRpc.subscribe() はEOSE待ちのPromiseを返すが、
    // リレーが不安定な状態ではEOSEが届かず無限にハングする。
    // NIP-46ではリアルタイムのレスポンスのみ必要なので、
    // EOSE待ちをスキップして直接subscribeする。
    const sub = this._ndk.subscribe(filter, {
      closeOnEose: false,
      groupable: false,
    });

    sub.on('event', async (event: NDKEvent) => {
      try {
        const parsedEvent = await this.parseEvent(event);
        if ((parsedEvent as NDKRpcRequest).method) {
          this.emit('request', parsedEvent);
        } else {
          this.emit(`response-${parsedEvent.id}`, parsedEvent);
        }
      } catch (e) {
        console.error('error parsing event in subscription', e);
      }
    });

    this.sub = sub;
    return sub;
  }

  public stop() {
    if (this.sub) {
      this.sub.stop();
      this.sub = undefined;
    }
  }

  /**
   * リレー再接続後にsubscriptionを再開する。
   * 前回のsubscribeで使ったフィルタを再利用する。
   */
  public async resubscribe(): Promise<void> {
    if (!this.lastSubscribeFilter) {
      console.warn('resubscribe: no previous filter to resubscribe with');
      return;
    }
    console.log('resubscribe: re-subscribing with filter', this.lastSubscribeFilter);
    this.stop();
    await this.subscribe(this.lastSubscribeFilter);
  }

  /**
   * subscriptionが生きているかチェック。
   * リレーが再接続されてもsubscriptionは自動復活しないので、
   * 署名前にこれで確認する。
   */
  public isSubscriptionActive(): boolean {
    // iframe経由の場合はsubscription不要
    if (!this.lastSubscribeFilter) return true;
    return !!this.sub;
  }

  /**
   * 保留中のリクエストとタイマーをすべてクリアする。
   * キャンセル時やsigner解放時に呼ぶ。
   */
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

  public async parseEvent(event: NDKEvent): Promise<NDKRpcRequest | NDKRpcResponse> {
    const remoteUser = this._ndk.getUser({ pubkey: event.pubkey });
    remoteUser.ndk = this._ndk;
    const decrypt = this.isNip04(event.content) ? this._signer.decrypt : this._signer.decryptNip44;
    const decryptedContent = await decrypt.call(this._signer, remoteUser, event.content);
    const parsedContent = JSON.parse(decryptedContent);
    const { id, method, params, result, error } = parsedContent;

    if (method) {
      return { id, pubkey: event.pubkey, method, params, event };
    } else {
      return { id, result, error, event };
    }
  }

  public async parseNostrConnectReply(reply: any, secret: string) {
    const event = new NDKEvent(this._ndk, reply);
    const parsedEvent = await this.parseEvent(event);
    console.log('nostr connect parsedEvent', parsedEvent);
    if (!(parsedEvent as NDKRpcRequest).method) {
      const response = parsedEvent as NDKRpcResponse;
      if (response.result !== secret) throw new Error(response.error || 'Invalid secret in reply');
      return event.pubkey;
    } else {
      throw new Error('Bad nostr connect reply');
    }
  }

  // 修正: listen メソッドの改善
  public async listen(nostrConnectSecret: string): Promise<string> {
    const pubkey = this._signer.pubkey;
    console.log('nostr-login listening for conn to', pubkey, 'expecting secret:', nostrConnectSecret);

    const sub = await this.subscribe({
      'kinds': [24133],
      '#p': [pubkey],
    });

    return new Promise<string>((ok, err) => {
      const timeout = setTimeout(() => {
        this.stop();
        err(new Error('Connection timeout: no response from signer'));
      }, 60000); // 60秒のタイムアウト

      sub.on('event', async (event: NDKEvent) => {
        try {
          const parsedEvent = await this.parseEvent(event);
          console.log('listen parsedEvent', parsedEvent);

          if (!(parsedEvent as NDKRpcRequest).method) {
            const response = parsedEvent as NDKRpcResponse;

            // auth_urlは無視
            if (response.result === 'auth_url') {
              console.log('Ignoring auth_url response in listen');
              return;
            }

            // secretの厳密な検証
            if (response.result === nostrConnectSecret) {
              clearTimeout(timeout);
              this.stop();
              console.log('Connection established with signer:', event.pubkey);
              ok(event.pubkey);
            } else if (response.result === 'ack') {
              // ackは古い実装用の互換性のため警告のみ
              console.warn('Received "ack" instead of secret. This may indicate an older signer implementation.');
              clearTimeout(timeout);
              this.stop();
              ok(event.pubkey);
            } else {
              console.error('Invalid response:', response);
              clearTimeout(timeout);
              this.stop();
              err(new Error(response.error || 'Invalid connection response'));
            }
          }
        } catch (e) {
          console.error('Error parsing event in listen', e, event.rawEvent());
        }
      });

      sub.on('eose', () => {
        console.log('EOSE received in listen');
      });
    });
  }

  public async connect(pubkey: string, token?: string, perms?: string) {
    console.log('Sending connect request to', pubkey, 'with perms:', perms);

    return new Promise<void>((ok, err) => {
      const timeout = setTimeout(() => {
        err(new Error('Connect timeout: no response from signer'));
      }, 30000); // 30秒のタイムアウト

      const connectParams = [pubkey!, token || '', perms || ''];
      this.sendRequest(pubkey!, 'connect', connectParams, 24133, (response: NDKRpcResponse) => {
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

  public async sendRequest(remotePubkey: string, method: string, params: string[] = [], kind = 24133, cb?: (res: NDKRpcResponse) => void): Promise<NDKRpcResponse> {
    const id = this.getId();

    this.setResponseHandler(id, cb);

    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);
    console.log('sendRequest', { event, method, remotePubkey, params });

    await event.publish();

    // @ts-ignore
    return undefined as NDKRpcResponse;
  }

  protected setResponseHandler(id: string, cb?: (res: NDKRpcResponse) => void) {
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

    // タイムアウト: auth_url が来ていればユーザー操作待ちなので延長
    const getTimeout = () => (authUrlReceived ? NIP46_REQUEST_TIMEOUT * 4 : NIP46_REQUEST_TIMEOUT);

    const startTimer = () => {
      // 既存のタイマーをクリア
      const existing = this.requestTimers.get(id);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        console.warn(`nip46 request ${id} timed out after ${Date.now() - now}ms (authUrl=${authUrlReceived})`);
        cleanup();
        if (cb) {
          cb({ id, result: '', error: 'Request timeout', event: undefined as any });
        }
      }, getTimeout());
      this.requestTimers.set(id, timer);
    };

    startTimer();

    return new Promise<NDKRpcResponse>(() => {
      const responseHandler = (response: NDKRpcResponse) => {
        if (response.result === 'auth_url') {
          this.once(`response-${id}`, responseHandler);
          if (!authUrlSent) {
            authUrlSent = true;
            authUrlReceived = true;
            this.emit('authUrl', response.error);
            // auth_url を受け取ったらタイマーを延長
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

      this.once(`response-${id}`, responseHandler);
    });
  }

  protected async createRequestEvent(id: string, remotePubkey: string, method: string, params: string[] = [], kind = 24133) {
    this.requests.add(id);
    const localUser = await this._signer.user();
    const remoteUser = this._ndk.getUser({ pubkey: remotePubkey });
    const request = { id, method, params };

    const event = new NDKEvent(this._ndk, {
      kind,
      content: JSON.stringify(request),
      tags: [['p', remotePubkey]],
      pubkey: localUser.pubkey,
    } as NostrEvent);

    const useNip44 = this._useNip44 && method !== 'create_account';
    const encrypt = useNip44 ? this._signer.encryptNip44 : this._signer.encrypt;
    event.content = await encrypt.call(this._signer, remoteUser, event.content);
    await event.sign(this._signer);

    return event;
  }
}

export class IframeNostrRpc extends NostrRpc {
  private peerOrigin?: string;
  private iframePort?: MessagePort;
  private iframeRequests = new Map<string, { id: string; pubkey: string }>();

  public constructor(ndk: NDK, localSigner: PrivateKeySigner, iframePeerOrigin?: string) {
    super(ndk, localSigner);
    this._ndk = ndk;
    this.peerOrigin = iframePeerOrigin;
  }

  public async subscribe(filter: NDKFilter): Promise<NDKSubscription> {
    if (!this.peerOrigin) return super.subscribe(filter);
    return new NDKSubscription(
      this._ndk,
      {},
      {
        closeOnEose: true,
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_CACHE,
      },
    );
  }

  public setWorkerIframePort(port: MessagePort) {
    if (!this.peerOrigin) throw new Error('Unexpected iframe port');

    this.iframePort = port;

    setInterval(() => {
      console.log('iframe-nip46 ping');
      this.iframePort!.postMessage('ping');
    }, 5000);

    port.onmessage = async ev => {
      console.log('iframe-nip46 got response', ev.data);
      if (typeof ev.data === 'string' && ev.data.startsWith('errorNoKey')) {
        const event_id = ev.data.split(':')[1];
        const { id = '', pubkey = '' } = this.iframeRequests.get(event_id) || {};
        if (id && pubkey && this.requests.has(id)) this.emit(`iframeRestart-${pubkey}`);
        return;
      }

      try {
        const event = ev.data;

        if (!validateEvent(event)) throw new Error('Invalid event from iframe');
        if (!verifySignature(event)) throw new Error('Invalid event signature from iframe');
        const nevent = new NDKEvent(this._ndk, event);
        const parsedEvent = await this.parseEvent(nevent);

        if (!(parsedEvent as NDKRpcRequest).method) {
          console.log('parsed response', parsedEvent);
          this.emit(`response-${parsedEvent.id}`, parsedEvent);
        }
      } catch (e) {
        console.log('error parsing event', e, ev.data);
      }
    };
  }

  public async sendRequest(remotePubkey: string, method: string, params: string[] = [], kind = 24133, cb?: (res: NDKRpcResponse) => void): Promise<NDKRpcResponse> {
    const id = this.getId();

    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);

    this.setResponseHandler(id, cb);

    if (this.iframePort) {
      this.iframeRequests.set(event.id, { id, pubkey: remotePubkey });

      console.log('iframe-nip46 sending request to', this.peerOrigin, event.rawEvent());
      this.iframePort.postMessage(event.rawEvent());
    } else {
      await event.publish();
    }

    // @ts-ignore
    return undefined as NDKRpcResponse;
  }
}

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

export class Nip46Signer extends NDKNip46Signer {
  private _userPubkey: string = '';
  private _rpc: IframeNostrRpc;

  constructor(ndk: NDK, localSigner: PrivateKeySigner, signerPubkey: string, iframeOrigin?: string) {
    super(ndk, signerPubkey, localSigner);

    this._rpc = new IframeNostrRpc(ndk, localSigner, iframeOrigin);
    this._rpc.setUseNip44(true);
    this._rpc.on('authUrl', (url: string) => {
      this.emit('authUrl', url);
    });

    this.rpc = this._rpc;
  }

  get userPubkey() {
    return this._userPubkey;
  }

  private async setSignerPubkey(signerPubkey: string, sameAsUser: boolean = false) {
    console.log('setSignerPubkey', signerPubkey);

    this.remotePubkey = signerPubkey;

    this._rpc.on(`iframeRestart-${signerPubkey}`, () => {
      this.emit('iframeRestart');
    });

    await this.initUserPubkey(sameAsUser ? signerPubkey : '');
  }

  public async initUserPubkey(hintPubkey?: string) {
    if (this._userPubkey) {
      console.warn('initUserPubkey already called, pubkey:', this._userPubkey);
      return;
    }

    if (hintPubkey) {
      this._userPubkey = hintPubkey;
      console.log('User pubkey set from hint:', this._userPubkey);
      return;
    }

    console.log('Requesting user pubkey from signer:', this.remotePubkey);

    this._userPubkey = await new Promise<string>((ok, err) => {
      if (!this.remotePubkey) throw new Error('Signer pubkey not set');

      const timeout = setTimeout(() => {
        err(new Error('Timeout getting user pubkey'));
      }, 30000);

      console.log('get_public_key', this.remotePubkey);
      this._rpc.sendRequest(this.remotePubkey, 'get_public_key', [], 24133, (response: NDKRpcResponse) => {
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
    const signerPubkey = await (this.rpc as IframeNostrRpc).listen(nostrConnectSecret);
    await this.setSignerPubkey(signerPubkey);
  }

  public async connect(token?: string, perms?: string) {
    if (!this.remotePubkey) throw new Error('No signer pubkey');
    await this._rpc.connect(this.remotePubkey, token, perms);
    await this.setSignerPubkey(this.remotePubkey);
  }

  public async setListenReply(reply: any, nostrConnectSecret: string) {
    const signerPubkey = await this._rpc.parseNostrConnectReply(reply, nostrConnectSecret);
    await this.setSignerPubkey(signerPubkey, true);
  }

  public async createAccount2({ bunkerPubkey, name, domain, perms = '' }: { bunkerPubkey: string; name: string; domain: string; perms?: string }) {
    const params = [name, domain, '', perms];

    const r = await new Promise<NDKRpcResponse>((ok, err) => {
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
