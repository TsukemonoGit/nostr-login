// ─── NIP-46 Errors ─────────────────────────────────────────────────

export type Nip46ErrorCode = 'TIMEOUT' | 'RELAY_DISCONNECTED' | 'SIGNER_REJECTED' | 'CANCELLED' | 'UNKNOWN';

export class Nip46Error extends Error {
  public code: Nip46ErrorCode;
  constructor(message: string, code: Nip46ErrorCode) {
    super(message);
    this.name = 'Nip46Error';
    this.code = code;
  }
  get retryable() {
    return this.code === 'TIMEOUT' || this.code === 'RELAY_DISCONNECTED';
  }
}
