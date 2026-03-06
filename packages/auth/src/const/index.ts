export const CALL_TIMEOUT = 5000;
export const AUTH_URL_CALL_TIMEOUT = 120000; // auth_urlが来た場合のタイムアウト（120秒）

// デフォルトのNip46リレー
export const DEFAULT_NIP46_RELAYS = ['wss://relay.nsec.app/', 'wss://ephemeral.snowflare.cc/'];

// Nip46タイムアウト設定
export const NIP46_REQUEST_TIMEOUT = 30000; // 30秒

// Outboxリレー（プロフィール取得・作成用）
export const OUTBOX_RELAYS = ['wss://purplepag.es', 'wss://relay.nos.social', 'wss://user.kindpag.es', 'wss://relay.damus.io', 'wss://nos.lol'];

// サインアップ時のデフォルトリレー
export const DEFAULT_SIGNUP_RELAYS = ['wss://relay.damus.io/', 'wss://nos.lol/', 'wss://relay.primal.net/'];

// Nostr Connectアプリ一覧
export const NOSTRCONNECT_APPS: { name: string; domain?: string; canImport?: boolean; img: string; link: string }[] = [
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
