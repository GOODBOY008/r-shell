# Directory Tree for Remote File Browser

**Date:** 2026-05-10
**Status:** Draft
**Scope:** Add a lazy-loading directory tree to the remote (SSH) panel in FileBrowserView

## Problem

The remote file browser currently uses breadcrumb navigation only. Users must click through directories one at a time to reach deep paths. A directory tree provides an overview of the remote filesystem structure and enables one-click navigation to any directory.

## Goals

- Show a directory tree alongside the remote file list in FileBrowserView
- Lazy-load child directories on expand (no upfront bulk fetch)
- Clicking a tree node navigates the file list to that directory
- Visual highlight syncs tree selection with current file list path
- Tree is resizable and collapsible

## Non-Goals

- No directory tree for the local panel (stays as-is)
- No file display in the tree (directories only)
- No drag-and-drop support in the tree (file list handles transfers)
- No changes to IntegratedFileBrowser

## Approach

### New Component: `DirectoryTree`

**File:** `src/components/directory-tree.tsx`

**Props:**
```typescript
interface DirectoryTreeProps {
  connectionId: string;
  currentPath: string;           // sync highlight with file list
  onNavigate: (path: string) => void;
  disabled?: boolean;
}
```

**Internal State:**
```typescript
nodes: Map<string, TreeNode[]>  // path -> cached children
expanded: Set<string>            // expanded node paths
loading: Set<string>             // paths currently loading
```

**Behavior:**
- Root node is `/` (matches the remote panel's initial path)
- Expanding a node invokes `list_remote_files` via Tauri `invoke`, filters to directories only
- Results are cached in `nodes` map; subsequent expand/collapse is instant
- Clicking a node fires `onNavigate(path)` to update the file list
- The node matching `currentPath` gets a visual highlight (background color)
- Keyboard support: Arrow Up/Down to move, Arrow Right to expand, Arrow Left to collapse, Enter to navigate

**Visual:**
- Compact tree layout with indent guides
- Folder icon + name per node
- Chevron rotates on expand/collapse
- Loading spinner shown while fetching children
- Active node highlighted with accent color matching remote panel theme (emerald)

### FileBrowserView Changes

**File:** `src/components/file-browser-view.tsx`

The remote panel changes from:
```tsx
<ResizablePanel id="remote-panel">
  <FilePanel ref={remotePanelRef} mode="remote" ... />
</ResizablePanel>
```

To:
```tsx
<ResizablePanel id="remote-panel">
  <ResizablePanelGroup direction="horizontal">
    <ResizablePanel id="remote-tree" defaultSize={25} minSize={15} maxSize={40}>
      <DirectoryTree
        connectionId={connectionId}
        currentPath={remotePanelRef.current?.getCurrentPath() ?? "/"}
        onNavigate={(path) => remotePanelRef.current?.navigateTo(path)}
        disabled={!isConnected}
      />
    </ResizablePanel>
    <ResizableHandle />
    <ResizablePanel id="remote-files" defaultSize={75} minSize={40}>
      <FilePanel ref={remotePanelRef} mode="remote" ... />
    </ResizablePanel>
  </ResizablePanelGroup>
</ResizablePanel>
```

### FilePanel Changes

**File:** `src/components/file-panel.tsx`

Add `navigateTo(path: string)` to the imperative handle:

```typescript
export interface FilePanelRef {
  getCurrentPath: () => string;
  getSelectedEntries: () => FileEntry[];
  refresh: () => void;
  selectAll: () => void;
  navigateTo: (path: string) => void;  // NEW
}
```

Implementation: `navigateTo` calls the existing internal `loadDirectory(path)`.

### Data Flow

```
User clicks tree node
  -> DirectoryTree.onNavigate(path)
  -> FileBrowserView calls remotePanelRef.current.navigateTo(path)
  -> FilePanel.loadDirectory(path)
  -> invoke("list_remote_files", { connectionId, path })
  -> File list updates, currentPath changes
  -> DirectoryTree receives new currentPath, highlights matching node
```

### Backend

No backend changes required. The tree uses the existing `list_remote_files` Tauri command, filtering results to directories client-side.

## Testing

- Unit tests for tree node expansion/collapse logic
- Unit tests for path-to-tree-node mapping
- Integration test: clicking tree node updates file list
- Manual test: expand deep paths, verify lazy loading and caching

## Open Questions

None.
