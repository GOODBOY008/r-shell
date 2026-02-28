/** 分屏方向 */
export type SplitDirection = 'up' | 'down' | 'left' | 'right';

/** 网格布局节点 */
export type GridNode =
  | { type: 'leaf'; groupId: string }
  | { type: 'branch'; direction: 'horizontal' | 'vertical'; children: GridNode[]; sizes: number[] };

/** 终端标签页 */
export interface TerminalTab {
  id: string;
  name: string;
  /** Tab type: 'terminal' for SSH PTY, 'file-browser' for SFTP/FTP */
  tabType?: 'terminal' | 'file-browser';
  protocol?: string;
  host?: string;
  username?: string;
  originalConnectionId?: string;
  connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'pending';
  reconnectCount: number;
}

/** 终端组 */
export interface TerminalGroup {
  id: string;
  tabs: TerminalTab[];
  activeTabId: string | null;
}

/** 完整布局状态 */
export interface TerminalGroupState {
  groups: Record<string, TerminalGroup>;
  activeGroupId: string;
  gridLayout: GridNode;
  nextGroupId: number;
  tabToGroupMap: Record<string, string>;
}

/** Reducer Action 类型 */
export type TerminalGroupAction =
  | { type: 'SPLIT_GROUP'; groupId: string; direction: SplitDirection; newTab?: TerminalTab }
  | { type: 'REMOVE_GROUP'; groupId: string }
  | { type: 'ACTIVATE_GROUP'; groupId: string }
  | { type: 'ADD_TAB'; groupId: string; tab: TerminalTab }
  | { type: 'REMOVE_TAB'; groupId: string; tabId: string }
  | { type: 'ACTIVATE_TAB'; groupId: string; tabId: string }
  | { type: 'MOVE_TAB'; sourceGroupId: string; targetGroupId: string; tabId: string; targetIndex?: number }
  | { type: 'REORDER_TAB'; groupId: string; fromIndex: number; toIndex: number }
  | { type: 'CLOSE_OTHER_TABS'; groupId: string; tabId: string }
  | { type: 'CLOSE_TABS_TO_RIGHT'; groupId: string; tabId: string }
  | { type: 'CLOSE_TABS_TO_LEFT'; groupId: string; tabId: string }
  | { type: 'MOVE_TAB_TO_NEW_GROUP'; groupId: string; tabId: string; direction: SplitDirection }
  | { type: 'UPDATE_TAB_STATUS'; tabId: string; status: 'connected' | 'connecting' | 'disconnected' | 'pending' }
  | { type: 'RECONNECT_TAB'; tabId: string }
  | { type: 'UPDATE_GRID_SIZES'; path: number[]; sizes: number[] }
  | { type: 'RESET_LAYOUT' }
  | { type: 'RESTORE_LAYOUT'; state: TerminalGroupState };
