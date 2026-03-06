import { Component, h, State, Prop, Fragment, Event, EventEmitter } from '@stencil/core';
import { state } from '@/store';
import QrScanner from 'qr-scanner';

@Component({
  tag: 'nl-signin-bunker-url',
  styleUrl: 'nl-signin-bunker-url.css',
  shadow: false,
})
export class NlSigninBunkerUrl {
  @Prop() titleLogin = 'Connect with bunker url';
  @Prop() description = 'Please enter a bunker url provided by key store.';
  @State() isGood = false;
  @State() isScanning = false;
  @State() scanError = '';

  @Event() nlLogin: EventEmitter<string>;
  @Event() nlCheckLogin: EventEmitter<string>;

  private videoEl: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private scannerContainer: HTMLDivElement;
  private scanInterval: ReturnType<typeof setInterval> | null = null;

  handleInputChange(event: Event) {
    state.nlSigninBunkerUrl.loginName = (event.target as HTMLInputElement).value;

    this.nlCheckLogin.emit((event.target as HTMLInputElement).value);
  }

  handleLogin(e: MouseEvent) {
    e.preventDefault();

    this.nlLogin.emit(state.nlSigninBunkerUrl.loginName);
  }

  async startScan() {
    this.scanError = '';
    this.isScanning = true;

    // Wait for the container element to be rendered
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    if (!this.scannerContainer) {
      this.scanError = 'Camera not available';
      this.isScanning = false;
      return;
    }

    try {
      // getUserMedia で直接カメラストリームを取得
      // (qr-scanner のコンストラクタは dialog 内で video を非表示にしてしまうため使わない)
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });

      // video 要素を作成してカメラプレビューを表示
      this.videoEl = document.createElement('video');
      this.videoEl.setAttribute('playsinline', '');
      this.videoEl.setAttribute('autoplay', '');
      this.videoEl.muted = true;
      this.videoEl.style.width = '100%';
      this.videoEl.style.height = '100%';
      this.videoEl.style.objectFit = 'cover';
      this.videoEl.style.display = 'block';
      this.videoEl.srcObject = this.stream;
      this.scannerContainer.appendChild(this.videoEl);
      await this.videoEl.play();

      // 定期的にフレームをキャプチャして QR コードを解析
      this.scanInterval = setInterval(async () => {
        if (!this.videoEl || this.videoEl.readyState < 2) return;
        try {
          const result = await QrScanner.scanImage(this.videoEl, { returnDetailedScanResult: true });
          const data = result.data;
          if (data && (data.startsWith('bunker://') || data.startsWith('nostrconnect://'))) {
            state.nlSigninBunkerUrl.loginName = data;
            this.nlCheckLogin.emit(data);
            this.stopScan();
          }
        } catch (_e) {
          // QR コードが見つからない場合は無視（毎フレーム発生する）
        }
      }, 250);
    } catch (e) {
      console.error('QR Scanner error:', e);
      this.scanError = e instanceof Error ? e.message : 'Failed to access camera';
      this.isScanning = false;
    }
  }

  stopScan() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl.remove();
      this.videoEl = null;
    }
    this.isScanning = false;
  }

  disconnectedCallback() {
    this.stopScan();
  }

  render() {
    return (
      <Fragment>
        <div class="p-4 overflow-y-auto">
          <h1 class="nl-title font-bold text-center text-2xl">{this.titleLogin}</h1>
          <p class="nl-description font-light text-center text-sm pt-2 max-w-96 mx-auto">{this.description}</p>
        </div>

        <div class="max-w-72 mx-auto">
          <div class="relative mb-2">
            <input
              onInput={e => this.handleInputChange(e)}
              type="text"
              class="nl-input peer py-3 px-4 ps-11 block w-full border-transparent rounded-lg text-sm disabled:opacity-50 disabled:pointer-events-none dark:border-transparent"
              placeholder="bunker://..."
              aria-label="Bunker URL"
              value={state.nlSigninBunkerUrl.loginName}
            />
            <div class="absolute inset-y-0 start-0 flex items-center pointer-events-none ps-4 peer-disabled:opacity-50 peer-disabled:pointer-events-none">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="2"
                stroke={this.isGood ? '#00cc00' : 'currentColor'}
                class="flex-shrink-0 w-4 h-4 text-gray-500"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
                />
              </svg>
            </div>
          </div>

          {/* QR Scanner */}
          {this.isScanning ? (
            <div class="mb-3">
              <div
                ref={el => (this.scannerContainer = el as HTMLDivElement)}
                class="relative rounded-lg overflow-hidden bg-black"
                style={{ aspectRatio: '1', width: '100%' }}
              ></div>
              <button type="button" onClick={() => this.stopScan()} class="nl-action-button mt-2 w-full py-2 px-4 text-sm font-medium rounded-lg border border-transparent">
                Cancel
              </button>
            </div>
          ) : (
            <div class="mb-3">
              <button
                type="button"
                onClick={() => this.startScan()}
                class="nl-action-button w-full py-2 px-4 inline-flex justify-center items-center gap-x-2 text-sm font-medium rounded-lg border border-transparent"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
                  />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
                </svg>
                Scan QR Code
              </button>
            </div>
          )}

          {this.scanError && (
            <div class="mb-2">
              <p class="nl-error font-light text-center text-sm">{this.scanError}</p>
            </div>
          )}

          <div class="ps-4 pe-4 overflow-y-auto">
            <p class="nl-error font-light text-center text-sm max-w-96 mx-auto">{state.error}</p>
          </div>

          <button-base titleBtn="Connect" disabled={state.isLoading} onClick={e => this.handleLogin(e)}>
            {state.isLoading ? (
              <span
                slot="icon-start"
                class="animate-spin-loading inline-block w-4 h-4 border-[3px] border-current border-t-transparent text-slate-900 dark:text-gray-300 rounded-full"
                role="status"
                aria-label="loading"
              ></span>
            ) : (
              <svg style={{ display: 'none' }} slot="icon-start" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M8.25 9V5.25A2.25 2.25 0 0 1 10.5 3h6a2.25 2.25 0 0 1 2.25 2.25v13.5A2.25 2.25 0 0 1 16.5 21h-6a2.25 2.25 0 0 1-2.25-2.25V15M12 9l3 3m0 0-3 3m3-3H2.25"
                />
              </svg>
            )}
          </button-base>
        </div>
      </Fragment>
    );
  }
}
