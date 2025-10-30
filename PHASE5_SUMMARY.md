# Phase 5: Advanced System Monitoring - Process Management

## Implementation Summary

Phase 5 has been successfully implemented, adding comprehensive process management capabilities to r-shell.

## Features Implemented

### 1. Backend Process Management Commands

#### `get_processes` Command
- **Location**: `src-tauri/src/commands.rs`
- **Functionality**: 
  - Executes `ps aux --sort=-%cpu | head -50` over SSH
  - Returns top 50 processes sorted by CPU usage
  - Parses process information: PID, user, CPU%, memory%, command
- **Response Structure**:
  ```rust
  ProcessListResponse {
      success: bool,
      processes: Option<Vec<ProcessInfo>>,
      error: Option<String>
  }
  ```

#### `kill_process` Command
- **Location**: `src-tauri/src/commands.rs`
- **Functionality**:
  - Terminates a process by PID
  - Accepts optional signal parameter (defaults to SIGTERM/15)
  - Executes `kill -{signal} {pid}` command
  - Returns success/error status
- **Parameters**:
  - `session_id`: String
  - `pid`: i32
  - `signal`: Option<i32> (default: 15)

#### Command Registration
- **Location**: `src-tauri/src/lib.rs`
- Added both commands to the Tauri handler macro
- Backend successfully compiled without errors

### 2. Frontend Process List Display

#### SystemMonitor Component Updates
- **Location**: `src/components/system-monitor.tsx`
- **Changes**:
  - Updated `Process` interface to match backend structure (pid, user, cpu, mem, command)
  - Added `fetchProcesses()` async function to invoke `get_processes` command
  - Implemented automatic polling (every 5 seconds) alongside system stats
  - Updated process table with new columns:
    - PID (Process ID)
    - User (Process owner)
    - CPU% (CPU usage)
    - Mem% (Memory usage)
    - Command (Full command line)
    - Action button (Kill process)

### 3. Process Termination UI

#### Kill Process Feature
- **Functionality**:
  - Kill button (X icon) on each process row
  - Confirmation dialog before terminating
  - Shows process PID and command in confirmation
  - Sends SIGTERM (signal 15) by default
  - Toast notifications for success/error
  - Auto-refreshes process list after kill operation

#### Components Used
- AlertDialog for confirmation
- Button component for kill action
- Toast notifications (sonner) for feedback
- Proper error handling and user feedback

## Technical Details

### Backend Implementation
```rust
// Process data structure
pub struct ProcessInfo {
    pid: i32,
    user: String,
    cpu: f64,
    mem: f64,
    command: String,
}

// Parse ps aux output
ps aux --sort=-%cpu | head -50
```

### Frontend Integration
```typescript
// Fetch processes
const result = await invoke<ProcessListResponse>(
  'get_processes', 
  { session_id: sessionId }
);

// Kill process
const result = await invoke<CommandResponse>(
  'kill_process',
  { session_id: sessionId, pid: process.pid, signal: 15 }
);
```

### Polling Strategy
- System stats: Every 3 seconds
- Process list: Every 5 seconds
- Network usage: Every 1 second
- Network latency: Every 3 seconds

## Files Modified

### Backend
1. `/src-tauri/src/commands.rs` - Added process management commands
2. `/src-tauri/src/lib.rs` - Registered new commands

### Frontend
1. `/src/components/system-monitor.tsx` - Integrated process display and kill functionality

## Testing Checklist

- [ ] Connect to SSH server
- [ ] Verify process list displays correctly
- [ ] Check process sorting by CPU
- [ ] Test killing a safe process (e.g., sleep command)
- [ ] Verify process disappears from list after kill
- [ ] Test error handling (invalid PID, permission denied)
- [ ] Confirm toast notifications appear
- [ ] Test auto-refresh after kill operation
- [ ] Verify confirmation dialog prevents accidental kills

## Next Steps

Phase 5 is complete. Options for next implementation:

1. **Phase 5.4: Log Viewer**
   - Real-time log tailing (tail -f)
   - Log file browser
   - Search and filter logs

2. **Phase 6: Command Snippets**
   - Save frequently used commands
   - Quick access templates
   - Variable substitution

3. **Phase 7: UI Polish**
   - Theme customization
   - Keyboard shortcuts
   - Layout preferences

4. **Phase 8: Security Hardening**
   - Encrypted credential storage
   - SSH host key verification
   - Audit logging

## Known Limitations

- Process list limited to top 50 by CPU usage
- Only SIGTERM (15) signal currently used (can be extended)
- No process filtering/search yet
- Process details view not implemented

## Security Considerations

- Kill command requires appropriate permissions on remote host
- User's SSH permissions determine which processes can be killed
- SIGTERM is used (graceful shutdown) rather than SIGKILL
- All operations require active SSH session

## Performance

- Minimal overhead: Commands execute over existing SSH connection
- Efficient parsing of ps output
- Background polling doesn't block UI
- Process list capped at 50 entries to maintain responsiveness
