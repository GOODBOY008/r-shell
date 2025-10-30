# Test Credentials and Test Plan

## Manual Testing Checklist

### Connection Tests
- [ ] Connect with valid credentials - should succeed
- [ ] Connect with invalid password - should show error
- [ ] Connect with invalid host - should show error
- [ ] Disconnect active session - should succeed
- [ ] Reconnect to same server - should create new session

### Terminal Tests
- [ ] Execute simple command: `echo "test"`
- [ ] Execute command with output: `ls -la`
- [ ] Execute long-running command: `sleep 5`
- [ ] Interrupt command with Ctrl+C
- [ ] Clear terminal
- [ ] Command history (up/down arrows)
- [ ] Copy/paste in terminal

### System Monitor Tests
- [ ] View CPU usage - should update every 3 seconds
- [ ] View memory usage - should update every 3 seconds
- [ ] View disk usage - should display all mounted disks
- [ ] View process list - should show top 50 processes by CPU
- [ ] Process list updates - should refresh every 5 seconds
- [ ] All columns display correctly (PID, User, CPU%, Mem%, Command)

### Process Management Tests
- [ ] Start test process: `sleep 300 &`
- [ ] Find process in list
- [ ] Click kill button (X) - should show confirmation dialog
- [ ] Cancel kill - process should remain
- [ ] Confirm kill - process should terminate
- [ ] Verify process removed from list after refresh
- [ ] Try to kill system process - should show permission error

### File Browser Tests
- [ ] List files in home directory
- [ ] Navigate to subdirectory
- [ ] Navigate back to parent
- [ ] Sort files by name
- [ ] Sort files by size
- [ ] Sort files by date

### SFTP Tests
- [ ] Upload small file (<1MB)
- [ ] Upload large file (>10MB)
- [ ] Download file from server
- [ ] View transfer progress
- [ ] Cancel transfer
- [ ] View transfer history

### Connection Profile Tests
- [ ] Save connection profile
- [ ] Load saved profile
- [ ] Edit saved profile
- [ ] Delete profile
- [ ] Star/favorite profile
- [ ] Profile appears in quick connect list

### Multi-Session Tests
- [ ] Open two connections to same server
- [ ] Open connections to different servers
- [ ] Switch between session tabs
- [ ] Close one session, other remains active
- [ ] Clone session tab

## Automated Test Commands

### Run Unit Tests (when vitest is installed)
```bash
pnpm test
```

### Run E2E Tests (when playwright is installed)
```bash
pnpm playwright test
```

### Run Integration Test Manually

1. Start the Tauri dev server:
```bash
pnpm tauri dev
```

2. Open the application and try connecting with the test credentials

3. Run through the manual testing checklist above

## Expected Results

### Successful Connection
- Connection dialog closes
- New session tab appears with server name
- Terminal prompt appears
- System monitor shows live stats
- Process list populates within 5 seconds

### Failed Connection
- Error message appears in dialog
- Dialog remains open
- No session tab created
- Error logged to console

## Test Environment Requirements

- SSH server must be accessible (configure TEST_HOST in test files)
- Test user must have:
  - SSH access
  - Permission to execute `ps aux`
  - Permission to execute `kill` on own processes
  - Read access to home directory
  - SFTP access enabled

## Known Issues to Test For

1. **Process list empty** - Check if `ps aux` works on the server
2. **Kill fails** - Verify user has permission to kill processes
3. **Connection hangs** - Check network connectivity and SSH port
4. **Terminal doesn't respond** - Verify shell is interactive
5. **SFTP fails** - Check if SFTP subsystem is enabled

## Performance Benchmarks

- Connection time: < 3 seconds
- Command execution: < 500ms for simple commands
- Process list fetch: < 2 seconds
- File list fetch: < 1 second for <100 files
- System stats fetch: < 1 second
