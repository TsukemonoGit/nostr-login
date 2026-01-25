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
  private signerAbortController?: AbortController;
  private readyPromise?: Promise<void>;
  private readyCallback?: () => void;
  private nip44Codec = new Nip44();
  private nostrConnectKey: string = '';
  private nostrConnectSecret: string = '';
  private iframe?: HTMLIFrameElement;
  private starterReady?: ReadyListener;
  // ★ 追加: 再接続関連のプロパティ
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private currentInfo?: Info;
  private isReconnecting: boolean = false;


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
    this.releaseSigner();
    this.resetAuth();
  }

  public cancelSignerInit() {
    if (this.signerAbortController) {
      this.signerAbortController.abort();
      this.signerAbortController = undefined;
    }
    if (this.signerErrCallback) {
      this.signerErrCallback('Cancelled by user');
      this.signerErrCallback = undefined;
    }
    // readyCallbackもクリアする
    this.resetAuth();
    this.emit('signerCancelled');
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
      pubkey: '', // unknown yet!
      signerPubkey: '', // unknown too!
      sk: this.nostrConnectKey,
      domain: domain,
      relays: relays,
      iframeUrl,
    };

    console.log('nostrconnect info', info, link);

    // non-iframe flow
    if (link && !iframeUrl) window.open(link, '_blank', 'width=400,height=700');

    // init nip46 signer
    await this.initSigner(info, { listen: true });

    // signer learns the remote pubkey
    if (!info.pubkey || !info.signerPubkey) throw new Error('Bad remote pubkey');

    // bunkerUrl\u306b\u5168\u30ea\u30ec\u30fc\u3092\u542b\u3081\u308b
    const relayParams = relays.map(r => `relay=${encodeURIComponent(r)}`).join('&');
    info.bunkerUrl = `bunker://${info.signerPubkey}?${relayParams}`;

    // callback
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

    // copy defaults
    const apps = NOSTRCONNECT_APPS.map(a => ({ ...a }));
    // if (this.params.optionsModal.dev) {
    //   apps.push({
    //     name: 'Dev.Nsec.app',
    //     domain: 'new.nsec.app',
    //     canImport: true,
    //     img: 'https://new.nsec.app/assets/favicon.ico',
    //     link: 'https://dev.nsec.app/<nostrconnect>',
    //     relay: 'wss://relay.nsec.app/',
    //   });
    // }

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
        // pass plain nc url for iframe-based flow
        a.link = nc;
      } else {
        // we will open popup ourselves
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
    // for OTP we choose interactive import
    if (this.params.userInfo?.authMethod === 'otp') return url + '&import=true';

    // for local we export our existing key
    if (!this.localSigner || this.params.userInfo?.authMethod !== 'local') throw new Error('Most be local keys');
    return url + '#import=' + nip19.nsecEncode(this.localSigner.privateKey!);
  }

  public async importAndConnect(cs: ConnectionString) {
    const { relay, domain, link, iframeUrl } = cs;
    if (!domain) throw new Error('Domain required');

    const info = await this.nostrConnect(relay, { domain, link, importConnect: true, iframeUrl });

    // logout to remove local keys from storage
    // but keep the connect signer
    await this.logout(/*keepSigner*/ true);

    // release local one
    this.localSigner = null;

    // notify app that we've switched to 'connect' keys
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
    await this.startAuth();
    await this.initSigner(info);
    this.onAuth('login', info);
    await this.endAuth();
  }

  public async createAccount(nip05: string) {
    const [name, domain] = nip05.split('@');

    // bunker's own url
    const bunkerUrl = await getBunkerUrl(`_@${domain}`, this.params.optionsModal);
    console.log("create account bunker's url", bunkerUrl);

    // parse bunker url and generate local nsec
    const info = bunkerUrlToInfo(bunkerUrl);
    if (!info.signerPubkey) throw new Error('Bad bunker url');

    const eventToAddAccount = Boolean(this.params.userInfo);

    // init signer to talk to the bunker (not the user!)
    await this.initSigner(info, { eventToAddAccount });

    const userPubkey = await this.signer!.createAccount2({ bunkerPubkey: info.signerPubkey!, name, domain, perms: this.params.optionsModal.perms });

    return {
      bunkerUrl: `bunker://${userPubkey}?relay=${info.relays?.[0]}`,
      sk: info.sk, // reuse the same local key
    };
  }

  private releaseSigner() {
    this.signer = null;
    this.signerErrCallback?.('cancelled');
    this.localSigner = null;

    // disconnect from signer relays
    for (const r of this.ndk.pool.relays.keys()) {
      this.ndk.pool.removeRelay(r);
    }
  }

  public async logout(keepSigner = false) {
    if (!keepSigner) this.releaseSigner();

    // move current to recent
    localStorageRemoveCurrentAccount();

    // notify everyone
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

    // make sure we emulate logout first
    if (info && this.params.userInfo && (info.pubkey !== this.params.userInfo.pubkey || info.authMethod !== this.params.userInfo.authMethod)) {
      const event = new CustomEvent('nlAuth', { detail: { type: 'logout' } });
      console.log('nostr-login auth', event.detail);
      document.dispatchEvent(event);
    }

    this.setUserInfo(info);

    if (info) {
      // async profile fetch
      fetchProfile(info, this.profileNdk).then(p => {
        if (this.params.userInfo !== info) return;

        const userInfo = {
          ...this.params.userInfo,
          picture: p?.image || p?.picture,
          name: p?.name || p?.displayName || p?.nip05 || nip19.npubEncode(info.pubkey),
          // NOTE: do not overwrite info.nip05 with the one from profile!
          // info.nip05 refers to nip46 provider,
          // profile.nip05 is just a fancy name that user has chosen
          // nip05: p?.nip05
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
        // reset
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

    // ensure iframe
    const url = new URL(iframeUrl);
    const domain = url.hostname;
    let iframe: HTMLIFrameElement | undefined;

    // one iframe per domain
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
      // iframe.setAttribute('sandbox', 'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts');
      iframe.id = id;
      document.body.append(iframe);
    }

    // wait until loaded
    iframe.setAttribute('src', iframeUrl);

    // we start listening right now to avoid races
    // with 'load' event below
    const ready = new ReadyListener(['workerReady', 'workerError'], url.origin);

    await new Promise(ok => {
      iframe!.addEventListener('load', ok);
    });

    // now make sure the iframe is ready,
    // timeout timer starts here
    const r = await ready.wait();

    // FIXME wait until the iframe is ready to accept requests,
    // maybe it should send us some message?

    console.log('nostr-login iframe ready', iframeUrl, r);

    return { iframe, port: r[1] as MessagePort };
  }

  // private async getIframeUrl(domain?: string) {
  //   if (!domain) return '';
  //   try {
  //     const r = await fetch(`https://${domain}/.well-known/nostr.json`);
  //     const data = await r.json();
  //     return data.nip46?.iframe_url || '';
  //   } catch (e) {
  //     console.log('failed to fetch iframe url', e, domain);
  //     return '';
  //   }
  // }

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

    // start the new promise
    this.readyPromise = new Promise<void>(ok => (this.readyCallback = ok));
  }

  public async endAuth() {
    console.log('endAuth', this.params.userInfo);
    if (this.params.userInfo && this.params.userInfo.iframeUrl) {
      // create iframe
      const { iframe, port } = (await this.createIframe(this.params.userInfo.iframeUrl)) || {};
      this.iframe = iframe;
      if (!this.iframe || !port) return;

      // assign iframe to RPC object
      (this.signer!.rpc as IframeNostrRpc).setWorkerIframePort(port);
    }

    this.readyCallback!();
    this.readyCallback = undefined;
  }

  public resetAuth() {
    if (this.readyCallback) this.readyCallback();
    this.readyCallback = undefined;
  }

  private async listen(info: Info) {
    if (!info.iframeUrl) return this.signer!.listen(this.nostrConnectSecret);
    const r = await this.starterReady!.wait();
    if (r[0] === 'starterError') throw new Error(r[1]);
    return this.signer!.setListenReply(r[1], this.nostrConnectSecret);
  }

  public async connect(info: Info, perms?: string) {
    return this.signer!.connect(info.token, perms);
  }

  public async initSigner(info: Info, { listen = false, connect = false, eventToAddAccount = false } = {}) {
    // mutex
    if (this.signerPromise) {
      try {
        await this.signerPromise;
      } catch {}
    }

    // we remove support for iframe from nip05 and bunker-url methods,
    // only nostrconnect flow will use it.
    // info.iframeUrl = info.iframeUrl || (await this.getIframeUrl(info.domain));
    console.log('initSigner info', info);

    // start listening for the ready signal
    const iframeOrigin = info.iframeUrl ? new URL(info.iframeUrl!).origin : undefined;
    if (iframeOrigin) this.starterReady = new ReadyListener(['starterDone', 'starterError'], iframeOrigin);

    // notify modals so they could show the starter iframe,
    // FIXME shouldn't this come from nostrconnect service list?
    this.emit('onIframeUrl', info.iframeUrl);

    // AbortControllerでキャンセル可能にする
    this.signerAbortController = new AbortController();
    const abortPromise = new Promise<never>((_, reject) => {
      this.signerAbortController!.signal.addEventListener('abort', () => {
        reject(new Error('Cancelled by user'));
      });
    });

    this.signerPromise = new Promise<void>(async (ok, err) => {
      this.signerErrCallback = err;
      try {
        // タイムアウトとキャンセルの両方に対応
        await Promise.race([this.initSignerInternal(info, listen, connect, eventToAddAccount, ok), abortPromise]);
      } catch (e) {
        console.log('initSigner failure', e);
        // make sure signer isn't set
        this.signer = null;
        this.signerAbortController = undefined;
        err(e);
      }
    });

    return this.signerPromise;
  }

  private async initSignerInternal(info: Info, listen: boolean, connect: boolean, eventToAddAccount: boolean, resolve: () => void) {
     // リレー接続
    if (info.relays && !info.iframeUrl) {
      for (const r of info.relays) {
        this.ndk.addExplicitRelay(r, undefined);
      }
    }

    await this.ndk.connect();

    const localSigner = new PrivateKeySigner(info.sk!);
    this.signer = new Nip46Signer(
      this.ndk, 
      localSigner, 
      info.signerPubkey!, 
      info.iframeUrl ? new URL(info.iframeUrl!).origin : undefined
    );

    // ★ 修正: connectionLost イベントハンドリングを統一
    this.signer.removeAllListeners?.('connectionLost');
    this.signer.once('connectionLost', () => {
      console.log('Connection lost detected');
      
      // ★ 再接続処理を呼び出す（非同期で実行、エラーは握りつぶさない）
      this.handleReconnection(info).catch(err => {
        console.error('Reconnection handling failed:', err);
        this.emit('reconnectFailed', err);
      });
    });

    // iframe restart は既存のまま
    this.signer.removeAllListeners?.('iframeRestart');
    this.signer.on('iframeRestart', async () => {
      const iframeUrl = info.iframeUrl + 
        (info.iframeUrl!.includes('?') ? '&' : '?') + 
        'pubkey=' + info.pubkey + '&rebind=' + localSigner.pubkey;
      this.emit('iframeRestart', { pubkey: info.pubkey, iframeUrl });
    });

    // authUrl は既存のまま
    this.signer.removeAllListeners?.('authUrl');
    this.signer.on('authUrl', (url: string) => {
      console.log('nostr login auth url', url);
      this.emit('onAuthUrl', { url, iframeUrl: info.iframeUrl, eventToAddAccount });
    });

    // 認証フロー
    if (listen) {
      await this.listen(info);
    } else if (connect) {
      await this.connect(info, this.params.optionsModal.perms);
    } else {
      await this.signer!.initUserPubkey(info.pubkey);
    }

    info.pubkey = this.signer!.userPubkey;
    info.signerPubkey = this.signer!.remotePubkey;

    // ★ 追加: 接続情報を保持
    this.currentInfo = info;

    this.signerAbortController = undefined;
    resolve();
  }

  // ★ 新規追加: 再接続処理の一元化
  private async handleReconnection(info: Info): Promise<void> {
    if (this.isReconnecting) {
      console.log('Already reconnecting, skipping...');
      return;
    }

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('Max reconnection attempts reached');
      this.emit('reconnectFailed');
      this.reconnectAttempts = 0;
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    try {
      console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}`);

      // 1. リレー再接続
      const stats = this.ndk.pool.stats();
      if (stats.connected === 0) {
        console.log('Reconnecting to relays...');
        
        // 既存のリレーを切断
        for (const relay of this.ndk.pool.relays.values()) {
          try {
            relay.disconnect();
          } catch (e) {
            console.log('Error disconnecting relay:', e);
          }
        }

        // リレー再追加
        if (info.relays) {
          for (const r of info.relays) {
            this.ndk.addExplicitRelay(r, undefined);
          }
        }

        // 接続待機
        await this.ndk.connect();
      }

      // 2. Signer ping確認
      if (this.signer) {
        await this.signer.reconnect(info);
      }

      // 成功
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      console.log('Reconnection successful');
      this.emit('reconnected');

    } catch (error) {
      console.error(`Reconnection attempt ${this.reconnectAttempts} failed:`, error);
      this.isReconnecting = false;

      // リトライ
      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        const delay = 2000 * this.reconnectAttempts; // 2秒, 4秒, 6秒
        console.log(`Retrying in ${delay}ms...`);
        
        setTimeout(() => {
          this.handleReconnection(info).catch(err => {
            console.error('Retry failed:', err);
          });
        }, delay);
      } else {
        this.emit('reconnectFailed');
        this.reconnectAttempts = 0;
      }
    }
  }

  // ★ 修正: ensureSigner の簡素化（リトライロジック削除）
  private async ensureSigner() {
    // signerがnullの場合のみ再初期化
    if (!this.signer && this.currentInfo) {
      console.log('Signer was destroyed, reinitializing...');
      await this.initSigner(this.currentInfo);
      return;
    }

    if (!this.signer) {
      throw new Error('No signer available');
    }

    // リレー接続確認（切断されていれば再接続試行）
    const stats = this.ndk.pool.stats();
    if (stats.connected === 0 && this.currentInfo) {
      console.log('NDK relays disconnected, attempting reconnection...');
      await this.handleReconnection(this.currentInfo);
    }
  }

  public async signEvent(event: any) {
    if (this.localSigner) {
      event.pubkey = getPublicKey(this.localSigner.privateKey!);
      event.id = getEventHash(event);
      event.sig = await this.localSigner.sign(event);
    } else {
      await this.ensureSigner();

      event.pubkey = this.signer!.remotePubkey;
      event.id = getEventHash(event);
      event.sig = await this.signer!.sign(event);
    }
    console.log('signed', { event });
    return event;
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
    if (this.localSigner) {
      return this.localSigner.encrypt(new NDKUser({ pubkey }), plaintext);
    } else {
      await this.ensureSigner();
      return this.signer!.encrypt(new NDKUser({ pubkey }), plaintext);
    }
  }

  public async decrypt04(pubkey: string, ciphertext: string) {
    if (this.localSigner) {
      return this.localSigner.decrypt(new NDKUser({ pubkey }), ciphertext);
    } else {
      // decrypt is broken in ndk v2.3.1, and latest
      // ndk v2.8.1 doesn't allow to override connect easily,
      // so we reimplement and fix decrypt here as a temporary fix
      await this.ensureSigner();
      return this.codec_call('nip04_decrypt', pubkey, ciphertext);
    }
  }

  public async encrypt44(pubkey: string, plaintext: string) {
    if (this.localSigner) {
      return this.nip44Codec.encrypt(this.localSigner.privateKey!, pubkey, plaintext);
    } else {
      // no support of nip44 in ndk yet
      await this.ensureSigner();
      return this.codec_call('nip44_encrypt', pubkey, plaintext);
    }
  }

  public async decrypt44(pubkey: string, ciphertext: string) {
    if (this.localSigner) {
      return this.nip44Codec.decrypt(this.localSigner.privateKey!, pubkey, ciphertext);
    } else {
      // no support of nip44 in ndk yet
      await this.ensureSigner();
      return this.codec_call('nip44_decrypt', pubkey, ciphertext);
    }
  }
}

export default AuthNostrService;
