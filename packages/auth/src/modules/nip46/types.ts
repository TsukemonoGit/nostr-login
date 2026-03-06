// ─── NIP-46 Types ──────────────────────────────────────────────────

export interface NostrEvent {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
  pubkey: string;
  id?: string;
  sig?: string;
}

export interface RpcRequest {
  id: string;
  pubkey: string;
  method: string;
  params: string[];
  event: NostrEvent;
}

export interface RpcResponse {
  id: string;
  result: string;
  error: string;
  event: NostrEvent;
}

export type Filter = {
  'kinds'?: number[];
  '#p'?: string[];
  'since'?: number;
  'until'?: number;
  'limit'?: number;
  'authors'?: string[];
  'ids'?: string[];
};
