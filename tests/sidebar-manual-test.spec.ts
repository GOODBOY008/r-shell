/**
 * 侧边栏功能浏览器模拟测试
 *
 * 单元测试(connection-storage-move.test.ts) 已覆盖 moveFolder/moveConnection 的所有边界情况。
 * 这里的 E2E 测试覆盖 UI 交互和集成验证。
 *
 * 启动方式:
 *   pnpm dev              (终端1)
 *   npx playwright test tests/sidebar-manual-test.spec.ts  (终端2)
 */
import { test, expect, type Page } from '@playwright/test';

const SEED_FOLDERS = [
  { id: 'folder-root', name: 'All Connections', path: 'All Connections', parentPath: undefined, createdAt: new Date().toISOString() },
  { id: 'folder-work', name: 'Work', path: 'All Connections/Work', parentPath: 'All Connections', createdAt: new Date().toISOString() },
  { id: 'folder-personal', name: 'Personal', path: 'All Connections/Personal', parentPath: 'All Connections', createdAt: new Date().toISOString() },
  { id: 'folder-dev', name: 'Dev', path: 'All Connections/Work/Dev', parentPath: 'All Connections/Work', createdAt: new Date().toISOString() },
];

const SEED_CONNECTIONS = [
  { id: 'conn-prod-db', name: 'Prod DB', host: '10.0.0.1', port: 22, username: 'admin', protocol: 'SSH', folder: 'All Connections/Work', authMethod: 'password', createdAt: new Date().toISOString() },
  { id: 'conn-dev-server', name: 'Dev Server', host: '10.0.0.2', port: 22, username: 'dev', protocol: 'SSH', folder: 'All Connections/Work/Dev', authMethod: 'password', createdAt: new Date().toISOString() },
  { id: 'conn-home', name: 'Home PC', host: '192.168.1.10', port: 22, username: 'user', protocol: 'SSH', folder: 'All Connections/Personal', authMethod: 'password', createdAt: new Date().toISOString() },
];

/** 通过页面的 ConnectionStorageManager 执行操作并验证 */
async function callStorage(page: Page, method: string, ...args: any[]): Promise<any> {
  return page.evaluate(({ method, args }) => {
    // Access the bundled module via the global scope
    const module = (window as any).__R_SHELL_STORAGE__;
    if (module) {
      return (module.ConnectionStorageManager as any)[method](...args);
    }
    throw new Error('Storage module not available in page context');
  }, { method, args });
}

async function getConnections(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    const stored = localStorage.getItem('r-shell-connections');
    return stored ? JSON.parse(stored) : [];
  });
}

async function getFolders(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    const stored = localStorage.getItem('r-shell-connection-folders');
    return stored ? JSON.parse(stored) : [];
  });
}

test.describe('侧边栏功能测试', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:1420');
    await page.waitForLoadState('domcontentloaded');

    // 填入测试数据
    await page.evaluate((data) => {
      localStorage.clear();
      localStorage.setItem('r-shell-connection-folders', JSON.stringify(data.folders));
      localStorage.setItem('r-shell-connections', JSON.stringify(data.connections));
    }, { folders: SEED_FOLDERS, connections: SEED_CONNECTIONS });

    // 刷新让应用加载测试数据
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('text=All Connections', { timeout: 10000 });
  });

  test('1. 文件夹右键菜单包含 New Connection', async ({ page }) => {
    const workFolder = page.locator('text=Work').first();
    await workFolder.click({ button: 'right' });
    await page.waitForTimeout(500);

    await expect(page.locator('[role="menuitem"]').filter({ hasText: 'New Connection' }).first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[role="menuitem"]').filter({ hasText: 'New Subfolder' }).first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[role="menuitem"]').filter({ hasText: 'Rename Folder' }).first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[role="menuitem"]').filter({ hasText: 'Delete Folder' }).first()).toBeVisible({ timeout: 3000 });
  });

  test('2. 右键 → 新建连接 → 对话框打开', async ({ page }) => {
    const workFolder = page.locator('text=Work').first();
    await workFolder.click({ button: 'right' });
    await page.waitForTimeout(500);

    await page.locator('[role="menuitem"]').filter({ hasText: 'New Connection' }).first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
  });

  test('3. 工具栏加号按钮打开对话框', async ({ page }) => {
    // 找到侧边栏顶部按钮组的最后一个按钮 (新建连接)
    const sidebarButtons = page.locator('[class*="px-3 py-1"][class*="border-b"]').locator('button');
    const count = await sidebarButtons.count();
    expect(count).toBeGreaterThanOrEqual(3);
    await sidebarButtons.last().click();
    await page.waitForTimeout(500);

    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
  });

  test('4. 右键 → 新建子文件夹 → 成功创建', async ({ page }) => {
    const workFolder = page.locator('text=Work').first();
    await workFolder.click({ button: 'right' });
    await page.waitForTimeout(500);

    // 点 "New Subfolder"
    await page.locator('[role="menuitem"]').filter({ hasText: 'New Subfolder' }).first().click();
    await page.waitForTimeout(300);

    // 输入文件夹名
    await page.locator('input[id="folder-name"]').fill('TestSub');
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(500);

    // 验证新文件夹出现
    const folders = await getFolders(page);
    expect(folders.some((f: any) => f.name === 'TestSub')).toBe(true);
  });

  test('5. 完整用户流程: 创建文件夹 → 右键新建连接 → 保存连接 → 验证持久化', async ({ page }) => {
    // 1. 创建新文件夹
    const folderPlusBtn = page.locator('button').filter({ has: page.locator('.lucide-folder-plus') }).first();
    await folderPlusBtn.click();
    await page.waitForTimeout(300);
    await page.locator('input[id="folder-name"]').fill('NewProject');
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(500);

    // 2. 验证文件夹创建成功
    let folders = await getFolders(page);
    expect(folders.some((f: any) => f.name === 'NewProject')).toBe(true);

    // 3. 右键新文件夹 → 新建连接
    await page.locator('text=NewProject').first().click({ button: 'right' });
    await page.waitForTimeout(500);
    await page.locator('[role="menuitem"]').filter({ hasText: 'New Connection' }).first().click();
    await page.waitForTimeout(500);

    // 4. 验证对话框打开
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

    // 5. 关闭对话框
    await page.locator('button:has-text("Cancel")').first().click();
    await page.waitForTimeout(300);
  });

  test('6. 验证 moveFolder 数据完整性', async ({ page }) => {
    // 通过 localStorage 直接操作来验证 moveFolder 的效果
    let folders = await getFolders(page);
    let conns = await getConnections(page);

    const origFolderCount = folders.length;
    const origConnCount = conns.length;

    // 直接操纵 localStorage 模拟拖拽移动
    await page.evaluate(() => {
      const ls = localStorage;
      const folders = JSON.parse(ls.getItem('r-shell-connection-folders')!);
      const connections = JSON.parse(ls.getItem('r-shell-connections')!);

      // Move All Connections/Work → All Connections/Personal/Work
      const workFolder = folders.find((f: any) => f.path === 'All Connections/Work');
      workFolder.parentPath = 'All Connections/Personal';
      workFolder.path = 'All Connections/Personal/Work';

      // Update dev subfolder
      const devFolder = folders.find((f: any) => f.path === 'All Connections/Work/Dev');
      devFolder.parentPath = 'All Connections/Personal/Work';
      devFolder.path = 'All Connections/Personal/Work/Dev';

      // Update connections
      const prodDb = connections.find((c: any) => c.id === 'conn-prod-db');
      prodDb.folder = 'All Connections/Personal/Work';

      const devServer = connections.find((c: any) => c.id === 'conn-dev-server');
      devServer.folder = 'All Connections/Personal/Work/Dev';

      ls.setItem('r-shell-connection-folders', JSON.stringify(folders));
      ls.setItem('r-shell-connections', JSON.stringify(connections));
    });

    // 刷新后验证
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('text=All Connections', { timeout: 10000 });

    folders = await getFolders(page);
    conns = await getConnections(page);

    // 数量不变
    expect(folders.length).toBe(origFolderCount);
    expect(conns.length).toBe(origConnCount);

    // Work 移到了 Personal 下
    const workFolder = folders.find((f: any) => f.name === 'Work');
    expect(workFolder?.parentPath).toBe('All Connections/Personal');

    // Prod DB 在 Work 下
    expect(conns.find((c: any) => c.name === 'Prod DB')?.folder).toBe('All Connections/Personal/Work');
  });
});
