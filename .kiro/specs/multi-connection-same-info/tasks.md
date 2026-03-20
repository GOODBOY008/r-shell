# Tasks: Multi-Connection Same Info

## Task 1: Remove single-tab-per-profile restriction in sidebar connection handler

- [ ] 1.1 In `src/App.tsx` `handleConnectionConnect`, remove the `existingTabInActiveGroup` early-return guard that activates an existing tab instead of creating a new one
- [ ] 1.2 Change `existsElsewhere` to `existsAnywhere` — check all tabs (including active group) to determine if a duplicate session ID is needed
- [ ] 1.3 Always generate a unique session ID (`{profileId}-dup-{timestamp}`) when any tab from the same profile already exists anywhere, and set `originalConnectionId` to the profile ID
- [ ] 1.4 Ensure the new tab is added to the active group via `dispatch({ type: 'ADD_TAB' })` for SSH, SFTP, and FTP protocols

## Task 2: Add tab display name suffix for duplicate sessions

- [ ] 2.1 Create a `getTabDisplayName(tab, allTabsInGroup)` utility function in `src/lib/terminal-group-utils.ts` that computes the display name with numeric suffix when multiple tabs share the same base connection profile
- [ ] 2.2 Update `src/components/terminal/group-tab-bar.tsx` to use `getTabDisplayName` when rendering the tab label instead of `tab.name` directly
- [ ] 2.3 Ensure suffix is removed automatically when sibling count drops to 1 (this is inherent in the pure function approach — no extra logic needed, just verify)

## Task 3: Extend "Duplicate Tab" to support SFTP and FTP protocols

- [ ] 3.1 In `src/App.tsx` `handleDuplicateTab`, add protocol detection via `tabToDuplicate.tabType` and `tabToDuplicate.protocol`
- [ ] 3.2 For SFTP tabs, invoke `sftp_connect` with the duplicate session ID and credentials from the original connection profile
- [ ] 3.3 For FTP tabs, invoke `ftp_connect` with the duplicate session ID and credentials from the original connection profile
- [ ] 3.4 Set `tabType: 'file-browser'` and the correct `protocol` on the duplicated tab's `TerminalTab` object

## Task 4: Ensure proper cleanup on duplicate tab close

- [ ] 4.1 Verify that closing a duplicate SSH tab calls `ssh_disconnect` with the duplicate's unique session ID (not the original profile ID)
- [ ] 4.2 Verify that closing a duplicate SFTP tab calls `sftp_standalone_disconnect` with the duplicate's unique session ID
- [ ] 4.3 Verify that closing a duplicate FTP tab calls `ftp_disconnect` with the duplicate's unique session ID

## Task 5: Session persistence and restoration for duplicate tabs

- [ ] 5.1 Verify that `ActiveConnectionsManager.saveActiveConnections` already persists `originalConnectionId`, `tabType`, and `protocol` for duplicate tabs (existing code — confirm no changes needed)
- [ ] 5.2 Verify that `restoreConnections` in `App.tsx` correctly looks up credentials via `originalConnectionId` for duplicate tabs during restoration (existing code — confirm no changes needed)
- [ ] 5.3 Verify that failed restoration of a duplicate tab marks it as `disconnected` without blocking other restorations

## Task 6: Property-based tests

- [ ] 6.1 Write property test: activating a profile always adds a new tab (Property 1)
- [ ] 6.2 Write property test: session ID uniqueness across multiple generations (Property 2)
- [ ] 6.3 Write property test: duplicate tabs reference the original profile (Property 3)
- [ ] 6.4 Write property test: tab display name suffix correctness (Property 4)
- [ ] 6.5 Write property test: closing a tab preserves sibling tabs (Property 5)
- [ ] 6.6 Write property test: status update isolation between sibling tabs (Property 6)
- [ ] 6.7 Write property test: persistence round-trip for duplicate tabs (Property 7)

## Task 7: Unit tests and edge cases

- [ ] 7.1 Write unit test: `getTabDisplayName` returns name without suffix for single tab
- [ ] 7.2 Write unit test: `getTabDisplayName` returns correct suffixes for 2-3 tabs from same profile
- [ ] 7.3 Write unit test: duplicate of a duplicate correctly chains `originalConnectionId` to the root profile
- [ ] 7.4 Write unit test: SFTP duplicate tab invokes `sftp_connect` with correct parameters
- [ ] 7.5 Write unit test: FTP duplicate tab invokes `ftp_connect` with correct parameters
