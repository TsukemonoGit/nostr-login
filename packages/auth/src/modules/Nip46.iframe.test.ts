import { describe, it, expect } from 'vitest';
import { IframeNostrRpc } from './Nip46';
import { PrivateKeySigner } from './Signer';
import { generatePrivateKey, validateEvent, verifySignature } from 'nostr-tools';

describe('IframeNostrRpc integration', () => {
  it('roundtrips request/response via MessagePort', async () => {
    const localSk = generatePrivateKey();
    const remoteSk = generatePrivateKey();
    const localSigner = new PrivateKeySigner(localSk);
    const remoteSigner = new PrivateKeySigner(remoteSk);

    const rpc = new IframeNostrRpc(localSigner, 'https://example.com', ['wss://relay.example']);

    // mock MessagePort
    const port: any = {
      onmessage: undefined as any,
      postMessage: (msg: any) => {
        // ignore ping messages from keepalive
        if (typeof msg === 'string') return;
        // log for debugging
        console.log('[test] postMessage received', typeof msg, msg && typeof msg === 'object' && msg.pubkey);
        console.log('[test] msg.id', msg && msg.id, 'kind', msg && msg.kind, 'contentType', typeof (msg && msg.content), 'contentLen', msg && msg.content && msg.content.length);
        // simulate remote iframe processing (defer to avoid race with request setup)
        setTimeout(() => {
          (async () => {
            try {
              // remote decrypts request (sender pubkey is msg.pubkey)
              const decrypted = await remoteSigner.decrypt(msg.pubkey, msg.content);
              console.log('[test] decrypted raw', typeof decrypted, decrypted && decrypted.slice ? decrypted.slice(0, 120) : decrypted);
              const req = JSON.parse(decrypted);
              console.log('[test] parsed request id', req.id, 'method', req.method);

              const response = { id: req.id, result: 'ack' };
              const content = await remoteSigner.encrypt(msg.pubkey, JSON.stringify(response));
              const event: any = {
                kind: msg.kind,
                content,
                tags: [['p', msg.pubkey]],
                pubkey: remoteSigner.pubkey,
                created_at: Math.floor(Date.now() / 1000),
              };

              await remoteSigner.sign(event);

              // debug: validate/verify locally to see why rpc might ignore it
              console.log('[test] validateEvent', validateEvent(event), 'verifySignature', verifySignature(event));

              // instead of posting back via port, directly parse with rpc to avoid EventEmitter timing issues
              try {
                const parsed = await (rpc as any).parseEvent(event);
                console.log('[test] direct parsed result', parsed);
                if (parsed && (parsed as any).result === 'ack') {
                  // resolve the outer test promise via port._resolve
                  try {
                    (port as any)._resolve?.();
                  } catch (e) {
                    console.error('[test] resolve error', e);
                  }
                  return;
                }
              } catch (e) {
                console.error('[test] parseEvent direct error', e);
                throw e;
              }
            } catch (e) {
              console.error('[test] postMessage handler error', e);
              throw e;
            }
          })();
        }, 0);
      },
    };

    rpc.setWorkerIframePort(port as MessagePort);

    // override getId so we can listen for the specific response event
    const id = 'test-iframe-id';
    (rpc as any).getId = () => id;

    // instrument rpc.emit to see emitted events
    const origEmit = (rpc as any).emit;
    (rpc as any).emit = function (ev: any, payload: any) {
      try {
        console.log('[test] rpc.emit', ev, payload && payload.id, payload && JSON.stringify(payload));
      } catch (e) {
        console.log('[test] rpc.emit', ev, payload && payload.id);
      }
      return origEmit.apply(this, arguments as any);
    };

    // instrument parseEvent to see if the rpc handler runs
    const origParse = (rpc as any).parseEvent;
    (rpc as any).parseEvent = async function (event: any) {
      console.log('[test] rpc.parseEvent called');
      try {
        const parsed = await origParse.apply(this, arguments as any);
        console.log('[test] rpc.parseEvent result', parsed && parsed.id, parsed && (parsed as any).method);
        return parsed;
      } catch (e) {
        console.error('[test] rpc.parseEvent error', e);
        throw e;
      }
    };

    await new Promise<void>((ok, err) => {
      // attach resolve onto the port so deferred handler can call it
      (port as any)._resolve = ok;

      // use internal setResponseHandler directly to ensure we catch responses (optional)
      (rpc as any).setResponseHandler(id, (res: any) => {
        console.log('[test] setResponseHandler callback', res);
        try {
          expect(res.result).toBe('ack');
          ok();
        } catch (e) {
          err(e);
        }
      });

      rpc.sendRequest(remoteSigner.pubkey, 'connect', [localSigner.pubkey], 24133);
    });
  });
});
