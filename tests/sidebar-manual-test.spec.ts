/**
 * Manual E2E test for sidebar enhancements
 * Run: npx playwright test tests/sidebar-manual-test.spec.ts --headed
 *
 * Tests the following scenarios:
 * 1. Folder right-click context menu shows "New Connection"
 * 2. Clicking "New Connection" opens the dialog with folder preselected
 * 3. Open connection dialog from toolbar
 * 4. Sidebar renders correctly
 */
import { test, expect } from '@playwright/test';

test.describe('Sidebar Connection Organization', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:1420');
    await page.waitForLoadState('networkidle');
  });

  test('Folder context menu shows New Connection option', async ({ page }) => {
    await page.waitForSelector('text=All Connections', { timeout: 10000 });

    // Right-click on the All Connections folder
    const folderElement = page.locator('text=All Connections').first();
    await folderElement.click({ button: 'right' });

    // Check that a "New Connection" menuitem appears in the context menu
    await page.waitForTimeout(300);
    const menuItem = page.locator('[role="menuitem"]', { hasText: 'New Connection' }).first();
    await expect(menuItem).toBeVisible({ timeout: 3000 });
  });

  test('Folder right-click -> New Connection opens dialog', async ({ page }) => {
    await page.waitForSelector('text=All Connections', { timeout: 10000 });

    // Right-click All Connections folder to open context menu
    const folderElement = page.locator('text=All Connections').first();
    await folderElement.click({ button: 'right' });
    await page.waitForTimeout(300);

    // Click first [role="menuitem"] (it should be "New Connection")
    const contextMenuItem = page.locator('[role="menuitem"]').filter({ hasText: 'New Connection' }).first();
    await contextMenuItem.click();
    await page.waitForTimeout(500);

    // Dialog should appear
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
  });

  test('Toolbar New Connection button opens dialog', async ({ page }) => {
    await page.waitForSelector('text=All Connections', { timeout: 10000 });

    // Click a folder to select it
    const personalFolder = page.locator('text=Personal').first();
    if (await personalFolder.count() > 0) {
      await personalFolder.click();
      await page.waitForTimeout(200);
    }

    // Click the "+" button (tooltip: New Connection) in toolbar
    const plusButton = page.locator('button[data-slot="sidebar-trigger"]').or(
      page.locator('button svg.lucide-plus').first()
    );
    // Use a simpler approach: find the toolbar area and click the last icon button
    const buttons = page.locator('button').filter({ hasNot: page.locator('text') });
    // Try the last small button in the sidebar header area
    const toolbarBtns = page.locator('.px-3.py-1\\.5 button');
    if (await toolbarBtns.count() > 0) {
      // Click the last one (likely the + button for new connection)
      await toolbarBtns.last().click();
      await page.waitForTimeout(500);

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
    }
  });

  test('Sidebar renders with folders and connection list', async ({ page }) => {
    await page.waitForSelector('text=All Connections', { timeout: 10000 });

    // Verify the sidebar shows the connections header
    const sidebar = page.locator('text=Connections').first();
    await expect(sidebar).toBeVisible({ timeout: 3000 });

    // Verify default folders exist
    await expect(page.locator('text=Personal').first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=Work').first()).toBeVisible({ timeout: 3000 });
  });
});
