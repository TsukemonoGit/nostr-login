// ─── Nip46Signer ────────────────────────────────────────────────────

import { EventEmitter } from 'tseep';
import { RelayPool } from './RelayPool';
import { IframeNostrRpc } from './IframeNostrRpc';
import { Nip46Error } from './errors';
import { PrivateKeySigner } from '../Signer';
import type { RpcResponse } from './types';

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

  /**
   * NIP-46 ping — signer の死活確認
   */
  public async ping(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.rpc.sendRequest(this.bunkerPubkey, 'ping', [], 24133, (response: RpcResponse) => {
        if (response.error) {
          reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
        } else {
          resolve(response.result === 'pong');
        }
      });
    });
  }

  /**
   * NIP-46 switch_relays — リレーリストの更新
   * Spec: 接続確立後に client が即時送信、signer が relay リストを返す
   */
  public async switchRelays(): Promise<string[] | null> {
    return new Promise<string[] | null>((resolve, reject) => {
      this.rpc.sendRequest(this.bunkerPubkey, 'switch_relays', [], 24133, (response: RpcResponse) => {
        if (response.error) {
          reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
        } else {
          // result は JSON 文字列: ["wss://...", ...] または "null"
          try {
            const parsed = JSON.parse(response.result);
            resolve(Array.isArray(parsed) ? parsed : null);
          } catch {
            resolve(null);
          }
        }
      });
    });
  }

  /**
   * NIP-46 logout — リモート signer にセッション終了を通知
   */
  public async logout(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.rpc.sendRequest(this.bunkerPubkey, 'logout', [], 24133, (response: RpcResponse) => {
        if (response.error) {
          reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * NIP-46 remote encrypt (NIP-44)
   */
  public async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.rpc.sendRequest(this.bunkerPubkey, 'nip44_encrypt', [recipientPubkey, plaintext], 24133, (response: RpcResponse) => {
        if (response.error) {
          reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
        } else {
          resolve(response.result);
        }
      });
    });
  }

  /**
   * NIP-46 remote decrypt (NIP-44)
   */
  public async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.rpc.sendRequest(this.bunkerPubkey, 'nip44_decrypt', [senderPubkey, ciphertext], 24133, (response: RpcResponse) => {
        if (response.error) {
          reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
        } else {
          resolve(response.result);
        }
      });
    });
  }

  /**
   * @deprecated NIP-46 spec から create_account は別 NIP へ移動済み。
   * 将来的に削除されます。
   */
  public async createAccount2({ bunkerPubkey, name, domain, perms = '' }: { bunkerPubkey: string; name: string; domain: string; perms?: string }) {
    console.warn('[DEPRECATED] createAccount2 is deprecated per NIP-46 spec. Will be removed in a future version.');
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
