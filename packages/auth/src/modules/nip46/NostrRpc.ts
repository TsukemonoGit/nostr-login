// ─── NostrRpc ───────────────────────────────────────────────────────

import { finalizeEvent } from 'nostr-tools';
import { EventEmitter } from 'tseep';
import { PrivateKeySigner } from '../Signer';
import { NIP46_REQUEST_TIMEOUT } from '../../const';
import { RelayPool } from './RelayPool';
import type { NostrEvent, RpcRequest, RpcResponse, Filter } from './types';

export class NostrRpc extends EventEmitter {
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
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  }

  public async sendRequest(remotePubkey: string, method: string, params: string[] = [], kind = 24133, cb?: (res: RpcResponse) => void): Promise<RpcResponse> {
    const id = this.getId();

    this.setResponseHandler(id, cb);

    const event = await this.createRequestEvent(id, remotePubkey, method, params, kind);
    console.log('sendRequest', { event, method, remotePubkey, params });

    await this.pool.publish(event);

    return undefined as unknown as RpcResponse;
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
