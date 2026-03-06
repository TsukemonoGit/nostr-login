// ─── IframeNostrRpc ─────────────────────────────────────────────────

import { validateEvent, verifyEvent } from 'nostr-tools';
import { RelayPool } from './RelayPool';
import { NostrRpc } from './NostrRpc';
import { PrivateKeySigner } from '../Signer';
import type { NostrEvent, RpcRequest, RpcResponse, Filter } from './types';

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

    return undefined as unknown as RpcResponse;
  }

  public override stop() {
    super.stop();
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }
}
