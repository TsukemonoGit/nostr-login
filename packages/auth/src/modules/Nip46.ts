import { EventEmitter } from 'tseep';
import { validateEvent, verifySignature, nip04, getEventHash, getSignature } from 'nostr-tools';
import { SimplePool } from 'nostr-tools';
import { PrivateKeySigner } from './Signer';

// Lightweight Nostr RPC for NIP-46 that does not rely on NDK

export type RpcRequest = { id: string; pubkey: string; method: string; params: any[]; event?: any };
export type RpcResponse = { id: string; result?: any; error?: any; event?: any };

export class NostrRpc extends EventEmitter {
  protected localSigner: PrivateKeySigner;
  protected localPubkey: string;
  protected localPrivateKey: string;
  protected remotePubkey: string = '';
  protected pool: SimplePool;
  protected relays: string[] = [];
  protected subscription: any;
  protected isSubscribed: boolean = false;
  protected useNip44: boolean = false;

  protected requests: Set<string> = new Set();

  constructor(localSigner: PrivateKeySigner, relays: string[] = []) {
    super();
    this.localSigner = localSigner;
    this.localPubkey = localSigner.pubkey;
    this.localPrivateKey = (localSigner as any).privateKey;
    this.pool = new SimplePool();
    this.relays = relays && relays.length ? relays : [];
  }

  public setUseNip44(use: boolean) {
    this.useNip44 = use;
  }

  protected isNip04(ciphertext: string) {
    const l = ciphertext.length;
    if (l < 28) return false;
    return ciphertext[l - 28] === '?' && ciphertext[l - 27] === 'i' && ciphertext[l - 26] === 'v' && ciphertext[l - 25] === '=';
  }

  protected async decryptEventContent(event: any) {
    const decrypt = this.isNip04(event.content)
      ? this.localSigner.decrypt.bind(this.localSigner)
      : this.localSigner.decryptNip44?.bind(this.localSigner) ?? this.localSigner.decrypt.bind(this.localSigner);
    try {
      const decrypted = await decrypt(event.pubkey || event.pubkey, event.content);
      return JSON.parse(decrypted);
    } catch (e) {
      throw e;
    }
  }

  protected async parseEvent(event: any): Promise<RpcRequest | RpcResponse> {
    const parsed = await this.decryptEventContent(event);
    const { id, method, params, result, error } = parsed;
    if (method) {
      return { id, pubkey: event.pubkey, method, params, event } as RpcRequest;
    } else {
      return { id, result, error, event } as RpcResponse;
    }
  }

  public subscribe(relays: string[], filter: any) {
    if (this.isSubscribed) return;
    this.relays = relays && relays.length ? relays : this.relays;
    const since = Math.floor(Date.now() / 1000) - 60;
    const filters = [{ ...filter, since }];
    this.subscription = this.pool.sub(this.relays, filters);
    this.subscription.on('event', async (ev: any) => {
      try {
        const parsed = await this.parseEvent(ev);
        if (!(parsed as RpcRequest).method) {
          this.emit(`response-${(parsed as RpcResponse).id}`, parsed as RpcResponse);
        } else {
          this.emit('request', parsed as RpcRequest);
        }
      } catch (e) {
        // ignore parse errors
      }
    });
    this.subscription.on('eose', () => {
      /* noop */
    });
    this.isSubscribed = true;
  }

  public stop() {
    if (this.subscription && this.subscription.unsub) {
      try {
        this.subscription.unsub();
      } catch (e) {}
    }
    this.isSubscribed = false;
  }

  protected getId() {
    return Math.random().toString(36).substring(7);
  }

  protected setResponseHandler(id: string, cb?: (res: RpcResponse) => void) {
    let authUrlSent = false;
    const now = Date.now();

    const responseHandler = (response: RpcResponse) => {
      if (response.result === 'auth_url') {
        // reattach for auth_url so we can get final response later
        this.once(`response-${id}`, responseHandler);
        if (!authUrlSent) {
          authUrlSent = true;
          this.emit('authUrl', response.error);
        }
      } else if (cb) {
        if (this.requests.has(id)) {
          this.requests.delete(id);
          cb(response);
        }
      }
    };

    this.once(`response-${id}`, responseHandler);
  }

  protected async createRequestEvent(id: string, remotePubkey: string, method: string, params: any[] = [], kind = 24133) {
    this.requests.add(id);
    const request = { id, method, params };
    // encrypt
    const content =
      this.useNip44 && method !== 'create_account' && this.localSigner.encryptNip44
        ? await this.localSigner.encryptNip44(remotePubkey, JSON.stringify(request))
        : await this.localSigner.encrypt(remotePubkey, JSON.stringify(request));

    const event: any = {
      kind,
      content,
      tags: [['p', remotePubkey]],
      pubkey: this.localPubkey,
      created_at: Math.floor(Date.now() / 1000),
    };

    // sign using signer
    await this.localSigner.sign(event as any);

    return event;
  }

  protected async publishRequest(event: any) {
    try {
      await Promise.any(this.pool.publish(this.relays, event));
    } catch (e) {
      // swallow publish errors
    }
  }

  public async sendRequest(remotePubkey: string, method: string, params: any[] = [], kind = 24133, cb?: (res: RpcResponse) => void): Promise<RpcResponse | undefined> {
    const id = this.getId();
    this.setResponseHandler(id, cb);
    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);
    await this.publishRequest(event);
    return undefined as any;
  }

  public async listen(nostrConnectSecret: string, relays?: string[]) {
    const pubkey = this.localPubkey;
    this.subscribe(relays || this.relays, { 'kinds': [24133], '#p': [pubkey] });
    return new Promise<string>((ok, err) => {
      const handler = async (event: any) => {
        try {
          const parsed = await this.parseEvent(event);
          if ((parsed as RpcResponse).result === 'auth_url') return; // ignore
          const response = parsed as RpcResponse;
          if (response.result === 'ack' || response.result === nostrConnectSecret) {
            ok(event.pubkey);
            this.stop();
          } else {
            err(response.error);
            this.stop();
          }
        } catch (e) {
          // ignore
        }
      };

      this.once('request', handler);
    });
  }
}

export class IframeNostrRpc extends NostrRpc {
  private peerOrigin?: string;
  private iframePort?: MessagePort;
  private iframeRequests = new Map<string, { id: string; pubkey: string }>();

  constructor(localSigner: PrivateKeySigner, iframePeerOrigin?: string, relays: string[] = []) {
    super(localSigner, relays);
    this.peerOrigin = iframePeerOrigin;
  }

  public setWorkerIframePort(port: MessagePort) {
    if (!this.peerOrigin) throw new Error('Unexpected iframe port');
    this.iframePort = port;

    // keep the channel alive
    setInterval(() => {
      try {
        this.iframePort!.postMessage('ping');
      } catch (e) {}
    }, 5000);

    this.iframePort.onmessage = async ev => {
      // handle special error reply
      if (typeof ev.data === 'string' && ev.data.startsWith('errorNoKey')) {
        const event_id = ev.data.split(':')[1];
        const entry = this.iframeRequests.get(event_id) || { id: '', pubkey: '' };
        const { id = '', pubkey = '' } = entry;
        if (id && pubkey && this.requests.has(id)) this.emit(`iframeRestart-${pubkey}`);
        return;
      }

      try {
        const event = ev.data;
        if (!validateEvent(event)) throw new Error('Invalid event from iframe');
        if (!verifySignature(event)) throw new Error('Invalid event signature from iframe');
        const parsed = await this.parseEvent(event);
        if (!(parsed as RpcRequest).method) {
          this.emit(`response-${(parsed as RpcResponse).id}`, parsed as RpcResponse);
        }
      } catch (e) {
        // ignore parse errors
      }
    };
  }

  public async sendRequest(remotePubkey: string, method: string, params: any[] = [], kind = 24133, cb?: (res: RpcResponse) => void): Promise<RpcResponse | undefined> {
    const id = this.getId();
    this.setResponseHandler(id, cb);
    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);

    // map request event id -> id for iframe restarts
    this.iframeRequests.set(event.id, { id, pubkey: remotePubkey });

    if (this.iframePort) {
      try {
        this.iframePort.postMessage(event);
      } catch (e) {
        // fallthrough to publish to relays as well
        await this.publishRequest(event);
      }
    } else {
      await this.publishRequest(event);
    }

    return undefined as any;
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
      const onReady = async (e: MessageEvent) => {
        const originHostname = new URL(origin!).hostname;
        const messageHostname = new URL(e.origin).hostname;
        const validHost = messageHostname === originHostname || messageHostname.endsWith('.' + originHostname);
        if (!validHost || !Array.isArray(e.data) || !e.data.length || !this.messages.includes(e.data[0])) {
          return;
        }

        window.removeEventListener('message', onReady);
        ok(e.data);
      };
      window.addEventListener('message', onReady);
    });
  }

  async wait(): Promise<any> {
    const r = await this.promise;
    return r;
  }
}

export class Nip46Signer extends EventEmitter {
  private _userPubkey: string = '';
  public remotePubkey: string = '';
  public rpc: IframeNostrRpc | NostrRpc;
  private localSigner: PrivateKeySigner;

  constructor(localSigner: PrivateKeySigner, signerPubkey: string, iframeOrigin?: string, relays: string[] = []) {
    super();
    this.remotePubkey = signerPubkey;
    this.localSigner = localSigner;

    if (iframeOrigin) {
      this.rpc = new IframeNostrRpc(localSigner, iframeOrigin, relays);
    } else {
      this.rpc = new NostrRpc(localSigner, relays);
    }
    (this.rpc as any).setUseNip44(true);

    this.rpc.on('authUrl', (url: string) => {
      this.emit('authUrl', url);
    });
  }

  get userPubkey() {
    return this._userPubkey;
  }

  private async setSignerPubkey(signerPubkey: string, sameAsUser: boolean = false) {
    this.remotePubkey = signerPubkey;

    this.rpc.on(`iframeRestart-${signerPubkey}`, () => {
      this.emit('iframeRestart');
    });

    await this.initUserPubkey(sameAsUser ? signerPubkey : '');
  }

  public async initUserPubkey(hintPubkey?: string) {
    if (this._userPubkey) throw new Error('Already called initUserPubkey');

    if (hintPubkey) {
      this._userPubkey = hintPubkey;
      return;
    }

    this._userPubkey = await new Promise<string>((ok, err) => {
      if (!this.remotePubkey) throw new Error('Signer pubkey not set');
      this.rpc.sendRequest(this.remotePubkey, 'get_public_key', [], 24133, (response: RpcResponse) => {
        if (response.error) return err(response.error);
        ok(response.result);
      });
    });
  }

  public async listen(nostrConnectSecret: string) {
    const signerPubkey = await (this.rpc as any).listen(nostrConnectSecret, (this.rpc as any).relays);
    await this.setSignerPubkey(signerPubkey);
  }

  public async connect(token?: string, perms?: string) {
    if (!this.remotePubkey) throw new Error('No signer pubkey');
    return new Promise<void>((ok, err) => {
      const params = [this.localSigner.pubkey, token || '', perms || ''];
      this.rpc.sendRequest(this.remotePubkey, 'connect', params, 24133, (response: RpcResponse) => {
        if (response.result === 'ack') ok();
        else err(response.error);
      });
    });
  }

  // convenience wrappers
  public async createAccount2(params: any) {
    return new Promise((ok, err) => {
      this.rpc.sendRequest(this.remotePubkey, 'create_account', [params], 24133, (response: RpcResponse) => {
        if (response.error) err(response.error);
        else ok(response.result);
      });
    });
  }

  public async encrypt(pubkey: string, plaintext: string) {
    return this.localSigner.encrypt(pubkey, plaintext);
  }

  public async decrypt(pubkey: string, ciphertext: string) {
    return this.localSigner.decrypt(pubkey, ciphertext);
  }

  public async sign(event: any) {
    await this.localSigner.sign(event);
    return event.sig;
  }
}
