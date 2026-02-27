# Polish Plan: Terminal Refactor Improvements

## Summary

Address issues identified in the VSCode-style terminal group refactor review, focusing on connection reliability, performance, and resource management.

---

## Tasks

### 1. Connection Restoration Synchronization (High Priority)

**Problem:** Fixed 1500ms delay between connection restorations is brittle and may be insufficient for slow networks or excessive for fast ones.

**Solution:** Use event-based synchronization with `PtyStarted` message.

**Files to modify:**
- `src/App.tsx` - Replace delay-based with event-based restoration
- `src/components/pty-terminal.tsx` - Add `onPtyReady` callback prop

**Implementation:**
1. Add `onPtyReady?: (connectionId: string) => void` callback to PtyTerminal
2. Call callback when `PtyStarted` message is received
3. In App.tsx, create a `Promise`-based restoration queue that waits for `onPtyReady` before proceeding
4. Add 5-second timeout fallback to prevent hanging on failed connections

---

### 2. WebSocket Reconnection with Exponential Backoff (High Priority)

**Problem:** Infinite reconnection loop without backoff can flood servers and never terminates on permanent failures.

**Solution:** Implement exponential backoff with maximum retry limit of 5 attempts.

**Files to modify:**
- `src/components/pty-terminal.tsx`

**Implementation:**
1. Track `reconnectAttempts` count in component state/ref
2. Implement backoff formula: `delay = Math.min(1000 * 2^attempts, 30000)` (max 30s)
3. Add `maxReconnectAttempts = 5` limit (fail fast, rely on manual retry)
4. Show "Connection failed permanently - click to retry" UI when limit reached
5. Manual reconnect via context menu resets the counter

---

### 3. Tab→Group Lookup Optimization (Medium Priority)

**Problem:** `UPDATE_TAB_STATUS` iterates through all groups O(n) to find a tab.

**Solution:** Maintain a reverse lookup map.

**Files to modify:**
- `src/lib/terminal-group-context.tsx`
- `src/lib/terminal-group-reducer.ts`
- `src/lib/terminal-group-types.ts`

**Implementation:**
1. Add `tabToGroupMap: Record<string, string>` to `TerminalGroupState`
2. Update reducer actions to maintain the map:
   - `ADD_TAB`: Add entry
   - `REMOVE_TAB`: Remove entry
   - `MOVE_TAB`: Update entry
   - `SPLIT_GROUP`/`MOVE_TAB_TO_NEW_GROUP`: Update entries
3. `UPDATE_TAB_STATUS` uses map for O(1) lookup

---

### 4. PTY Session Cleanup Safety Net (Medium Priority)

**Problem:** Orphaned PTY sessions if frontend disconnects without sending `Close`.

**Solution:** Server-side idle timeout + heartbeat mechanism.

**Files to modify:**
- `src-tauri/src/connection_manager.rs`
- `src-tauri/src/websocket_server.rs`
- `src/components/pty-terminal.tsx`

**Implementation:**

**Backend:**
1. Add `last_activity: Instant` tracking to PtySession
2. Spawn a background task that checks for sessions idle > 5 minutes
3. Add `Ping`/`Pong` message types to WebSocket protocol
4. Backend sends `Ping` every 30 seconds, expects `Pong` within 10 seconds

**Frontend:**
1. Respond to `Ping` with `Pong`
2. If no `Ping` received for 60 seconds, assume dead connection

---

### 5. Shared ResizeObserver (Low Priority)

**Problem:** Each PtyTerminal creates its own ResizeObserver, potential memory overhead with many terminals.

**Solution:** Single shared observer with weak references.

**Files to modify:**
- `src/components/pty-terminal.tsx`
- `src/lib/terminal-resize-observer.ts` (new file)

**Implementation:**
1. Create singleton `TerminalResizeObserver` class
2. Uses `WeakMap<Element, callback>` for tracking
3. PtyTerminal registers/unregisters its container
4. Single observer handles all terminal resize events

---

## Execution Order

1. **Phase 1 (Priority):** Task 1 - Connection restoration synchronization
2. **Phase 2:** Task 2 - Exponential backoff with 5 max attempts
3. **Phase 3:** Tasks 3 & 4 - Performance and safety improvements
4. **Phase 4:** Task 5 - Memory optimization (optional)

---

## Testing Requirements

After each task:
1. Run existing tests: `pnpm test`
2. Manual testing:
   - Open multiple terminals, split view, close tabs
   - Disconnect network, verify reconnection behavior
   - Restart app, verify connection restoration
3. Check for console errors/warnings

---

## Risk Assessment

| Task | Risk | Mitigation |
|------|------|------------|
| Task 1 | Restoration could hang if event never fires | Add 5-second timeout fallback |
| Task 2 | May appear as regression to users expecting infinite retries | Add manual retry UI |
| Task 3 | Map could become stale if reducer logic has bugs | Add validation in dev mode |
| Task 4 | Heartbeat could add latency | Keep intervals reasonable (30s ping) |
| Task 5 | WeakMap behavior varies by browser | Test in all target browsers |
