interface RestorationEntry {
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingRestorations = new Map<string, RestorationEntry>();

// Track connections that signaled ready before registerRestoration was called
const earlySignals = new Set<string>();

export function registerRestoration(connectionId: string, timeoutMs: number = 5000): Promise<void> {
  // If signal arrived before registration, resolve immediately
  if (earlySignals.has(connectionId)) {
    earlySignals.delete(connectionId);
    console.log(`[Restoration] Early signal consumed for ${connectionId}`);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingRestorations.delete(connectionId);
      console.log(`[Restoration] Timeout for ${connectionId}`);
      resolve();
    }, timeoutMs);

    pendingRestorations.set(connectionId, { resolve, timeout });
  });
}

export function signalReady(connectionId: string): void {
  const entry = pendingRestorations.get(connectionId);
  if (entry) {
    clearTimeout(entry.timeout);
    pendingRestorations.delete(connectionId);
    entry.resolve();
    console.log(`[Restoration] Ready signal received for ${connectionId}`);
  } else {
    // Signal arrived before registerRestoration — store for later
    earlySignals.add(connectionId);
  }
}

export function clearAllRestorations(): void {
  for (const entry of pendingRestorations.values()) {
    clearTimeout(entry.timeout);
  }
  pendingRestorations.clear();
  earlySignals.clear();
}
