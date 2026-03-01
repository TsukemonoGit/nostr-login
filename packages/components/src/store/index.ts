import { createStore } from '@stencil/store';
import { CURRENT_MODULE, ConnectionString } from '@/types';

// Load custom relays from localStorage
const loadCustomRelays = (): string[] => {
  try {
    const saved = localStorage.getItem('customNip46Relays');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Failed to load custom relays from localStorage', e);
  }
  return ['wss://relay.nsec.app/', 'wss://ephemeral.snowflare.cc/'];
};

const { state, onChange, reset } = createStore({
  screen: CURRENT_MODULE.WELCOME,
  prevScreen: CURRENT_MODULE.WELCOME,
  path: [CURRENT_MODULE.WELCOME],
  error: '',
  isLoading: false,
  isLoadingExtension: false,
  isOTP: false,
  authUrl: '',
  iframeUrl: '',
  njumpIframe: '',

  // グローバルなNip46リレー設定（全ての接続方法で共有）
  customNip46Relays: loadCustomRelays(),

  // State NlSignin
  nlSignin: {
    loginName: '',
  },

  // State NlSignup
  nlSignup: {
    signupName: '',
    domain: '',
    servers: [
      { name: '@nsec.app', value: 'nsec.app' },
      { name: '@highlighter.com', value: 'highlighter.com' },
    ],
  },

  // State NlSigninBunkerUrl
  nlSigninBunkerUrl: {
    loginName: '',
  },

  // State NlSigninReadOnly
  nlSigninReadOnly: {
    loginName: '',
  },

  // State NlSigninOTP
  nlSigninOTP: {
    loginName: '',
    code: '',
  },

  // State NlSigninNsec
  nlSigninNsec: {
    nsecValue: '',
  },

  nlImport: null as ConnectionString | null,
});

// Save custom relays to localStorage when changed
onChange('customNip46Relays', relays => {
  try {
    localStorage.setItem('customNip46Relays', JSON.stringify(relays));
  } catch (e) {
    console.error('Failed to save custom relays to localStorage', e);
  }
});

// control show screens & manage history (like as router)
// ??? edit to better solution
onChange('screen', () => {
  state.error = '';
  state.nlSignin.loginName = '';
  state.nlSignup.signupName = '';
  state.nlSignup.domain = '';
  state.nlSigninNsec.nsecValue = '';

  // if (value === CURRENT_MODULE.LOGIN || value === CURRENT_MODULE.SIGNUP || value === CURRENT_MODULE.LOGIN_BUNKER_URL || value === CURRENT_MODULE.LOGIN_READ_ONLY) {
  //   state.prevScreen = CURRENT_MODULE.WELCOME;
  // }
});

// on('set', (_, value, oldValue) => {
//   if (value === CURRENT_MODULE.INFO) {
//     state.prevScreen = oldValue;
//   }
// });

export { state, reset };
