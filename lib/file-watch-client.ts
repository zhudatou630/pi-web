import { createSilenceWatchdog } from "./sse-watchdog";

/** One logical file watch; native errors retry normally, silent streams are replaced. */
export class FileWatchEventSource extends EventTarget {
  onerror: ((event: Event) => void) | null = null;
  private source!: EventSource;
  private closed = false;
  private readonly watchdog = createSilenceWatchdog(() => {
    this.source.close();
    this.disconnected();
    this.connect();
  });

  constructor(private readonly url: string) {
    super();
    this.connect();
  }

  private disconnected() {
    this.dispatchEvent(new Event("error"));
    this.onerror?.(new Event("error"));
  }

  private connect() {
    if (this.closed) return;
    const source = new EventSource(this.url);
    this.source = source;
    for (const name of ["connected", "change", "heartbeat"]) {
      source.addEventListener(name, (event) => {
        if (this.closed || this.source !== source) return;
        this.watchdog.touch();
        if (name !== "heartbeat") this.dispatchEvent(new MessageEvent(name, { data: (event as MessageEvent).data }));
      });
    }
    source.addEventListener("error", () => {
      if (!this.closed && this.source === source) this.disconnected();
    });
    this.watchdog.touch();
  }

  close() {
    this.closed = true;
    this.watchdog.stop();
    this.source.close();
  }
}
