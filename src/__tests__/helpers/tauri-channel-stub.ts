// Minimal `Channel` stand-in for tests that mock `@tauri-apps/api/core`.
// The real Channel constructor touches `window.__TAURI_INTERNALS__`, which
// does not exist under jsdom.

export class ChannelStub<T = unknown> {
  onmessage?: (response: T) => void;

  toJSON() {
    return { __CHANNEL__: 0 };
  }
}
