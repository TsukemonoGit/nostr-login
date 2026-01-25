import NDK, { NDKEvent, NDKFilter, NDKNip46Signer, NDKNostrRpc, NDKRpcRequest, NDKRpcResponse, NDKSubscription, NDKSubscriptionCacheUsage, NDKUser, NostrEvent } from '@nostr-dev-kit/ndk';
import { validateEvent, verifySignature } from 'nostr-tools';
import { PrivateKeySigner } from './Signer';
import { NIP46_REQUEST_TIMEOUT, NIP46_CONNECT_TIMEOUT } from '../const';
import { EventEmitter } from 'events';

// タイムアウト付きPromiseラッパー
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMessage)), timeoutMs))]);
}

class NostrRpc extends NDKNostrRpc {
  protected _ndk: NDK;
  protected _signer: PrivateKeySigner;
  protected requests: Set<string> = new Set();
  private sub?: NDKSubscription;
  protected _useNip44: boolean = false;
  public  eventEmitter: EventEmitter = new EventEmitter();

  public constructor(ndk: NDK, signer: PrivateKeySigner) {
    super(ndk, signer, ndk.debug.extend('nip46:signer:rpc'));
    this._ndk = ndk;
    this._signer = signer;
  }

  public async subscribe(filter: NDKFilter): Promise<NDKSubscription> {
    // NOTE: fixing ndk
    filter.kinds = filter.kinds?.filter(k => k === 24133);
    this.sub = await super.subscribe(filter);
    return this.sub;
  }

  public stop() {
    if (this.sub) {
      this.sub.stop();
      this.sub = undefined;
    }
  }

  public setUseNip44(useNip44: boolean) {
    this._useNip44 = useNip44;
  }

  private isNip04(ciphertext: string) {
    const l = ciphertext.length;
    if (l < 28) return false;
    return ciphertext[l - 28] === '?' && ciphertext[l - 27] === 'i' && ciphertext[l - 26] === 'v' && ciphertext[l - 25] === '=';
  }

  // override to auto-decrypt nip04/nip44
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
      if (response.result !== secret) throw new Error(response.error);
      return event.pubkey;
    } else {
      throw new Error('Bad nostr connect reply');
    }
  }

  // ndk doesn't support nostrconnect:
  // we just listed to an unsolicited reply to
  // our pubkey and if it's ack/secret - we're fine
  public async listen(nostrConnectSecret: string): Promise<string> {
    const pubkey = this._signer.pubkey;
    console.log('nostr-login listening for conn to', pubkey);
    const sub = await this.subscribe({
      'kinds': [24133],
      '#p': [pubkey],
    });
    return new Promise<string>((ok, err) => {
      sub.on('event', async (event: NDKEvent) => {
        try {
          const parsedEvent = await this.parseEvent(event);
          // console.log('ack parsedEvent', parsedEvent);
          if (!(parsedEvent as NDKRpcRequest).method) {
            const response = parsedEvent as NDKRpcResponse;

            // ignore
            if (response.result === 'auth_url') return;

            // FIXME for now accept 'ack' replies, later on only
            // accept secrets
            if (response.result === 'ack' || response.result === nostrConnectSecret) {
              ok(event.pubkey);
            } else {
              err(response.error);
            }
          }
        } catch (e) {
          console.log('error parsing event', e, event.rawEvent());
        }
        // done
        this.stop();
      });
    });
  }

  // since ndk doesn't yet support perms param
  // we reimplement the 'connect' call here
  // instead of await signer.blockUntilReady();
  public async connect(pubkey: string, token?: string, perms?: string) {
    return new Promise<void>((ok, err) => {
      const connectParams = [pubkey!, token || '', perms || ''];
      this.sendRequest(pubkey!, 'connect', connectParams, 24133, (response: NDKRpcResponse) => {
        if (response.result === 'ack') {
          ok();
        } else {
          err(response.error);
        }
      });
    });
  }

  // タイムアウト対応のconnect
  public async connectWithTimeout(pubkey: string, token?: string, perms?: string, timeoutMs: number = NIP46_CONNECT_TIMEOUT): Promise<void> {
    return withTimeout(this.connect(pubkey, token, perms), timeoutMs, `Connection timeout after ${timeoutMs}ms`);
  }

  // ping実装
  public async ping(remotePubkey: string): Promise<void> {
    return new Promise<void>((ok, err) => {
      this.sendRequest(remotePubkey, 'ping', [], 24133, (response: NDKRpcResponse) => {
        if (response.result === 'pong') {
          ok();
        } else {
          err(new Error(response.error || 'ping failed'));
        }
      });
    });
  }

  // タイムアウト対応のping
  public async pingWithTimeout(remotePubkey: string, timeoutMs: number = 3000): Promise<void> {
    return withTimeout(this.ping(remotePubkey), timeoutMs, `Ping timeout after ${timeoutMs}ms`);
  }

  protected getId(): string {
    return Math.random().toString(36).substring(7);
  }

   public override once = <EventKey extends string | symbol = string>(
    event: EventKey,
    listener: (...args: any[]) => void
  ): this => {
    this.eventEmitter.once(event as string, listener);
    return this;
  }

  public async sendRequest(remotePubkey: string, method: string, params: string[] = [], kind = 24133, cb?: (res: NDKRpcResponse) => void): Promise<NDKRpcResponse> {
    const id = this.getId();

    // response handler will deduplicate auth urls and responses
    this.setResponseHandler(id, cb);

    // create and sign request
    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);
    console.log('sendRequest', { event, method, remotePubkey, params });

    // send to relays
    await event.publish();

    // NOTE: ndk returns a promise that never resolves and
    // in fact REQUIRES cb to be provided (otherwise no way
    // to consume the result), we've already stepped on the bug
    // of waiting for this unresolvable result, so now we return
    // undefined to make sure waiters fail, not hang.
    // @ts-ignore
    return undefined as NDKRpcResponse;
  }

  protected setResponseHandler(id: string, cb?: (res: NDKRpcResponse) => void) {
    let authUrlSent = false;
    const now = Date.now();
    return new Promise<NDKRpcResponse>(() => {
      const responseHandler = (response: NDKRpcResponse) => {
        if (response.result === 'auth_url') {
          this.eventEmitter.once(`response-${id}`, responseHandler);
          if (!authUrlSent) {
            authUrlSent = true;
            this.eventEmitter.emit('authUrl', response.error);
          }
        } else if (cb) {
          if (this.requests.has(id)) {
            this.requests.delete(id);
            console.log('nostr-login processed nip46 request in', Date.now() - now, 'ms');
            cb(response);
          }
        }
      };

      this.eventEmitter.once(`response-${id}`, responseHandler);
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

  // EventEmitter互換メソッド
  public override on = <EventKey extends string | symbol = string>(
    event: EventKey,
    listener: (...args: any[]) => void
  ): this => {
    this.eventEmitter.on(event as string, listener);
    return this;
  }

  public override emit = <EventKey extends string | symbol = string>(
    event: EventKey,
    ...args: any[]
  ): boolean => {
    return this.eventEmitter.emit(event as string, ...args);
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
        // don't send to relay
        closeOnEose: true,
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_CACHE,
      },
    );
  }

  public setWorkerIframePort(port: MessagePort) {
    if (!this.peerOrigin) throw new Error('Unexpected iframe port');

    this.iframePort = port;

    // to make sure Chrome doesn't terminate the channel
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

      // a copy-paste from rpc.subscribe
      try {
        const event = ev.data;

        if (!validateEvent(event)) throw new Error('Invalid event from iframe');
        if (!verifySignature(event)) throw new Error('Invalid event signature from iframe');
        const nevent = new NDKEvent(this._ndk, event);
        const parsedEvent = await this.parseEvent(nevent);
        // we're only implementing client-side rpc
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

    // create and sign request event
    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);

    // set response handler, it will dedup auth urls,
    // and also dedup response handlers - we're sending
    // to relays and to iframe
    this.setResponseHandler(id, cb);

    if (this.iframePort) {
      // map request event id to request id, if iframe
      // has no key it will reply with error:event_id (it can't
      // decrypt the request id without keys)
      this.iframeRequests.set(event.id, { id, pubkey: remotePubkey });

      // send to iframe
      console.log('iframe-nip46 sending request to', this.peerOrigin, event.rawEvent());
      this.iframePort.postMessage(event.rawEvent());
    } else {
      // send to relays
      await event.publish();
    }

    // see notes in 'super'
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

      // ready message handler
      const onReady = async (e: MessageEvent) => {
        const originHostname = new URL(origin!).hostname;
        const messageHostname = new URL(e.origin).hostname;
        // same host or subdomain
        const validHost = messageHostname === originHostname || messageHostname.endsWith('.' + originHostname);
        if (!validHost || !Array.isArray(e.data) || !e.data.length || !this.messages.includes(e.data[0])) {
          // console.log(new Date(), 'got invalid ready message', e.origin, e.data);
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
  private lastPingTime: number = 0;
  private pingCacheDuration: number = 30000; // 30秒
  // ★ 追加: 再接続中フラグ
  private isReconnecting: boolean = false;

  constructor(ndk: NDK, localSigner: PrivateKeySigner, signerPubkey: string, iframeOrigin?: string) {
    super(ndk, signerPubkey, localSigner);

    // override with our own rpc implementation
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



   // ★ 既存メソッドを修正: リトライロジックを削除
  private async ensureConnection(): Promise<void> {
    if (!this.remotePubkey) return;

    const now = Date.now();

    // キャッシュチェック
    if (now - this.lastPingTime < this.pingCacheDuration) {
      return;
    }

    try {
      await this._rpc.pingWithTimeout(this.remotePubkey, 2000);
      this.lastPingTime = now;
      console.log('Connection check OK');
    } catch (error) {
      console.error('Connection check failed', error);
      // ★ 修正: リトライは行わず、接続喪失イベントのみ発火
      this.emit('connectionLost');
      throw new Error('NIP-46 connection lost');
    }
  }


  // ★ 新規追加: 再接続メソッド（外部から呼ばれる）
  public async reconnect(info: any): Promise<void> {
    if (this.isReconnecting) {
      console.log('Already reconnecting, skipping...');
      return;
    }

    this.isReconnecting = true;

    try {
      console.log('Reconnecting signer...');
      
      // リレー再接続は AuthNostrService 側で実施済みと仮定
      // ここでは ping のみ実施
      if (this.remotePubkey) {
        await this._rpc.pingWithTimeout(this.remotePubkey, 2000);
        this.lastPingTime = Date.now();
        console.log('Reconnection successful');
      }
      
      this.isReconnecting = false;
    } catch (error) {
      this.isReconnecting = false;
      throw error;
    }
  }

  private async setSignerPubkey(signerPubkey: string, sameAsUser: boolean = false) {
    console.log('setSignerPubkey', signerPubkey);

    // ensure it's set
    this.remotePubkey = signerPubkey;

    // when we're sure it's known
    this._rpc.on(`iframeRestart-${signerPubkey}`, () => {
      this.emit('iframeRestart');
    });

    // now call getPublicKey and swap remotePubkey w/ that
    await this.initUserPubkey(sameAsUser ? signerPubkey : '');
  }

  public async initUserPubkey(hintPubkey?: string) {
    if (this._userPubkey) throw new Error('Already called initUserPubkey');

    if (hintPubkey) {
      this._userPubkey = hintPubkey;
      return;
    }

    this._userPubkey = await withTimeout(
      new Promise<string>((ok, err) => {
        if (!this.remotePubkey) throw new Error('Signer pubkey not set');

        console.log('get_public_key', this.remotePubkey);
        this._rpc.sendRequest(this.remotePubkey, 'get_public_key', [], 24133, (response: NDKRpcResponse) => {
          if (response.error) {
            err(new Error(response.error));
          } else {
            ok(response.result);
          }
        });
      }),
      NIP46_REQUEST_TIMEOUT,
      'Timeout getting public key',
    );
  }

  public async listen(nostrConnectSecret: string) {
    const signerPubkey = await (this.rpc as IframeNostrRpc).listen(nostrConnectSecret);
    await this.setSignerPubkey(signerPubkey);

    // ログイン完了後に接続確認
    await this.ensureConnection();
  }

  public async connect(token?: string, perms?: string) {
    if (!this.remotePubkey) throw new Error('No signer pubkey');
    await this._rpc.connectWithTimeout(this.remotePubkey, token, perms, NIP46_CONNECT_TIMEOUT);
    await this.setSignerPubkey(this.remotePubkey);

    // ログイン完了後に接続確認
    await this.ensureConnection();
  }

  public async setListenReply(reply: any, nostrConnectSecret: string) {
    const signerPubkey = await this._rpc.parseNostrConnectReply(reply, nostrConnectSecret);
    await this.setSignerPubkey(signerPubkey, true);

    // ログイン完了後に接続確認
    await this.ensureConnection();
  }

  // 署名メソッドのオーバーライド - 署名前に接続確認
  async sign(event: NostrEvent): Promise<string> {
    await this.ensureConnection();
    return super.sign(event);
  }

  async encrypt(recipient: NDKUser, value: string): Promise<string> {
    await this.ensureConnection();
    return super.encrypt(recipient, value);
  }

  async decrypt(sender: NDKUser, value: string): Promise<string> {
    await this.ensureConnection();
    return super.decrypt(sender, value);
  }

  public async createAccount2({ bunkerPubkey, name, domain, perms = '' }: { bunkerPubkey: string; name: string; domain: string; perms?: string }) {
    const params = [
      name,
      domain,
      '', // email
      perms,
    ];

    const r = await new Promise<NDKRpcResponse>(ok => {
      this.rpc.sendRequest(bunkerPubkey, 'create_account', params, undefined, ok);
    });

    console.log('create_account pubkey', r);
    if (r.result === 'error') {
      throw new Error(r.error);
    }

    return r.result;
  }

  // ★ 追加: removeAllListeners メソッド
  public removeAllListeners = (event?: string | symbol): this => {
    if (event) {
      this._rpc.eventEmitter.removeAllListeners(event as string);
    } else {
      this._rpc.eventEmitter.removeAllListeners();
    }
    return this;
  }


  // EventEmitter互換メソッド
    // ★ ここに once を追加 ★
  public override on = <EventKey extends string | symbol = string>(
    event: EventKey,
    listener: (...args: any[]) => void
  ): this => {
    this._rpc.on(event as string, listener);
    return this;
  }

  public override once = <EventKey extends string | symbol = string>(
    event: EventKey,
    listener: (...args: any[]) => void
  ): this => {
    this._rpc.once(event as string, listener);
    return this;
  }

  public override emit = <EventKey extends string | symbol = string>(
    event: EventKey,
    ...args: any[]
  ): boolean => {
    return this._rpc.emit(event as string, ...args);
  }
}