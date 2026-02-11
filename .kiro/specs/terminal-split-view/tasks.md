# Implementation Plan: Terminal Split View

## Overview

将 R-Shell 的扁平标签页系统重构为 VSCode 风格的终端分屏系统。采用自底向上的实现策略：先建立核心数据类型和 reducer，再构建 Context Provider，然后实现 UI 组件，最后集成到现有 App 中。

## Tasks

- [x] 1. 核心数据类型与 Reducer
  - [x] 1.1 Create `src/lib/terminal-group-types.ts` with core type definitions
    - Define `SplitDirection`, `GridNode`, `TerminalTab`, `TerminalGroup`, `TerminalGroupState` types
    - Define `TerminalGroupAction` union type for all reducer actions
    - _Requirements: 1.4, 3.1_

  - [x] 1.2 Create `src/lib/terminal-group-reducer.ts` with the main reducer function
    - Implement `terminalGroupReducer` handling all action types
    - Implement grid tree manipulation helpers: `insertSplit`, `removeLeaf`, `simplifyTree`, `findLeafPath`, `updateSizes`
    - Implement `createDefaultState()` for initial single-group state
    - Handle SPLIT_GROUP: find leaf in grid tree, replace with branch containing old + new group
    - Handle REMOVE_GROUP: remove leaf, simplify tree (collapse single-child branches), preserve last group
    - Handle ADD_TAB, REMOVE_TAB, ACTIVATE_TAB, ACTIVATE_GROUP
    - Handle MOVE_TAB, REORDER_TAB, MOVE_TAB_TO_NEW_GROUP
    - Handle CLOSE_OTHER_TABS, CLOSE_TABS_TO_RIGHT, CLOSE_TABS_TO_LEFT
    - Handle UPDATE_TAB_STATUS, UPDATE_GRID_SIZES, RESET_LAYOUT, RESTORE_LAYOUT
    - Implement adjacent tab activation logic on tab close (prefer right, fallback left)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.2_

  - [x]* 1.3 Write property tests for reducer in `src/__tests__/terminal-group-reducer.property.test.ts`
    - Create `fast-check` arbitraries: `arbitraryTerminalTab`, `arbitraryTerminalGroup`, `arbitraryTerminalGroupState`, `arbitrarySplitDirection`
    - **Property 1: 分屏操作有效性** — For any state and direction, SPLIT_GROUP increases group count by 1
    - **Validates: Requirements 1.1, 3.2**
    - **Property 2: 空终端组自动移除不变量** — Removing last tab from a non-last group removes the group
    - **Validates: Requirements 1.2, 1.5, 4.6**
    - **Property 3: 终端组激活** — ACTIVATE_GROUP sets activeGroupId correctly
    - **Validates: Requirements 1.3, 7.3**
    - **Property 4: 终端组 ID 唯一性不变量** — All group IDs remain unique after any operation
    - **Validates: Requirements 1.4**
    - **Property 5: 组内标签页激活** — ACTIVATE_TAB sets activeTabId correctly
    - **Validates: Requirements 2.1**
    - **Property 6: 关闭标签页后的相邻激活** — After closing active tab, adjacent tab is activated
    - **Validates: Requirements 2.2**
    - **Property 7: 方向性标签页关闭** — CLOSE_OTHER/RIGHT/LEFT produces correct tab subset
    - **Validates: Requirements 2.3, 2.4, 2.5**
    - **Property 8: 移动标签页到新组** — MOVE_TAB_TO_NEW_GROUP creates new group with the tab
    - **Validates: Requirements 2.6, 4.5**
    - **Property 10: 标签页重排序保持集合不变** — REORDER_TAB preserves tab set
    - **Validates: Requirements 4.7**
    - **Property 11: 跨组移动标签页** — MOVE_TAB transfers tab between groups, total count unchanged
    - **Validates: Requirements 4.4, 9.1, 9.2**
    - **Property 15: 网格树结构不变量** — After any operation, grid tree invariants hold
    - **Validates: Requirements 1.1, 1.2, 2.6, 3.1**

- [x] 2. Checkpoint - Core reducer tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. 布局序列化与状态迁移
  - [x] 3.1 Create `src/lib/terminal-group-serializer.ts`
    - Implement `serialize(state)` — convert state to versioned JSON string
    - Implement `deserialize(json)` — parse JSON, validate version and structure, return state or null
    - Implement `saveState(state)` — write to localStorage
    - Implement `loadState()` — read from localStorage, handle missing/invalid data
    - Implement `createDefaultState()` — single group, empty tabs
    - Implement `migrateFromLegacy()` — detect and clear old format keys (`r-shell-active-connections`, unversioned layout data), log migration, preserve ConnectionData
    - _Requirements: 3.5, 3.6, 3.7, 6.1, 6.2, 6.3, 6.4, 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x]* 3.2 Write property tests for serializer in `src/__tests__/terminal-group-serializer.property.test.ts`
    - **Property 9: 布局状态序列化往返一致性** — serialize then deserialize produces equivalent state
    - **Validates: Requirements 3.5, 3.6, 3.7**
    - **Property 12: 损坏数据回退** — Invalid JSON or missing version returns null
    - **Validates: Requirements 6.3**
    - **Property 14: 旧版数据迁移安全性** — Legacy data cleared, ConnectionData preserved
    - **Validates: Requirements 10.1, 10.2, 10.5**

- [x] 4. Context Provider 与面板联动
  - [x] 4.1 Create `src/lib/terminal-group-context.tsx`
    - Implement `TerminalGroupProvider` with useReducer and auto-persistence
    - Derive `activeGroup`, `activeTab`, `activeConnection` from state
    - Call `migrateFromLegacy()` on initialization
    - Load saved state on mount, save on every state change via useEffect
    - Export `useTerminalGroups()` hook
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 6.1, 6.2_

  - [x]* 4.2 Write property tests for active connection derivation in `src/__tests__/terminal-group-context.property.test.ts`
    - **Property 13: 活动连接派生状态一致性** — activeConnection matches active tab's fields
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

- [x] 5. Checkpoint - Serializer and context tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. UI 组件实现
  - [x] 6.1 Create `src/components/terminal/grid-renderer.tsx`
    - Implement recursive `GridRenderer` component
    - Leaf nodes render `TerminalGroupView`
    - Branch nodes render nested `ResizablePanelGroup` with `ResizablePanel` + `ResizableHandle`
    - Pass `path` array for size update dispatching
    - Handle double-click on ResizableHandle to reset sizes to equal distribution
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 6.2 Create `src/components/terminal/group-tab-bar.tsx`
    - Implement `GroupTabBar` with drag-and-drop support on each tab
    - Set `draggable` on tab elements, handle `onDragStart` with tabId/groupId data
    - Handle `onDragOver` to show insertion indicator line
    - Handle `onDrop` to dispatch MOVE_TAB or REORDER_TAB
    - Include context menu: Close, Close Others, Close to Right/Left, Move to New Group (with direction submenu), Duplicate, Reconnect
    - Include "+" button to add new tab in this group
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.2, 4.7_

  - [x] 6.3 Create `src/components/terminal/terminal-group-view.tsx`
    - Implement `TerminalGroupView` with GroupTabBar + PtyTerminal content area
    - Handle click to dispatch ACTIVATE_GROUP
    - Apply selected styling: active group gets `border-2 border-primary` + highlighted tab bar background; inactive group gets `border border-border` + muted tab bar
    - Render PtyTerminal instances for each tab (show/hide via CSS display)
    - Show WelcomeScreen when group has no tabs (last group only)
    - _Requirements: 1.3, 1.5, 7.1, 7.2, 7.3_

  - [x] 6.4 Create `src/components/terminal/drop-zone-overlay.tsx`
    - Implement `DropZoneOverlay` shown during drag over content area
    - Divide area into 5 zones: up, down, left, right, center (25% edge threshold)
    - Highlight active zone with semi-transparent blue overlay
    - On drop: dispatch MOVE_TAB (center) or MOVE_TAB_TO_NEW_GROUP (directional)
    - _Requirements: 4.1, 4.3, 4.4, 4.5_

- [x] 7. Checkpoint - UI components compile without errors
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. 键盘快捷键
  - [x] 8.1 Extend `src/lib/keyboard-shortcuts.ts` with `createSplitViewShortcuts`
    - Add Ctrl+\ for split right
    - Add Ctrl+Shift+\ for split down
    - Add Ctrl+1~9 for focus group by index
    - Add Ctrl+W for close active tab
    - Add Ctrl+Tab for next tab in group
    - Add Ctrl+Shift+Tab for previous tab in group
    - Ignore shortcuts when target group index doesn't exist
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x]* 8.2 Write unit tests for keyboard shortcuts in `src/__tests__/keyboard-shortcuts.test.ts`
    - Test each shortcut key mapping triggers correct action
    - Test Ctrl+N with non-existent group index is no-op
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

- [x] 9. 集成到 App.tsx
  - [x] 9.1 Refactor `src/App.tsx` to use TerminalGroupProvider
    - Wrap AppContent with `TerminalGroupProvider`
    - Replace flat `tabs[]` + `activeTabId` state with `useTerminalGroups()` hook
    - Replace `<ConnectionTabs>` + single terminal rendering with `<GridRenderer>`
    - Update `handleConnectionConnect` to dispatch ADD_TAB to active group
    - Update `handleTabClose`, `handleTabSelect`, `handleDuplicateTab`, `handleReconnect` to use dispatch
    - Update right sidebar (SystemMonitor, LogViewer) to use `activeConnection` from context
    - Update bottom panel (IntegratedFileBrowser) to use `activeConnection` from context
    - Wire `createSplitViewShortcuts` into `useKeyboardShortcuts`
    - Update ConnectionManager `onConnectionConnect` to dispatch ADD_TAB to active group
    - Ensure layout sidebar/bottom panel toggles still work (LayoutContext unchanged)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3, 9.4_

  - [x] 9.2 Update connection restore logic in App.tsx
    - Modify `restoreConnections` to dispatch ADD_TAB actions to the active group
    - Handle legacy state migration on app startup (call migrateFromLegacy before loading state)
    - _Requirements: 6.2, 10.1, 10.2, 10.3, 10.4_

- [x] 10. Final checkpoint - Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using `fast-check`
- Unit tests validate specific examples and edge cases
- The existing `react-resizable-panels` library is reused for all resize functionality
- HTML5 Drag and Drop API is used (no additional dependencies needed)
