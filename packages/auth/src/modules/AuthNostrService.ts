// packages/auth/src/modules/AuthNostrService.ts
// rx-nostr ベースのリレー管理 + NIP-46 RPC 実装

import { localStorageAddAccount, bunkerUrlToInfo, isBunkerUrl, fetchProfile, getBunkerUrl, localStorageRemoveCurrentAccount, createProfile, getIcon } from '../utils';
import { ConnectionString, Info } from '@konemono/nostr-login-components/dist/types/types';
import { generateSecretKey, getPublicKey, getEventHash, nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { NostrLoginAuthOptions, Response } from '../types';
import { NostrParams } from './';
import { EventEmitter } from 'tseep';
import { Signer } from './Nostr';
import { Nip44 } from '../utils/nip44';
import { IframeNostrRpc, Nip46Signer, Nip46Error, ReadyListener, RelayPool, RpcResponse } from './nip46';
import { PrivateKeySigner } from './Signer';
import { DEFAULT_NIP46_RELAYS, OUTBOX_RELAYS, NOSTRCONNECT_APPS } from '../const';
import { fetchNostrJson } from '../utils/nostrJson';
import { RelayHealthManager } from './RelayHealthManager';

/** hex 文字列の秘密鍵を生成する (nostr-tools v2 互換) */
function generatePrivateKey(): string {
  return bytesToHex(generateSecretKey());
}

class AuthNostrService extends EventEmitter implements Signer {
  private pool: RelayPool;
  private profilePool: RelayPool;
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
  private relayHealth: RelayHealthManager;

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

    this.pool = new RelayPool();

    this.profilePool = new RelayPool();
    for (const r of OUTBOX_RELAYS) {
      this.profilePool.addRelay(r);
    }
    // rx-nostr は lazy-keep 戦略により subscription/send 時に自動接続する

    this.nip04 = {
      encrypt: this.encrypt04.bind(this),
      decrypt: this.decrypt04.bind(this),
    };
    this.nip44 = {
      encrypt: this.encrypt44.bind(this),
      decrypt: this.decrypt44.bind(this),
    };

    this.relayHealth = new RelayHealthManager({
      pool: this.pool,
      getRpc: () => this.signer?.rpc ?? null,
      getUserInfo: () => this.params.userInfo,
    });
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
    this.resetNostrConnectKeys();

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

  /**
   * signerインスタンスを保持したまま、進行中のRPCリクエストだけキャンセルする。
   */
  public cancelPendingRequests() {
    console.log('cancelPendingRequests called (signer preserved)');
    if (this.signer && this.signer.rpc) {
      try {
        (this.signer.rpc as any).clearPendingRequests?.();
      } catch (e) {
        console.warn('Failed to clear pending requests', e);
      }
    }
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
    console.log('[nostrConnect] Called', { relay, domain, link, iframeUrl, importConnect, customRelays });

    // linkのnostrconnect URLからリレーヒントを抽出
    let linkRelays: string[] = [];
    if (link) {
      try {
        const ncMatch = link.match(/nostrconnect:\/\/[^?]*\?(.*)/);
        if (ncMatch) {
          const params = new URLSearchParams(ncMatch[1]);
          linkRelays = params.getAll('relay');
        }
      } catch (e) {
        console.warn('[nostrConnect] Failed to parse relay hints from link', e);
      }
    }

    const relays = customRelays && customRelays.length > 0 ? customRelays : linkRelays.length > 0 ? linkRelays : relay ? [relay] : DEFAULT_NIP46_RELAYS;

    const info: Info = {
      authMethod: 'connect',
      pubkey: '',
      signerPubkey: '',
      sk: this.nostrConnectKey,
      domain: domain,
      relays: relays,
      iframeUrl,
    };

    console.log('[nostrConnect] Created info', info, link);

    if (link && !iframeUrl) {
      console.log('[nostrConnect] Opening Amber');
      window.open(link, '_blank', 'width=400,height=700');
    }

    try {
      console.log('[nostrConnect] Calling initSigner with listen=true');
      await this.initSigner(info, { listen: true });

      // initSigner が完了するまで待機（signerPromise の完了を待つ）
      if (this.signerPromise) {
        console.log('[nostrConnect] Waiting for signerPromise to complete');
        await this.signerPromise;
        console.log('[nostrConnect] signerPromise completed');
      }
    } catch (e) {
      console.error('[nostrConnect] Failed to initialize signer:', e);
      throw new Error(`Connection failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }

    console.log('[nostrConnect] Checking pubkeys', { pubkey: info.pubkey, signerPubkey: info.signerPubkey });

    if (!info.pubkey || !info.signerPubkey) {
      console.error('[nostrConnect] Missing pubkeys after initialization');
      throw new Error('Failed to get pubkey from signer');
    }

    const relayParams = relays.map(r => `relay=${encodeURIComponent(r)}`).join('&');
    info.bunkerUrl = `bunker://${info.signerPubkey}?${relayParams}`;
    console.log('[nostrConnect] Generated bunkerUrl', info.bunkerUrl);

    if (!importConnect) {
      console.log('[nostrConnect] Calling onAuth');
      this.onAuth('login', info);
    }

    // 接続成功後にkey/secretをリセット（次回のモーダル表示で新規生成される）
    this.resetNostrConnectKeys();

    console.log('[nostrConnect] Completed successfully');
    return info;
  }

  public async createNostrConnect(relays: string[]) {
    this.ensureNostrConnectKeys();
    return this.buildNostrConnectUrl(relays);
  }

  /**
   * key/secret が未生成なら新規生成する。既存なら再利用。
   * モーダル表示中にリレーが変更されても key/secret は維持される。
   */
  private ensureNostrConnectKeys() {
    if (!this.nostrConnectKey) {
      this.nostrConnectKey = generatePrivateKey();
    }
    if (!this.nostrConnectSecret) {
      this.nostrConnectSecret = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    }
  }

  /**
   * 現在の key/secret を使って nostrconnect:// URL を構築する。
   */
  private async buildNostrConnectUrl(relays: string[]): Promise<string> {
    const pubkey = getPublicKey(hexToBytes(this.nostrConnectKey));
    const meta = {
      name: encodeURIComponent(document.location.host),
      url: encodeURIComponent(document.location.origin),
      icon: encodeURIComponent(await getIcon()),
      perms: encodeURIComponent(this.params.optionsModal.perms || ''),
    };

    const relayParams = relays.map(r => `&relay=${encodeURIComponent(r)}`).join('');
    return `nostrconnect://${pubkey}?image=${meta.icon}&url=${meta.url}&name=${meta.name}&perms=${meta.perms}&secret=${this.nostrConnectSecret}${relayParams}`;
  }

  /**
   * nostrconnect セッションをリセットし、key/secret を再生成可能にする。
   */
  public resetNostrConnectKeys() {
    this.nostrConnectKey = '';
    this.nostrConnectSecret = '';
  }

  public async getNostrConnectServices(customRelays?: string[], onUpdate?: (apps: ConnectionString[]) => void): Promise<[string, ConnectionString[]]> {
    const defaultRelays = customRelays && customRelays.length > 0 ? customRelays : DEFAULT_NIP46_RELAYS;
    // ベースURLにリレーヒントを含める
    const nostrconnect = await this.createNostrConnect(defaultRelays);

    const apps: ConnectionString[] = NOSTRCONNECT_APPS.map(a => ({ ...a }));

    // Build initial list: https services are 'loading', others are immediately available
    for (const a of apps) {
      if (a.link.startsWith('https://')) {
        a.available = 'loading';
        // nostrconnect URL にはすでにリレーヒントが含まれている
        a.link = nostrconnect;
      } else {
        a.available = true;
        a.link = a.link.replace('<nostrconnect>', nostrconnect);
      }
    }

    // Notify caller with initial state (services visible immediately)
    if (onUpdate) onUpdate([...apps.map(a => ({ ...a }))]);

    // Fetch nostr.json for each service that needs it, update individually
    const fetchPromises = apps
      .filter(a => a.available === 'loading')
      .map(async a => {
        const domain = a.domain || '';
        try {
          const info = await fetchNostrJson(domain);
          const pubkey = info.names['_'];
          const fetchedRelays = info.nip46[pubkey] as string[];
          a.iframeUrl = info.nip46.iframe_url || '';
          // サービス固有のリレーがあればURLを再構築
          if (fetchedRelays && fetchedRelays.length && (!customRelays || customRelays.length === 0)) {
            const serviceNostrconnect = this.replaceRelayHints(nostrconnect, fetchedRelays);
            a.link = a.iframeUrl ? serviceNostrconnect : a.link;
          } else {
            a.link = a.iframeUrl ? nostrconnect : a.link;
          }
          a.available = true;
        } catch (e) {
          console.log('Service unavailable', domain, e);
          a.available = false;
        }
        if (onUpdate) onUpdate([...apps.map(x => ({ ...x }))]);
      });

    await Promise.all(fetchPromises);

    return [nostrconnect, apps];
  }

  private replaceRelayHints(nostrconnectUrl: string, newRelays: string[]): string {
    // 既存のrelay=パラメータを除去して新しいリレーに置換
    const url = new URL(nostrconnectUrl);
    url.searchParams.delete('relay');
    for (const r of newRelays) {
      url.searchParams.append('relay', r);
    }
    return url.toString();
  }

  public async localSignup(name: string, sk?: string) {
    const signup = !sk;
    sk = sk || generatePrivateKey();
    const pubkey = getPublicKey(hexToBytes(sk));
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

    if (signup) await createProfile(info, this.profilePool, this.localSigner, this.params.optionsModal.signupRelays, this.params.optionsModal.outboxRelays);

    this.onAuth(signup ? 'signup' : 'login', info);
  }

  public prepareImportUrl(url: string) {
    if (this.params.userInfo?.authMethod === 'otp') return url + '&import=true';

    if (!this.localSigner || this.params.userInfo?.authMethod !== 'local') throw new Error('Most be local keys');
    return url + '#import=' + nip19.nsecEncode(hexToBytes(this.localSigner.privateKey!));
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
      this.releaseSigner();
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
    // RPC pending requestsをクリア
    if (this.signer && this.signer.rpc) {
      try {
        (this.signer.rpc as any).clearPendingRequests?.();
      } catch (e) {
        console.warn('Failed to clear pending requests', e);
      }
      // RPC subscriptionを停止
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
    this.pool.removeAllRelays();

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
    return nip19.nsecEncode(hexToBytes(this.params.userInfo.sk!));
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
      fetchProfile(info, this.profilePool).then(p => {
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
          options.localNsec = nip19.nsecEncode(hexToBytes(info!.sk));
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
    if (this.readyCallback) {
      console.log('startAuth: previous auth still active, cancelling it first');
      this.cancelNostrConnect();
    }

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
    return this.signer!.connect(info.token, perms);
  }

  public async initSigner(info: Info, { listen = false, connect = false, eventToAddAccount = false } = {}) {
    // 既存のsignerPromiseがあれば待機
    if (this.signerPromise) {
      try {
        await this.signerPromise;
      } catch (e) {
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
            this.pool.addRelay(r);
          }
        }

        // rx-nostr は lazy-keep 戦略で subscribe/send 時に自動接続する

        const localSigner = new PrivateKeySigner(info.sk!);
        this.signer = new Nip46Signer(this.pool, localSigner, info.signerPubkey!, iframeOrigin);

        this.signer.on('iframeRestart', async () => {
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

        info.pubkey = this.signer!.userPubkey as string;
        info.signerPubkey = this.signer!.bunkerPubkey;

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
    if (this.localSigner) {
      event.pubkey = this.localSigner.pubkey;
      event.id = getEventHash(event);
      event.sig = await this.localSigner.sign(event);
      console.log('signed (local)', { event });
      return event;
    }

    // NIP-46 署名: リトライ付き
    const maxRetries = 2;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (!this.signer) {
          throw new Error('Signer is not initialized. Please reconnect.');
        }
        await this.ensureRelayConnection();
        event.pubkey = this.signer.userPubkey;
        event.id = getEventHash(event);
        const signedResult = await this.signer?.sign(event);
        // signerが返した完全なsigned eventがあればpubkey/id/sigを採用
        if (typeof signedResult === 'object' && signedResult.sig) {
          event.pubkey = signedResult.pubkey || event.pubkey;
          event.id = signedResult.id || event.id;
          event.sig = signedResult.sig;
        } else {
          event.sig = signedResult;
        }
        console.log('signed', { event, attempt });
        return event;
      } catch (e) {
        lastError = e;

        const isSignerRejected = e instanceof Nip46Error && e.code === 'SIGNER_REJECTED';
        const isCancelled = e instanceof Error && (e.message === 'Cancelled by user' || e.message === 'cancelled');

        if (attempt < maxRetries && !isSignerRejected && !isCancelled) {
          console.warn(`signEvent attempt ${attempt + 1}/${maxRetries + 1} failed, retrying...`, e);
          try {
            await this.forceReconnect();
          } catch (reconnectErr) {
            console.warn('forceReconnect failed during retry, will try sign anyway', reconnectErr);
          }
          continue;
        }
        break;
      }
    }
    throw lastError;
  }

  /**
   * 強制的にリレーに再接続し、subscriptionを再開する。
   * RelayHealthManager に委譲。
   */
  private async forceReconnect() {
    return this.relayHealth.forceReconnect();
  }

  private async ensureRelayConnection() {
    return this.relayHealth.ensureRelayConnection();
  }

  /**
   * リレープールが空なら保存済みリレーまたはデフォルトリレーを追加する
   */
  private ensureRelaysInPool() {
    this.relayHealth.ensureRelaysInPool();
  }

  /**
   * subscriptionを再開する。
   */
  private async ensureSubscription() {
    this.relayHealth.ensureSubscription();
  }

  private async codec_call(method: string, pubkey: string, param: string) {
    return new Promise<string>((resolve, reject) => {
      this.signer!.rpc.sendRequest(this.signer!.bunkerPubkey!, method, [pubkey, param], 24133, (response: RpcResponse) => {
        if (!response.error) {
          resolve(response.result);
        } else {
          if (response.error.includes('timeout') || response.error === 'Request timeout') {
            reject(new Nip46Error(response.error, 'TIMEOUT'));
          } else {
            reject(new Nip46Error(response.error, 'SIGNER_REJECTED'));
          }
        }
      });
    });
  }

  public async encrypt04(pubkey: string, plaintext: string) {
    if (this.localSigner) {
      return this.localSigner.encrypt({ pubkey }, plaintext);
    }
    await this.ensureRelayConnection();
    return this.signer!.encrypt(pubkey, plaintext);
  }

  public async decrypt04(pubkey: string, ciphertext: string) {
    if (this.localSigner) {
      return this.localSigner.decrypt({ pubkey }, ciphertext);
    }
    await this.ensureRelayConnection();
    return this.codec_call('nip04_decrypt', pubkey, ciphertext);
  }

  public async encrypt44(pubkey: string, plaintext: string) {
    if (this.localSigner) {
      return this.nip44Codec.encrypt(this.localSigner.privateKey!, pubkey, plaintext);
    }
    await this.ensureRelayConnection();
    return this.codec_call('nip44_encrypt', pubkey, plaintext);
  }

  public async decrypt44(pubkey: string, ciphertext: string) {
    if (this.localSigner) {
      return this.nip44Codec.decrypt(this.localSigner.privateKey!, pubkey, ciphertext);
    }
    await this.ensureRelayConnection();
    return this.codec_call('nip44_decrypt', pubkey, ciphertext);
  }
}

export default AuthNostrService;
