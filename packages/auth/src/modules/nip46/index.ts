// ─── NIP-46 barrel re-exports ───────────────────────────────────────
// 旧 Nip46.ts の公開 API をすべて再エクスポートする。
// import { ... } from './nip46' で従来通り利用可能。

export type { NostrEvent, RpcRequest, RpcResponse, Filter } from './types';
export type { Nip46ErrorCode } from './errors';
export { Nip46Error } from './errors';
export { RelayPool, RxRelayPool } from './RelayPool';
export { NostrRpc } from './NostrRpc';
export { IframeNostrRpc } from './IframeNostrRpc';
export { ReadyListener } from './ReadyListener';
export { Nip46Signer } from './Nip46Signer';
