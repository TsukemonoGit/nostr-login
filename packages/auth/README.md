# @konemono/nostr-login

> **This is an extended fork of [nostr-protocol/nostr-login](https://github.com/nostr-protocol/nostr-login).**
> Published as `@konemono/nostr-login` on npm.

This library is a powerful `window.nostr` provider with NIP-46 (Nostr Connect) support, browser extension login, read-only login, account switching, OAuth-like sign up, and more.

### Fork Enhancements

- **rx-nostr based relay management** — Replaced raw WebSocket handling with [rx-nostr](https://github.com/penpenpng/rx-nostr) v3: automatic reconnection with exponential backoff, lazy-keep connection strategy, reactive connection monitoring via `createConnectionStateObservable()`, and `cast()` for best-effort event publishing
- **Multiple NIP-46 relay support** — Add/remove/reset relays from the UI
- **QR code scanning** — Scan `bunker://` or `nostrconnect://` QR codes with camera
- **NIP-46 signing retry** — Auto-retry (up to 3 times) with forced reconnection on relay disconnect/timeout
- **Improved subscription recovery** — Resubscribe without EOSE hang after relay reconnection
- **Offline resilience** — Signer preserved on timeout; resumes on reconnection
- **Dialog close safety** — Closing the login dialog while already authenticated no longer destroys the signer
- **Stability fixes** — Infinite loading resolution, timeout management, cancel support

## Install

```bash
npm install @konemono/nostr-login
```

| Package                            | npm                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@konemono/nostr-login`            | [![npm](https://img.shields.io/npm/v/@konemono/nostr-login)](https://www.npmjs.com/package/@konemono/nostr-login)                       |
| `@konemono/nostr-login-components` | [![npm](https://img.shields.io/npm/v/@konemono/nostr-login-components)](https://www.npmjs.com/package/@konemono/nostr-login-components) |

## Options

You can set these attributes to the `script` tag to customize the behavior:

- `data-dark-mode` - `true`/`false`, default will use the browser's color theme
- `data-bunkers` - the comma-separated list of domain names of Nostr Connect (nip46) providers for sign up, i.e. `nsec.app,highlighter.com`
- `data-perms` - the comma-separated list of [permissions](https://github.com/nostr-protocol/nips/blob/master/46.md#requested-permissions) requested by the app over Nostr Connect, i.e. `sign_event:1,nip04_encrypt`
- `data-theme` - color themes, one of `default`, `ocean`, `lemonade`, `purple`
- `data-no-banner` - if `true`, do not show the `nostr-login` banner, will need to launch the modals using event dispatch, see below
- `data-methods` - comma-separated list of allowed auth methods, method names: `connect`, `extension`, `readOnly`, `local`, all allowed by default.
- `data-otp-request-url` - URL for requesting OTP code
- `data-otp-reply-url` - URL for replying with OTP code
- `data-title` - title for the welcome screen
- `data-description` - description for the welcome screen
- `data-start-screen` - screen shown by default (banner click, window.nostr.\* call), options: `welcome`, `welcome-login`, `welcome-signup`, `signup`, `local-signup`, `login`, `otp`, `connect`, `login-bunker-url`, `login-read-only`, `connection-string`, `switch-account`, `import`
- `data-signup-relays` - comma-separated list of relays where nip65 event will be published on local signup
- `data-outbox-relays` - comma-separated list of relays that will be added to nip65 event on local signup
- `data-signup-nstart` - "true" to use start.njump.me instead of local signup
- `data-follow-npubs` - comma-separated list of npubs to follow if njump.me signup is used

Example:

```
<script src='https://www.unpkg.com/nostr-login@latest/dist/unpkg.js' data-perms="sign_event:1,sign_event:0" data-theme="ocean"></script>
```

## Updating the UI

Whenever user performs an auth-related action using `nostr-login`, a `nlAuth` event will be dispatched on the `document`, which you can listen
to in order to update your UI (show user profile, etc):

```
document.addEventListener('nlAuth', (e) => {
  // type is login, signup or logout
  if (e.detail.type === 'login' || e.detail.type === 'signup') {
    onLogin();  // get pubkey with window.nostr and show user profile
  } else {
    onLogout()  // clear local user data, hide profile info
  }
})
```

## Launching, logout, etc

The `nostr-login` auth modals will be automatically launched whenever you
make a call to `window.nostr` if user isn't authed yet. However, you can also launch the auth flow by dispatching a custom `nlLaunch` event:

```
document.dispatchEvent(new CustomEvent('nlLaunch', { detail: 'welcome' }));
```

The `detail` event payload can be empty, or can be one of `welcome`, `signup`, `login`, `login-bunker-url`, `login-read-only`, `switch-account`.

To trigger logout in the `nostr-login`, you can dispatch a `nlLogout` event:

```
document.dispatchEvent(new Event("nlLogout"));
```

To change dark mode in the `nostr-login`, you can dispatch a `nlDarkMode` event, with detail as `darkMode` boolean:

```
document.dispatchEvent(new CustomEvent("nlDarkMode", { detail: true }));
```

## Use as a package

```javascript
import { init as initNostrLogin } from '@konemono/nostr-login';

// make sure this is called before any
// window.nostr calls are made
initNostrLogin({
  /*options*/
});
```

Now the `window.nostr` will be initialized and on your first call
to it the auth flow will be launched if user isn't authed yet.

You can also launch the auth flow yourself:

```javascript
import { launch as launchNostrLoginDialog } from '@konemono/nostr-login';

// make sure init() was called

// on your signup button click
function onSignupClick() {
  // launch signup screen
  launchNostrLoginDialog({
    startScreen: 'signup',
  });
}
```

### Next.js Fix for Server Side Rendering (SSR)

`nostr-login` calls `document` which is unavailable for server-side rendering. Import it dynamically inside `useEffect`:

```javascript
useEffect(() => {
  import('@konemono/nostr-login')
    .then(async ({ init }) => {
      init({
        // options
      });
    })
    .catch(error => console.log('Failed to load nostr-login', error));
}, []);
```

> Even if your component has `"use client"`, this fix may still be necessary.

---

## API

| Function                | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `init(opts)`            | Map `window.nostr` to nostr-login              |
| `launch(opts)`          | Launch nostr-login UI                          |
| `logout()`              | Drop the current NIP-46 connection and log out |
| `setDarkMode(dark)`     | Toggle dark mode                               |
| `setAuth(method, info)` | Programmatic login/logout                      |
| `cancelNeedAuth()`      | Cancel Nostr Connect flow                      |

## Options

Options can be passed to `init()` or set as `data-*` attributes on the script tag.

| `init()` option           | `data-*` attribute          | Description                                                                                                                                        |
| ------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `darkMode`                | `data-dark-mode`            | `true`/`false`. Defaults to browser color theme                                                                                                    |
| `theme`                   | `data-theme`                | Color theme: `default`, `ocean`, `lemonade`, `purple`                                                                                              |
| `bunkers`                 | `data-bunkers`              | Comma-separated NIP-46 provider domains, e.g. `nsec.app,highlighter.com`                                                                           |
| `perms`                   | `data-perms`                | [Permissions](https://github.com/nostr-protocol/nips/blob/master/46.md#requested-permissions) (comma-separated), e.g. `sign_event:1,nip04_encrypt` |
| `startScreen`             | `data-start-screen`         | Initial screen (see below)                                                                                                                         |
| `noBanner`                | `data-no-banner`            | `true` to hide the banner (use event dispatch to launch manually)                                                                                  |
| `methods`                 | `data-methods`              | Allowed auth methods (comma-separated): `connect`, `extension`, `readOnly`, `local`                                                                |
| `title`                   | `data-title`                | Welcome screen title                                                                                                                               |
| `description`             | `data-description`          | Welcome screen description                                                                                                                         |
| `otpRequestUrl`           | `data-otp-request-url`      | URL for OTP code request                                                                                                                           |
| `otpReplyUrl`             | `data-otp-reply-url`        | URL for OTP code reply                                                                                                                             |
| `signupRelays`            | `data-signup-relays`        | Relays for publishing nip65 on local signup (comma-separated)                                                                                      |
| `outboxRelays`            | `data-outbox-relays`        | Relays added to nip65 event on local signup (comma-separated)                                                                                      |
| `signupNstart`            | `data-signup-nstart`        | `true` to use start.njump.me for signup                                                                                                            |
| `followNpubs`             | `data-follow-npubs`         | npubs to follow on njump.me signup (comma-separated)                                                                                               |
| `devOverrideBunkerOrigin` | —                           | Testing only: override bunker origin                                                                                                               |
| `dev`                     | `data-dev`                  | Development mode                                                                                                                                   |
| `onAuth`                  | —                           | Callback `(npub, options) => void` instead of `nlAuth` event                                                                                       |
| `customNostrConnect`      | `data-custom-nostr-connect` | `true` to fire `nlNeedAuth` event instead of showing modal                                                                                         |

### startScreen values

`welcome` · `welcome-login` · `welcome-signup` · `signup` · `local-signup` · `login` · `otp` · `connect` · `login-bunker-url` · `login-read-only` · `connection-string` · `switch-account` · `import`

## Updating the UI

When a user performs an auth action, an `nlAuth` event is dispatched on `document`:

```javascript
document.addEventListener('nlAuth', e => {
  if (e.detail.type === 'login' || e.detail.type === 'signup') {
    onLogin(); // get pubkey with window.nostr and show user profile
  } else {
    onLogout(); // clear local user data, hide profile info
  }
});
```

## Event Dispatch

Trigger modals, logout, and other actions programmatically:

```javascript
// Launch auth UI
document.dispatchEvent(new CustomEvent('nlLaunch', { detail: 'welcome' }));

// Logout
document.dispatchEvent(new Event('nlLogout'));

// Toggle dark mode
document.dispatchEvent(new CustomEvent('nlDarkMode', { detail: true }));

// Programmatic login/logout
document.dispatchEvent(new CustomEvent('nlSetAuth', { detail: { method, info } }));

// Cancel Nostr Connect flow
document.dispatchEvent(new Event('nlNeedAuthCancel'));
```

The `detail` for `nlLaunch` can be: `welcome`, `signup`, `login`, `login-bunker-url`, `login-read-only`, `switch-account`.

## OTP Login

If you supply both `otpRequestUrl` and `otpReplyUrl`, a "Login with DM" button will appear on the welcome screen.

1. User enters nip05 or npub → GET `<otpRequestUrl>?pubkey=<user-pubkey>`. Server sends DM with one-time code and returns 200.
2. User enters code → GET `<otpReplyUrl>?pubkey=<user-pubkey>&code=<code>`. Server verifies and returns 200 + optional payload.

The payload is delivered as `otpData` in `nlAuth` event, saved in localStorage, and re-delivered on page reload.

## Examples

- [Basic HTML Example](../../examples/usage.html)

## License

MIT
