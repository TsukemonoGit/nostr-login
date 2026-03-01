import { NDKPrivateKeySigner, NDKUser } from '@nostr-dev-kit/ndk';
import { Nip44 } from '../utils/nip44';
import { getPublicKey } from 'nostr-tools';

export class PrivateKeySigner extends NDKPrivateKeySigner {
  private nip44: Nip44 = new Nip44();
  private _derivedPubkey: string;

  constructor(privateKey: string) {
    super(privateKey);
    this._derivedPubkey = getPublicKey(privateKey);
  }

  override get pubkey() {
    return this._derivedPubkey;
  }

  encryptNip44(recipient: NDKUser, value: string): Promise<string> {
    return Promise.resolve(this.nip44.encrypt(this.privateKey!, recipient.pubkey, value));
  }

  decryptNip44(sender: NDKUser, value: string): Promise<string> {
    return Promise.resolve(this.nip44.decrypt(this.privateKey!, sender.pubkey, value));
  }
}
