// packages/auth/src/modules/AuthNostrService.ts

import { localStorageAddAccount, bunkerUrlToInfo, isBunkerUrl, fetchProfile, getBunkerUrl, localStorageRemoveCurrentAccount, createProfile, getIcon } from '../utils';
import { ConnectionString, Info } from 'nostr-login-components/dist/types/types';
import { generatePrivateKey, getEventHash, getPublicKey, nip19 } from 'nostr-tools';
import { NostrLoginAuthOptions, Response } from '../types';
import NDK, { NDKEvent, NDKNip46Signer, NDKRpcResponse, NDKUser, NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrParams } from './';
import { EventEmitter } from 'tseep';
import { Signer } from './Nostr';
import { Nip44 } from '../utils/nip44';
import { IframeNostrRpc, Nip46Signer, ReadyListener } from './Nip46';
import { PrivateKeySigner } from './Signer';
import { DEFAULT_NIP46_RELAYS } from '../const';

const OUTBOX_RELAYS = ['wss://user.kindpag.es', 'wss://purplepag.es', 'wss://relay.nos.social'];

const NOSTRCONNECT_APPS: ConnectionString[] = [
  {
    name: 'Nsec.app',
    domain: 'nsec.app',
    canImport: true,
    img: 'https://nsec.app/assets/favicon.ico',
    link: 'https://use.nsec.app/<nostrconnect>',
  },
  {
    name: 'Amber',
    img: 'https://raw.githubusercontent.com/greenart7c3/Amber/refs/heads/master/assets/android-icon.svg',
    link: '<nostrconnect>',
  },
  {
    name: 'Other key stores',
    img: '',
    link: '<nostrconnect>',
  },
];

class AuthNostrService extends EventEmitter implements Signer {
  private ndk: NDK;
  private profileNdk: NDK;
  private signer: Nip46Signer | null = null;
  private localSigner: PrivateKeySigner | null = null;
  private params: NostrParams;
  private signerPromise?: Promise<void>;
  private signerErrCallback?: (err: string) => void;
  private readyPromise?: Promise<void>;
  private readyCallback?: () => void;
  private nip44Codec = new Nip44();
  private nostrConnectKey: string = '';
  private nostrConnectSecret: string = '';
  private iframe?: HTMLIFrameElement;
  private starterReady?: ReadyListener;

  nip04: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
  nip44: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };

  constructor(params: NostrParams) {
    super();
    this.params = params;
    this.ndk = new NDK({
      enableOutboxModel: false,
    });

    this.profileNdk = new NDK({
      enableOutboxModel: true,
      explicitRelayUrls: OUTBOX_RELAYS,
    });
    this.profileNdk.connect();

    this.nip04 = {
      encrypt: this.encrypt04.bind(this),
      decrypt: this.decrypt04.bind(this),
    };
    this.nip44 = {
      encrypt: this.encrypt44.bind(this),
      decrypt: this.decrypt44.bind(this),
    };
  }

  public isIframe() {
    return !!this.iframe;
  }

  public async waitReady() {
    if (this.signerPromise) {
      try {
        await this.signerPromise;
      } catch {}
    }

    if (this.readyPromise) {
      try {
        await this.readyPromise;
      } catch {}
    }
  }

  public cancelNostrConnect() {
    console.log('cancelNostrConnect called');
    this.releaseSigner();

    // readyCallbackのみ解放
    this.resetAuth();

    // signerPromiseのコールバックを呼んで中断
    if (this.signerErrCallback) {
      this.signerErrCallback('cancelled');
      this.signerErrCallback = undefined;
    }
  }

  // キャンセル用のエイリアス（互換性のため）
  public cancelSignerInit() {
    this.cancelNostrConnect();
  }

  public async nostrConnect(
    relay?: string,
    {
      domain = '',
      link = '',
      iframeUrl = '',
      importConnect = false,
      customRelays,
    }: {
      domain?: string;
      link?: string;
      importConnect?: boolean;
      iframeUrl?: string;
      customRelays?: string[];
    } = {},
  ) {
    // カスタムリレーが指定されていれば使用、そうでなければ単一リレーまたはデフォルト
    const relays = customRelays && customRelays.length > 0 ? customRelays : relay ? [relay] : DEFAULT_NIP46_RELAYS;

    const info: Info = {
      authMethod: 'connect',
      pubkey: '',
      signerPubkey: '',
      sk: this.nostrConnectKey,
      domain: domain,
      relays: relays,
      iframeUrl,
    };

    console.log('nostrconnect info', info, link);

    if (link && !iframeUrl) window.open(link, '_blank', 'width=400,height=700');

    try {
      await this.initSigner(info, { listen: true });
    } catch (e) {
      console.error('Failed to initialize signer:', e);
      throw new Error(`Connection failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }

    if (!info.pubkey || !info.signerPubkey) {
      throw new Error('Failed to get pubkey from signer');
    }

    const relayParams = relays.map(r => `relay=${encodeURIComponent(r)}`).join('&');
    info.bunkerUrl = `bunker://${info.signerPubkey}?${relayParams}`;

    if (!importConnect) this.onAuth('login', info);

    return info;
  }

  public async createNostrConnect() {
    this.nostrConnectKey = generatePrivateKey();
    this.nostrConnectSecret = Math.random().toString(36).substring(7);

    const pubkey = getPublicKey(this.nostrConnectKey);
    const meta = {
      name: encodeURIComponent(document.location.host),
      url: encodeURIComponent(document.location.origin),
      icon: encodeURIComponent(await getIcon()),
      perms: encodeURIComponent(this.params.optionsModal.perms || ''),
    };

    return `nostrconnect://${pubkey}?image=${meta.icon}&url=${meta.url}&name=${meta.name}&perms=${meta.perms}&secret=${this.nostrConnectSecret}`;
  }

  public async getNostrConnectServices(customRelays?: string[]): Promise<[string, ConnectionString[]]> {
    const nostrconnect = await this.createNostrConnect();

    const apps = NOSTRCONNECT_APPS.map(a => ({ ...a }));

    for (const a of apps) {
      let relays = customRelays && customRelays.length > 0 ? customRelays : DEFAULT_NIP46_RELAYS;
      if (a.link.startsWith('https://')) {
        let domain = a.domain || new URL(a.link).hostname;
        try {
          const info = await (await fetch(`https://${domain}/.well-known/nostr.json`)).json();
          const pubkey = info.names['_'];
          const fetchedRelays = info.nip46[pubkey] as string[];
          if (fetchedRelays && fetchedRelays.length && (!customRelays || customRelays.length === 0)) {
            relays = fetchedRelays;
          }
          a.iframeUrl = info.nip46.iframe_url || '';
        } catch (e) {
          console.log('Bad app info', e, a);
        }
      }
      const relayParams = relays.map(r => `&relay=${encodeURIComponent(r)}`).join('');
      const nc = nostrconnect + relayParams;
      if (a.iframeUrl) {
        a.link = nc;
      } else {
        a.link = a.link.replace('<nostrconnect>', nc);
      }
    }

    return [nostrconnect, apps];
  }

  public async localSignup(name: string, sk?: string) {
    const signup = !sk;
    sk = sk || generatePrivateKey();
    const pubkey = getPublicKey(sk);
    const info: Info = {
      pubkey,
      sk,
      name,
      authMethod: 'local',
    };
    console.log(`localSignup name: ${name}`);
    await this.setLocal(info, signup);
  }

  public async setLocal(info: Info, signup?: boolean) {
    this.releaseSigner();
    this.localSigner = new PrivateKeySigner(info.sk!);

    if (signup) await createProfile(info, this.profileNdk, this.localSigner, this.params.optionsModal.signupRelays, this.params.optionsModal.outboxRelays);

    this.onAuth(signup ? 'signup' : 'login', info);
  }

  public prepareImportUrl(url: string) {
    if (this.params.userInfo?.authMethod === 'otp') return url + '&import=true';

    if (!this.localSigner || this.params.userInfo?.authMethod !== 'local') throw new Error('Most be local keys');
    return url + '#import=' + nip19.nsecEncode(this.localSigner.privateKey!);
  }

  public async importAndConnect(cs: ConnectionString) {
    const { relay, domain, link, iframeUrl } = cs;
    if (!domain) throw new Error('Domain required');

    const info = await this.nostrConnect(relay, { domain, link, importConnect: true, iframeUrl });

    await this.logout(/*keepSigner*/ true);

    this.localSigner = null;

    this.onAuth('login', info);
  }

  public setReadOnly(pubkey: string) {
    const info: Info = { pubkey, authMethod: 'readOnly' };
    this.onAuth('login', info);
  }

  public setExtension(pubkey: string) {
    const info: Info = { pubkey, authMethod: 'extension' };
    this.onAuth('login', info);
  }

  public setOTP(pubkey: string, data: string) {
    const info: Info = { pubkey, authMethod: 'otp', otpData: data };
    this.onAuth('login', info);
  }

  public async setConnect(info: Info) {
    this.releaseSigner();

    try {
      await this.startAuth();
      await this.initSigner(info, { connect: true });

      // signerが正しく初期化されたか確認
      if (!info.pubkey || !info.signerPubkey) {
        throw new Error('Failed to initialize signer: missing pubkey');
      }

      this.onAuth('login', info);
      await this.endAuth();
    } catch (e) {
      console.error('Failed to set connect:', e);
      this.resetAuth();
      this.releaseSigner(); // signerもクリーンアップ
      throw e;
    }
  }

  public async createAccount(nip05: string) {
    const [name, domain] = nip05.split('@');

    const bunkerUrl = await getBunkerUrl(`_@${domain}`, this.params.optionsModal);
    console.log("create account bunker's url", bunkerUrl);

    const info = bunkerUrlToInfo(bunkerUrl);
    if (!info.signerPubkey) throw new Error('Bad bunker url');

    const eventToAddAccount = Boolean(this.params.userInfo);

    await this.initSigner(info, { eventToAddAccount });

    const userPubkey = await this.signer!.createAccount2({ bunkerPubkey: info.signerPubkey!, name, domain, perms: this.params.optionsModal.perms });

    return {
      bunkerUrl: `bunker://${userPubkey}?relay=${info.relays?.[0]}`,
      sk: info.sk,
    };
  }

  private releaseSigner() {
    console.log('releaseSigner called');
    // RPC subscriptionを停止
    if (this.signer && this.signer.rpc) {
      try {
        (this.signer.rpc as any).stop?.();
      } catch (e) {
        console.warn('Failed to stop RPC subscription', e);
      }
    }

    // signerを削除
    this.signer = null;

    // signerPromiseのコールバックを呼んで中断
    if (this.signerErrCallback) {
      this.signerErrCallback('cancelled');
      this.signerErrCallback = undefined;
    }

    this.localSigner = null;

    // relayから切断
    for (const r of this.ndk.pool.relays.keys()) {
      this.ndk.pool.removeRelay(r);
    }

    // signerPromiseをリセット
    this.signerPromise = undefined;
  }

  public async logout(keepSigner = false) {
    if (!keepSigner) this.releaseSigner();

    localStorageRemoveCurrentAccount();

    this.onAuth('logout');

    this.emit('updateAccounts');
  }

  private setUserInfo(userInfo: Info | null) {
    this.params.userInfo = userInfo;
    this.emit('onUserInfo', userInfo);

    if (userInfo) {
      localStorageAddAccount(userInfo);
      this.emit('updateAccounts');
    }
  }

  public exportKeys() {
    if (!this.params.userInfo) return '';
    if (this.params.userInfo.authMethod !== 'local') return '';
    return nip19.nsecEncode(this.params.userInfo.sk!);
  }

  private onAuth(type: 'login' | 'signup' | 'logout', info: Info | null = null) {
    if (type !== 'logout' && !info) throw new Error('No user info in onAuth');

    if (info && this.params.userInfo && (info.pubkey !== this.params.userInfo.pubkey || info.authMethod !== this.params.userInfo.authMethod)) {
      const event = new CustomEvent('nlAuth', { detail: { type: 'logout' } });
      console.log('nostr-login auth', event.detail);
      document.dispatchEvent(event);
    }

    this.setUserInfo(info);

    if (info) {
      fetchProfile(info, this.profileNdk).then(p => {
        if (this.params.userInfo !== info) return;

        const userInfo = {
          ...this.params.userInfo,
          picture: p?.image || p?.picture,
          name: p?.name || p?.displayName || p?.nip05 || nip19.npubEncode(info.pubkey),
        };

        this.setUserInfo(userInfo);
      });
    }

    try {
      const npub = info ? nip19.npubEncode(info.pubkey) : '';

      const options: NostrLoginAuthOptions = {
        type,
      };

      if (type === 'logout') {
        if (this.iframe) this.iframe.remove();
        this.iframe = undefined;
      } else {
        options.pubkey = info!.pubkey;
        options.name = info!.name;

        if (info!.sk) {
          options.localNsec = nip19.nsecEncode(info!.sk);
        }

        if (info!.relays) {
          options.relays = info!.relays;
        }

        if (info!.otpData) {
          options.otpData = info!.otpData;
        }

        options.method = info!.authMethod || 'connect';
      }

      const event = new CustomEvent('nlAuth', { detail: options });
      console.log('nostr-login auth', options);
      document.dispatchEvent(event);

      if (this.params.optionsModal.onAuth) {
        this.params.optionsModal.onAuth(npub, options);
      }
    } catch (e) {
      console.log('onAuth error', e);
    }
  }

  private async createIframe(iframeUrl?: string) {
    if (!iframeUrl) return undefined;

    const url = new URL(iframeUrl);
    const domain = url.hostname;
    let iframe: HTMLIFrameElement | undefined;

    const did = domain.replaceAll('.', '-');
    const id = '__nostr-login-worker-iframe-' + did;
    iframe = document.querySelector(`#${id}`) as HTMLIFrameElement;
    console.log('iframe', id, iframe);
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.setAttribute('width', '0');
      iframe.setAttribute('height', '0');
      iframe.setAttribute('border', '0');
      iframe.style.display = 'none';
      iframe.id = id;
      document.body.append(iframe);
    }

    iframe.setAttribute('src', iframeUrl);

    const ready = new ReadyListener(['workerReady', 'workerError'], url.origin);

    await new Promise(ok => {
      iframe!.addEventListener('load', ok);
    });

    const r = await ready.wait();

    console.log('nostr-login iframe ready', iframeUrl, r);

    return { iframe, port: r[1] as MessagePort };
  }

  public async sendNeedAuth() {
    const [nostrconnect] = await this.getNostrConnectServices();
    const event = new CustomEvent('nlNeedAuth', { detail: { nostrconnect } });
    console.log('nostr-login need auth', nostrconnect);
    document.dispatchEvent(event);
  }

  public isAuthing() {
    return !!this.readyCallback;
  }

  public async startAuth() {
    console.log('startAuth');
    if (this.readyCallback) throw new Error('Already started');

    this.readyPromise = new Promise<void>(ok => (this.readyCallback = ok));
  }

  public async endAuth() {
    console.log('endAuth', this.params.userInfo);
    if (this.params.userInfo && this.params.userInfo.iframeUrl) {
      const { iframe, port } = (await this.createIframe(this.params.userInfo.iframeUrl)) || {};
      this.iframe = iframe;
      if (!this.iframe || !port) return;

      (this.signer!.rpc as IframeNostrRpc).setWorkerIframePort(port);
    }

    if (this.readyCallback) {
      this.readyCallback();
      this.readyCallback = undefined;
    }
  }

  public resetAuth() {
    if (this.readyCallback) {
      this.readyCallback();
      this.readyCallback = undefined;
    }
  }

  private async listen(info: Info) {
    if (!info.iframeUrl) return this.signer!.listen(this.nostrConnectSecret);
    const r = await this.starterReady!.wait();
    if (r[0] === 'starterError') throw new Error(r[1]);
    return this.signer!.setListenReply(r[1], this.nostrConnectSecret);
  }

  public async connect(info: Info, perms?: string) {
    // 修正: reconnect -> connect
    return this.signer!.connect(info.token, perms);
  }

  public async initSigner(info: Info, { listen = false, connect = false, eventToAddAccount = false } = {}) {
    // 既存のsignerPromiseがあれば待機
    if (this.signerPromise) {
      try {
        await this.signerPromise;
      } catch (e) {
        // キャンセルされた場合は無視
        if (e !== 'cancelled') {
          console.error('Previous signer promise failed:', e);
        }
      }
    }

    console.log('initSigner info', info);

    const iframeOrigin = info.iframeUrl ? new URL(info.iframeUrl!).origin : undefined;
    if (iframeOrigin) this.starterReady = new ReadyListener(['starterDone', 'starterError'], iframeOrigin);

    this.emit('onIframeUrl', info.iframeUrl);

    this.signerPromise = new Promise<void>(async (ok, err) => {
      this.signerErrCallback = error => {
        console.log('Signer initialization cancelled or failed:', error);
        err(error);
      };

      try {
        if (info.relays && !info.iframeUrl) {
          for (const r of info.relays) {
            this.ndk.addExplicitRelay(r, undefined);
          }
        }

        await this.ndk.connect();

        const localSigner = new PrivateKeySigner(info.sk!);
        this.signer = new Nip46Signer(this.ndk, localSigner, info.signerPubkey!, iframeOrigin);

        this.signer.on(`iframeRestart`, async () => {
          const iframeUrl = info.iframeUrl + (info.iframeUrl!.includes('?') ? '&' : '?') + 'pubkey=' + info.pubkey + '&rebind=' + localSigner.pubkey;
          this.emit('iframeRestart', { pubkey: info.pubkey, iframeUrl });
        });

        this.signer.on('authUrl', (url: string) => {
          console.log('nostr login auth url', url);
          this.emit('onAuthUrl', { url, iframeUrl: info.iframeUrl, eventToAddAccount });
        });

        if (listen) {
          await this.listen(info);
        } else if (connect) {
          await this.connect(info, this.params.optionsModal.perms);
        } else {
          await this.signer!.initUserPubkey(info.pubkey);
        }

        info.pubkey = this.signer!.userPubkey;
        info.signerPubkey = this.signer!.remotePubkey;

        console.log('Signer initialized successfully. User pubkey:', info.pubkey, 'Signer pubkey:', info.signerPubkey);

        // コールバックをクリア（正常終了したので不要）
        this.signerErrCallback = undefined;
        ok();
      } catch (e) {
        console.error('initSigner failure', e);
        this.signer = null;
        this.signerErrCallback = undefined;
        err(e);
      }
    });

    return this.signerPromise;
  }

  public async authNip46(
    type: 'login' | 'signup',
    {
      name,
      bunkerUrl,
      sk = '',
      domain = '',
      iframeUrl = '',
      customRelays,
    }: { name: string; bunkerUrl: string; sk?: string; domain?: string; iframeUrl?: string; customRelays?: string[] },
  ) {
    try {
      const info = bunkerUrlToInfo(bunkerUrl, sk);
      if (isBunkerUrl(name)) info.bunkerUrl = name;
      else {
        info.nip05 = name;
        info.domain = name.split('@')[1];
      }
      if (domain) info.domain = domain;
      if (iframeUrl) info.iframeUrl = iframeUrl;

      // カスタムリレーが指定されていれば使用する
      if (customRelays && customRelays.length > 0) {
        info.relays = customRelays;
      }

      if (!info.signerPubkey || !info.sk || !info.relays?.[0]) {
        throw new Error(`Bad bunker url ${bunkerUrl}`);
      }

      const eventToAddAccount = Boolean(this.params.userInfo);
      console.log('authNip46', type, info);

      await this.initSigner(info, { connect: true, eventToAddAccount });

      this.onAuth(type, info);
    } catch (e) {
      console.error('nostr login auth failed', e);
      throw e;
    }
  }

  public async signEvent(event: any) {
    // リレー接続を確認して切れていたら再接続
    await this.ensureRelayConnection();

    if (this.localSigner) {
      event.pubkey = getPublicKey(this.localSigner.privateKey!);
      event.id = getEventHash(event);
      event.sig = await this.localSigner.sign(event);
    } else {
      event.pubkey = this.signer?.remotePubkey;
      event.id = getEventHash(event);
      event.sig = await this.signer?.sign(event);
    }
    console.log('signed', { event });
    return event;
  }

  private async ensureRelayConnection() {
    // リレーに接続されているか確認
    const connected = Array.from(this.ndk.pool.relays.values()).some(relay => relay.status === 1); // 1 = CONNECTED

    if (!connected) {
      console.log('Relay disconnected, reconnecting...');
      await this.ndk.connect();
    }
  }

  private async codec_call(method: string, pubkey: string, param: string) {
    return new Promise<string>((resolve, reject) => {
      this.signer!.rpc.sendRequest(this.signer!.remotePubkey!, method, [pubkey, param], 24133, (response: NDKRpcResponse) => {
        if (!response.error) {
          resolve(response.result);
        } else {
          reject(response.error);
        }
      });
    });
  }

  public async encrypt04(pubkey: string, plaintext: string) {
    await this.ensureRelayConnection();

    if (this.localSigner) {
      return this.localSigner.encrypt(new NDKUser({ pubkey }), plaintext);
    } else {
      return this.signer!.encrypt(new NDKUser({ pubkey }), plaintext);
    }
  }

  public async decrypt04(pubkey: string, ciphertext: string) {
    await this.ensureRelayConnection();

    if (this.localSigner) {
      return this.localSigner.decrypt(new NDKUser({ pubkey }), ciphertext);
    } else {
      return this.codec_call('nip04_decrypt', pubkey, ciphertext);
    }
  }

  public async encrypt44(pubkey: string, plaintext: string) {
    await this.ensureRelayConnection();

    if (this.localSigner) {
      return this.nip44Codec.encrypt(this.localSigner.privateKey!, pubkey, plaintext);
    } else {
      return this.codec_call('nip44_encrypt', pubkey, plaintext);
    }
  }

  public async decrypt44(pubkey: string, ciphertext: string) {
    await this.ensureRelayConnection();

    if (this.localSigner) {
      return this.nip44Codec.decrypt(this.localSigner.privateKey!, pubkey, ciphertext);
    } else {
      return this.codec_call('nip44_decrypt', pubkey, ciphertext);
    }
  }
}

export default AuthNostrService;
