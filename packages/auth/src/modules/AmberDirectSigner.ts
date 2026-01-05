import { AmberResponse } from '../types';
import { Signer } from './Nostr';

export class AmberDirectSigner implements Signer {
  private _pubkey: string;
  private static pendingResolves: Map<string, { resolve: (result: string) => void; timer: NodeJS.Timeout | null }> = new Map();

  constructor(pubkey: string = '') {
    this._pubkey = pubkey;
  }

  get pubkey() {
    return this._pubkey;
  }

  set pubkey(v: string) {
    this._pubkey = v;
  }

  public nip04 = {
    encrypt: (pubkey: string, plaintext: string) => this.encrypt04(pubkey, plaintext),
    decrypt: (pubkey: string, ciphertext: string) => this.decrypt04(pubkey, ciphertext),
  };

  public nip44 = {
    encrypt: (pubkey: string, plaintext: string) => this.encrypt44(pubkey, plaintext),
    decrypt: (pubkey: string, ciphertext: string) => this.decrypt44(pubkey, ciphertext),
  };

  public async getPublicKey(id?: string): Promise<string> {
    id = id || Math.random().toString(36).substring(7);
    const url = this.generateUrl('', 'get_public_key', id);
    console.log('Amber redirecting to:', url);
    window.open(url, '_blank', 'width=400,height=600');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        AmberDirectSigner.pendingResolves.delete(id!);
        reject(new Error('AmberDirectSigner timeout'));
      }, 20000);
      AmberDirectSigner.pendingResolves.set(id!, { resolve, timer });
    });
  }

  public async signEvent(event: any, id?: string): Promise<any> {
    id = id || Math.random().toString(36).substring(7);
    const url = this.generateUrl(JSON.stringify(event), 'sign_event', id);
    console.log('Amber redirecting to:', url);
    window.open(url, '_blank', 'width=400,height=600');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        AmberDirectSigner.pendingResolves.delete(id!);
        reject(new Error('AmberDirectSigner timeout'));
      }, 20000);
      AmberDirectSigner.pendingResolves.set(id!, {
        resolve: (result: string) => {
          try {
            resolve(JSON.parse(result));
          } catch (e) {
            resolve(result as any);
          }
        },
        timer,
      });
    });
  }

  public async encrypt04(pubkey: string, plaintext: string, id?: string): Promise<string> {
    id = id || Math.random().toString(36).substring(7);
    const url = this.generateUrl(plaintext, 'nip04_encrypt', id, pubkey);
    console.log('Amber redirecting to:', url);
    window.open(url, '_blank', 'width=400,height=600');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        AmberDirectSigner.pendingResolves.delete(id!);
        reject(new Error('AmberDirectSigner timeout'));
      }, 20000);
      AmberDirectSigner.pendingResolves.set(id!, { resolve, timer });
    });
  }

  public async decrypt04(pubkey: string, ciphertext: string, id?: string): Promise<string> {
    id = id || Math.random().toString(36).substring(7);
    const url = this.generateUrl(ciphertext, 'nip04_decrypt', id, pubkey);
    console.log('Amber redirecting to:', url);
    window.open(url, '_blank', 'width=400,height=600');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        AmberDirectSigner.pendingResolves.delete(id!);
        reject(new Error('AmberDirectSigner timeout'));
      }, 20000);
      AmberDirectSigner.pendingResolves.set(id!, { resolve, timer });
    });
  }

  public async encrypt44(pubkey: string, plaintext: string, id?: string): Promise<string> {
    id = id || Math.random().toString(36).substring(7);
    const url = this.generateUrl(plaintext, 'nip44_encrypt', id, pubkey);
    console.log('Amber redirecting to:', url);
    window.open(url, '_blank', 'width=400,height=600');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        AmberDirectSigner.pendingResolves.delete(id!);
        reject(new Error('AmberDirectSigner timeout'));
      }, 20000);
      AmberDirectSigner.pendingResolves.set(id!, { resolve, timer });
    });
  }

  public async decrypt44(pubkey: string, ciphertext: string, id?: string): Promise<string> {
    id = id || Math.random().toString(36).substring(7);
    const url = this.generateUrl(ciphertext, 'nip44_decrypt', id, pubkey);
    console.log('Amber redirecting to:', url);
    window.open(url, '_blank', 'width=400,height=600');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        AmberDirectSigner.pendingResolves.delete(id!);
        reject(new Error('AmberDirectSigner timeout'));
      }, 20000);
      AmberDirectSigner.pendingResolves.set(id!, { resolve, timer });
    });
  }

  public generateUrl(content: string, type: string, id: string, pubkey?: string): string {
    const callbackUrl = window.location.href.split('#')[0].split('?')[0];
    const encodedContent = encodeURIComponent(content || '');
    const encodedCallback = encodeURIComponent(callbackUrl);

    localStorage.setItem('amber_last_type', type);
    localStorage.setItem('amber_last_id', id);
    localStorage.setItem('amber_last_timestamp', Date.now().toString());

    // NIP-55準拠: nostrsigner: スキーム
    let url = `nostrsigner:${encodedContent}`;
    const params = new URLSearchParams();
    params.append('compressionType', 'none');
    params.append('returnType', 'signature');
    params.append('type', type);
    params.append('callbackUrl', callbackUrl);

    // 三重の冗長性でアプリ名を渡す
    const appName = document.title || window.location.hostname;
    params.append('name', appName);
    params.append('appName', appName);
    params.append('app', appName);

    // NIP-46互換のmetadata形式も追加
    const metadata = {
      name: appName,
      url: window.location.origin,
      description: 'Nostr Login provided by nostr-login library',
    };
    params.append('metadata', JSON.stringify(metadata));

    if (pubkey) params.append('pubkey', pubkey);
    if (this._pubkey) params.append('current_user', this._pubkey);

    return `${url}?${params.toString()}`;
  }

  // AmberDirectSigner.ts の parseResponse を拡張

  static parseResponse(): AmberResponse | null {
    const url = new URL(window.location.href);

    // パターン1: NIP-55標準 (?event=...)
    let result = url.searchParams.get('event');

    // パターン2: パス末尾にhexId (/<hexId>)
    if (!result) {
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        const lastPart = pathParts[pathParts.length - 1];
        // hexIdっぽい（64文字の16進数）
        if (/^[0-9a-f]{64}$/i.test(lastPart)) {
          result = lastPart;
        }
      }
    }

    if (result) {
      console.log('Amber response detection:', {
        href: window.location.href,
        eventParam: url.searchParams.get('event'),
        pathResult: result,
        sessionId: localStorage.getItem('amber_last_id'),
        sessionType: localStorage.getItem('amber_last_type'),
      });
    }

    if (!result) return null;

    const id = localStorage.getItem('amber_last_id');
    const type = localStorage.getItem('amber_last_type');

    localStorage.removeItem('amber_last_id');
    localStorage.removeItem('amber_last_type');
    localStorage.removeItem('amber_last_timestamp');

    if (id && type) {
      return { id, type, result };
    }

    return null;
  }

  static resolvePending(id: string, type: string, result: string): boolean {
    const entry = this.pendingResolves.get(id);
    if (entry) {
      this.pendingResolves.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(result);
      return true;
    }
    return false;
  }

  static cleanupPending() {
    for (const [id, entry] of this.pendingResolves) {
      try {
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve('');
      } catch (e) {
        // ignore
      }
    }
    this.pendingResolves.clear();
  }
}
