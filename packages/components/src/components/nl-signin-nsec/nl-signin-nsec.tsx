import { Component, h, Prop, Fragment, Event, EventEmitter } from '@stencil/core';
import { state } from '@/store';

@Component({
  tag: 'nl-signin-nsec',
  styleUrl: 'nl-signin-nsec.css',
  shadow: false,
})
export class NlSigninNsec {
  @Prop() titleLogin = 'Login with nsec';
  @Prop() description = 'Enter your private key (nsec) to log in.';

  @Event() nlLoginNsec: EventEmitter<string>;

  handleInputChange(event: Event) {
    state.nlSigninNsec.nsecValue = (event.target as HTMLInputElement).value;
  }

  handleLogin(e: MouseEvent) {
    e.preventDefault();
    this.nlLoginNsec.emit(state.nlSigninNsec.nsecValue);
  }

  render() {
    return (
      <Fragment>
        <div class="p-4 overflow-y-auto">
          <h1 class="nl-title font-bold text-center text-2xl">{this.titleLogin}</h1>
          <p class="nl-description font-light text-center text-sm pt-2 max-w-96 mx-auto">{this.description}</p>
        </div>

        <div class="max-w-72 mx-auto">
          <div class="p-3 mb-3 rounded-lg border border-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 dark:border-yellow-600">
            <div class="flex items-start gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="#ca8a04" class="flex-shrink-0 w-5 h-5 mt-0.5">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                />
              </svg>
              <div>
                <p class="nl-title text-xs font-semibold" style={{ color: '#ca8a04' }}>
                  Use at your own risk
                </p>
                <p class="nl-description text-xs mt-1" style={{ color: '#a16207' }}>
                  Entering your private key directly is not recommended. We suggest migrating to a key store service for better security.
                </p>
              </div>
            </div>
          </div>

          <div class="relative mb-2">
            <input
              onInput={e => this.handleInputChange(e)}
              type="password"
              class="nl-input peer py-3 px-4 ps-11 block w-full border-transparent rounded-lg text-sm disabled:opacity-50 disabled:pointer-events-none dark:border-transparent"
              placeholder="nsec1..."
              value={state.nlSigninNsec.nsecValue}
            />
            <div class="absolute inset-y-0 start-0 flex items-center pointer-events-none ps-4 peer-disabled:opacity-50 peer-disabled:pointer-events-none">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="flex-shrink-0 w-4 h-4 text-gray-500">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"
                />
              </svg>
            </div>
          </div>

          <div class="ps-4 pe-4 overflow-y-auto">
            <p class="nl-error font-light text-center text-sm max-w-96 mx-auto">{state.error}</p>
          </div>

          <button-base titleBtn="Log in" disabled={state.isLoading} onClick={e => this.handleLogin(e)}>
            {state.isLoading && (
              <span
                slot="icon-start"
                class="animate-spin-loading inline-block w-4 h-4 border-[3px] border-current border-t-transparent text-slate-900 dark:text-gray-300 rounded-full"
                role="status"
                aria-label="loading"
              ></span>
            )}
          </button-base>
        </div>
      </Fragment>
    );
  }
}
