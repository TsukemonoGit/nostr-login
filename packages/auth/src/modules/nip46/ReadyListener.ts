// ─── ReadyListener ──────────────────────────────────────────────────

export class ReadyListener {
  origin: string;
  messages: string[];
  promise: Promise<any>;

  constructor(messages: string[], origin: string) {
    this.origin = origin;
    this.messages = messages;
    this.promise = new Promise<any>(ok => {
      console.log(new Date(), 'started listener for', this.messages);

      const onReady = async (e: MessageEvent) => {
        const originHostname = new URL(origin!).hostname;
        const messageHostname = new URL(e.origin).hostname;
        const validHost = messageHostname === originHostname || messageHostname.endsWith('.' + originHostname);
        if (!validHost || !Array.isArray(e.data) || !e.data.length || !this.messages.includes(e.data[0])) {
          return;
        }

        console.log(new Date(), 'got ready message from', e.origin, e.data);
        window.removeEventListener('message', onReady);
        ok(e.data);
      };
      window.addEventListener('message', onReady);
    });
  }

  async wait(): Promise<any> {
    console.log(new Date(), 'waiting for', this.messages);
    const r = await this.promise;
    console.log(new Date(), 'finished waiting for', this.messages, r);
    return r;
  }
}
