import { Nip44 } from '../utils/nip44';
import { getPublicKey, getEventHash, getSignature, nip04 } from 'nostr-tools';

export class PrivateKeySigner {
  private nip44: Nip44 = new Nip44();
  private _pubkey: string;
  public privateKey: string;

  constructor(privateKey: string) {
    this.privateKey = privateKey;
    this._pubkey = getPublicKey(privateKey);
  }

  get pubkey() {
    return this._pubkey;
  }

  async blockUntilReady() {
    return Promise.resolve();
  }

  async user() {
    return { pubkey: this.pubkey };
  }

  async sign(event: any): Promise<string> {
    // ensure event has created_at
    if (!event.created_at) event.created_at = Math.floor(Date.now() / 1000);
    // compute id and signature
    const id = getEventHash(event as any);
    event.id = id;
    const sig = getSignature(event as any, this.privateKey);
    event.sig = sig;
    return sig;
  }

  async encrypt(recipient: any, plaintext: string): Promise<string> {
    const pubkey = typeof recipient === 'string' ? recipient : recipient.pubkey;
    return nip04.encrypt(this.privateKey, pubkey, plaintext);
  }

  async decrypt(sender: any, ciphertext: string): Promise<string> {
    const pubkey = typeof sender === 'string' ? sender : sender.pubkey;
    return nip04.decrypt(this.privateKey, pubkey, ciphertext);
  }

  encryptNip44(recipient: any, value: string): Promise<string> {
    const pubkey = typeof recipient === 'string' ? recipient : recipient.pubkey;
    return Promise.resolve(this.nip44.encrypt(this.privateKey, pubkey, value));
  }

  decryptNip44(sender: any, value: string): Promise<string> {
    const pubkey = typeof sender === 'string' ? sender : sender.pubkey;
    return Promise.resolve(this.nip44.decrypt(this.privateKey, pubkey, value));
  }
}
