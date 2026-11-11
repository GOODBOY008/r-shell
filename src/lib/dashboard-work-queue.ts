/** Admission control before creating SSH channels or connection attempts. */
export class DashboardWorkQueue {
  private active = 0;
  private perKey = new Map<string, number>();
  private pending: Array<{ key: string; start: () => void }> = [];
  constructor(private limit: number, private keyLimit: number) {}

  hasCapacity(key: string) { return this.active < this.limit && (this.perKey.get(key) ?? 0) < this.keyLimit; }

  run<T>(key: string, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        signal.removeEventListener('abort', abort);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const entry = { key, start: () => {
        signal.removeEventListener('abort', abort);
        this.active++; this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
        const release = () => {
          this.active--; const left = this.perKey.get(key)! - 1;
          if (left) this.perKey.set(key, left); else this.perKey.delete(key);
          this.flush();
        };
        // Active work owns cancellation and keeps its slot until cleanup finishes.
        void Promise.resolve().then(() => {
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          return work();
        }).then(value => { release(); resolve(value); }, (error: unknown) => { release(); reject(error instanceof Error ? error : new Error(String(error))); });
      } };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.pending.push(entry); this.flush();
    });
  }
  private flush() {
    while (this.active < this.limit) {
      const index = this.pending.findIndex(entry => this.hasCapacity(entry.key));
      if (index < 0) break;
      this.pending.splice(index, 1)[0].start();
    }
  }
}
