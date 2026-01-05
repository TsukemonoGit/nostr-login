import { describe, it, expect } from 'vitest';
import { PrivateKeySigner } from './Signer';
import { NostrRpc, IframeNostrRpc, Nip46Signer } from './Nip46';
import { generatePrivateKey, getPublicKey } from 'nostr-tools';

// basic smoke tests

describe('NostrRpc basic', () => {
  it('creates and signs event', async () => {
    const sk = generatePrivateKey();
    const signer = new PrivateKeySigner(sk);
    const rpc = new NostrRpc(signer, ['wss://relay.nostr.example']);

    const event = await rpc.createRequestEvent('id1', getPublicKey(sk), 'echo', ['hello']);
    expect(event.kind).toBe(24133);
    expect(event.pubkey).toBe(signer.pubkey);
    expect(event.content).toBeTruthy();
  });
});

describe('Nip46Signer basic', () => {
  it('wraps signer and can sign', async () => {
    const sk = generatePrivateKey();
    const signer = new PrivateKeySigner(sk);
    const nip = new Nip46Signer(signer, signer.pubkey);

    const ev: any = { kind: 1, content: 'x', pubkey: signer.pubkey, tags: [] };
    const sig = await nip.sign(ev);
    expect(sig).toBeTruthy();
  });
});
