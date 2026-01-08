import { EventEmitter } from 'tseep';
import { CALL_TIMEOUT } from '../const';

class ProcessManager extends EventEmitter {
  private callCount: number = 0;
  private callTimer: NodeJS.Timeout | undefined;
  private pendingCalls: Map<number, { reject: (reason?: any) => void }> = new Map();
  private callIdCounter: number = 0;

  constructor() {
    super();
  }

  public cancelAllPendingCalls() {
    for (const [id, { reject }] of this.pendingCalls.entries()) {
      reject(new Error('Cancelled by user'));
    }
    this.pendingCalls.clear();

    // タイマーとカウントをリセットして次の署名要求に備える
    if (this.callTimer) {
      clearTimeout(this.callTimer);
      this.callTimer = undefined;
    }
    this.callCount = 0;
  }

  public onAuthUrl() {
    if (Boolean(this.callTimer)) {
      clearTimeout(this.callTimer);
    }
  }

  public onIframeUrl() {
    if (Boolean(this.callTimer)) {
      clearTimeout(this.callTimer);
    }
  }

  public async wait<T>(cb: () => Promise<T>): Promise<T> {
    // FIXME only allow 1 parallel req

    if (!this.callTimer) {
      this.callTimer = setTimeout(() => this.emit('onCallTimeout'), CALL_TIMEOUT);
    }

    if (!this.callCount) {
      this.emit('onCallStart');
    }

    this.callCount++;

    const callId = this.callIdCounter++;
    let error;
    let result;

    try {
      result = await new Promise<T>(async (resolve, reject) => {
        this.pendingCalls.set(callId, { reject });
        try {
          const res = await cb();
          this.pendingCalls.delete(callId);
          resolve(res);
        } catch (e) {
          this.pendingCalls.delete(callId);
          reject(e);
        }
      });
    } catch (e) {
      error = e;
    }

    this.callCount--;

    this.emit('onCallEnd');

    if (this.callTimer) {
      clearTimeout(this.callTimer);
    }

    this.callTimer = undefined;

    if (error) {
      throw error;
    }

    // we can't return undefined bcs an exception is
    // thrown above on error
    // @ts-ignore
    return result;
  }
}

export default ProcessManager;
