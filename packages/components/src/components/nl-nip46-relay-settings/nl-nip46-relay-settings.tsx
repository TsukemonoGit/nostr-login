import { Component, h, State, Event, EventEmitter, Prop } from '@stencil/core';

/** リセット時に戻すハードコード済みデフォルトリレー */
const FACTORY_DEFAULT_RELAYS = ['wss://relay.nsec.app/', 'wss://ephemeral.snowflare.cc/'];

@Component({
  tag: 'nl-nip46-relay-settings',
  styleUrl: 'nl-nip46-relay-settings.css',
  shadow: false,
})
export class NlNip46RelaySettings {
  /** 親から渡される現在のリレーリスト（localStorage由来の場合あり） */
  @Prop() defaultRelays: string[] = [...FACTORY_DEFAULT_RELAYS];

  @State() relays: string[] = [];
  @State() newRelay: string = '';
  @State() showSettings: boolean = false;

  @Event() nlRelaysChanged: EventEmitter<string[]>;

  componentWillLoad() {
    this.relays = [...this.defaultRelays];
  }

  addRelay() {
    const relay = this.newRelay.trim();
    if (relay && (relay.startsWith('wss://') || relay.startsWith('ws://'))) {
      if (!this.relays.includes(relay)) {
        this.relays = [...this.relays, relay];
        this.newRelay = '';
        this.nlRelaysChanged.emit(this.relays);
      }
    }
  }

  removeRelay(index: number) {
    this.relays = this.relays.filter((_, i) => i !== index);
    this.nlRelaysChanged.emit(this.relays);
  }

  resetToDefaults() {
    this.relays = [...FACTORY_DEFAULT_RELAYS];
    this.nlRelaysChanged.emit(this.relays);
  }

  render() {
    return (
      <div class="nip46-relay-settings mb-4">
        <button
          type="button"
          class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 underline cursor-pointer"
          onClick={() => (this.showSettings = !this.showSettings)}
        >
          {this.showSettings ? '▼' : '▶'} Advanced: Relay Settings
        </button>

        {this.showSettings && (
          <div class="mt-2 p-3 border border-gray-300 dark:border-gray-600 rounded bg-gray-50 dark:bg-gray-800">
            <div class="flex justify-between items-center mb-2">
              <div class="text-xs font-semibold text-gray-700 dark:text-gray-300">Nip46 Relays:</div>
              <button
                type="button"
                class="text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 underline cursor-pointer"
                onClick={() => this.resetToDefaults()}
              >
                Reset to defaults
              </button>
            </div>

            <ul class="text-xs mb-3 space-y-1">
              {this.relays.map((relay, index) => (
                <li class="flex justify-between items-center py-1 px-2 bg-white dark:bg-gray-700 rounded">
                  <span class="truncate text-gray-700 dark:text-gray-300 flex-1">{relay}</span>
                  <button
                    type="button"
                    class="ml-2 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-bold cursor-pointer"
                    onClick={() => this.removeRelay(index)}
                    title="Remove relay"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>

            <div class="flex gap-2">
              <input
                type="text"
                class="flex-1 text-xs px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                placeholder="wss://relay.example.com"
                value={this.newRelay}
                onInput={e => (this.newRelay = (e.target as HTMLInputElement).value)}
                onKeyPress={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addRelay();
                  }
                }}
              />
              <button type="button" class="text-xs px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded cursor-pointer" onClick={() => this.addRelay()}>
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
}
