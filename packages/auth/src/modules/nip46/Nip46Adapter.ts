import { EventEmitter } from 'tseep';
import { Nip46Client } from './Nip46Client';
import { PrivateKeySigner } from '../Signer';

export class Nip46Adapter extends EventEmitter {
  private client: Nip46Client;
  private localSigner: PrivateKeySigner;
  public userPubkey: string = '';
  public remotePubkey: string;

  constructor(client: Nip46Client, localSigner: PrivateKeySigner) {
    super();
    this.client = client;
    this.localSigner = localSigner;
    this.remotePubkey = (client as any).remotePubkey || '';

    // forward events
    this.client.on('authUrl', (url: string) => {
      this.emit('authUrl', url);
    });
    this.client.on('response', ({ response, pubkey }: any) => {
      this.emit('response', response, pubkey);
    });
  }

  async initUserPubkey(hintPubkey?: string) {
    if (this.userPubkey) throw new Error('Already called initUserPubkey');
    if (hintPubkey) {
      this.userPubkey = hintPubkey;
      return;
    }

    const res = await this.client.sendRequest('get_public_key', []);
    if (!res) throw new Error('No public key returned');
    this.userPubkey = res;
  }

  async listen(nostrConnectSecret: string): Promise<string> {
    return new Promise<string>((ok, err) => {
      const onResponse = ({ response, pubkey }: any) => {
        if (!response) return;
        if (response.result === 'auth_url') return;
        if (response.result === 'ack' || response.result === nostrConnectSecret) {
          this.client.off('response', onResponse);
          ok(pubkey);
        }
      };

      this.client.on('response', onResponse);

      // also add a timeout
      setTimeout(() => {
        this.client.off('response', onResponse);
        err(new Error('Listen timeout'));
      }, 30000);
    });
  }

  async connect(token?: string, perms?: string) {
    const result = await this.client.sendRequest('connect', [this.localSigner.pubkey, token || '', perms || '']);
    if (result !== 'ack') throw new Error(result || 'connect failed');
  }

  async setListenReply(reply: any, nostrConnectSecret: string) {
    // reply is expected to be a raw event object; we'll try to parse its content
    // Attempt to decrypt via the client flow by treating it as a response
    try {
      const decoded = reply && reply.content ? JSON.parse(reply.content) : null;
      if (!decoded) throw new Error('Bad reply');
      if (decoded.result === nostrConnectSecret) {
        this.userPubkey = reply.pubkey;
      } else {
        throw new Error('Bad reply');
      }
    } catch (e) {
      throw new Error('Failed to set listen reply');
    }
  }

  async createAccount2({ bunkerPubkey, name, domain, perms = '' }: { bunkerPubkey: string; name: string; domain: string; perms?: string }) {
    const params = [name, domain, '', perms];

    const r = await this.client.sendRequest('create_account', params);
    if (!r) throw new Error('create_account failed');
    if (r === 'error') throw new Error('create_account error');
    return r;
  }

  async encrypt(recipientPubkey: string, plaintext: string) {
    const r = await this.client.sendRequest('nip04_encrypt', [recipientPubkey, plaintext]);
    return r;
  }

  async decrypt(recipientPubkey: string, ciphertext: string) {
    const r = await this.client.sendRequest('nip04_decrypt', [recipientPubkey, ciphertext]);
    return r;
  }

  async sign(event: any) {
    const r = await this.client.sendRequest('sign_event', [JSON.stringify(event)]);
    try {
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      if (parsed && parsed.sig) return parsed.sig;
    } catch (e) {
      // not JSON
    }
    return r;
  }

  // provide rpc compatibility
  get rpc() {
    return {
      sendRequest: async (remotePubkey: string, method: string, params: string[], kind: number, cb: (res: any) => void) => {
        try {
          const res = await this.client.sendRequest(method, params);
          cb({ result: res });
        } catch (err: any) {
          cb({ error: err.message });
        }
      },
    };
  }
}
