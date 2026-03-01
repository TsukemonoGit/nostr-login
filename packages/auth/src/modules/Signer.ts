import { Nip44 } from '../utils/nip44';
import { getPublicKey, nip04, getEventHash, finalizeEvent, verifyEvent } from 'nostr-tools';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

/**
 * NDKPrivateKeySigner の代替。nostr-tools v2 を直接使用。
 * NIP-04 / NIP-44 暗号化と、イベント署名を提供する。
 *
 * 秘密鍵は hex 文字列で受け取り（LocalStorage互換）、内部で Uint8Array に変換する。
 */
export class PrivateKeySigner {
  private nip44Codec: Nip44 = new Nip44();
  /** hex文字列の秘密鍵 */
  public readonly privateKey: string;
  /** Uint8Array の秘密鍵 (nostr-tools v2 用) */
  private readonly _secretKey: Uint8Array;
  public readonly pubkey: string;

  constructor(privateKey: string) {
    this.privateKey = privateKey;
    this._secretKey = hexToBytes(privateKey);
    this.pubkey = getPublicKey(this._secretKey);
  }

  /** nostr-tools v2 でイベントに署名して sig を返す */
  async sign(event: any): Promise<string> {
    const template = {
      kind: event.kind as number,
      created_at: event.created_at as number,
      tags: event.tags as string[][],
      content: event.content as string,
    };
    const signed = finalizeEvent(template, this._secretKey);
    return signed.sig;
  }

  /** { pubkey } オブジェクトを返す（NDK互換の user() メソッド代替） */
  async user(): Promise<{ pubkey: string }> {
    return { pubkey: this.pubkey };
  }

  /** NIP-04 暗号化 */
  async encrypt(recipient: { pubkey: string }, plaintext: string): Promise<string> {
    return nip04.encrypt(this.privateKey, recipient.pubkey, plaintext);
  }

  /** NIP-04 復号 */
  async decrypt(sender: { pubkey: string }, ciphertext: string): Promise<string> {
    return nip04.decrypt(this.privateKey, sender.pubkey, ciphertext);
  }

  /** NIP-44 暗号化 */
  encryptNip44(recipient: { pubkey: string }, value: string): Promise<string> {
    return Promise.resolve(this.nip44Codec.encrypt(this.privateKey, recipient.pubkey, value));
  }

  /** NIP-44 復号 */
  decryptNip44(sender: { pubkey: string }, value: string): Promise<string> {
    return Promise.resolve(this.nip44Codec.decrypt(this.privateKey, sender.pubkey, value));
  }
}
