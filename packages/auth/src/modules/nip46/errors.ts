// ─── NIP-46 Errors ─────────────────────────────────────────────────

export type Nip46ErrorCode = 'TIMEOUT' | 'RELAY_DISCONNECTED' | 'SIGNER_REJECTED' | 'CANCELLED' | 'UNKNOWN';

const USER_MESSAGES: Record<Nip46ErrorCode, string> = {
  TIMEOUT: 'No response from signer. Please check your key storage app.',
  RELAY_DISCONNECTED: 'Cannot connect to relay. Please check your relay settings.',
  SIGNER_REJECTED: 'The request was rejected by the signer.',
  CANCELLED: 'The operation was cancelled.',
  UNKNOWN: 'An unknown error occurred.',
};

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
  get userMessage(): string {
    return USER_MESSAGES[this.code] || USER_MESSAGES.UNKNOWN;
  }
  toString(): string {
    return this.userMessage;
  }
}
