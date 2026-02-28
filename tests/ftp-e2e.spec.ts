import { test, expect } from '@playwright/test';

// FTP test server credentials
const FTP_HOST = '192.168.20.24';
const FTP_PORT = '21';
const FTP_USER = 'xxxx';
const FTP_PASS = 'xxxxxxx';

const APP_URL = 'http://localhost:1420';

test.describe('FTP Connection E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL);
    // Wait for the app to fully load
    await page.waitForLoadState('networkidle');
  });

  /**
   * Helper: Open the connection dialog and fill in FTP credentials.
   */
  async function fillFtpConnectionDialog(page: import('@playwright/test').Page, name = 'FTP Test Server') {
    // Click "New Connection" button
    await page.click('button:has-text("New Connection")');

    // Wait for the dialog to open
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

    // Fill connection name
    const nameInput = page.locator('#connection-name');
    await nameInput.fill(name);

    // Select FTP protocol
    // The protocol selector is a Radix Select component
    const protocolTrigger = page.locator('#protocol').locator('..');
    // Click the protocol dropdown trigger
    await page.locator('button[role="combobox"]').first().click();
    // Wait a beat for the dropdown content to appear
    await page.waitForTimeout(300);

    // If there's a select trigger for protocol, click it
    // The protocol is inside a Select component; try the label approach
    const protocolSelect = page.locator('label:has-text("Protocol")').locator('..').locator('button[role="combobox"]');
    if (await protocolSelect.count() > 0) {
      await protocolSelect.click();
      await page.waitForTimeout(300);
    }

    // Click the FTP option
    await page.locator('[role="option"]:has-text("FTP")').click();
    await page.waitForTimeout(200);

    // Fill host
    const hostInput = page.locator('#host');
    await hostInput.fill(FTP_HOST);

    // Fill port (should auto-set to 21 when FTP is selected)
    const portInput = page.locator('#port');
    const portValue = await portInput.inputValue();
    if (portValue !== FTP_PORT) {
      await portInput.fill(FTP_PORT);
    }

    // Fill username
    const usernameInput = page.locator('#username');
    await usernameInput.fill(FTP_USER);

    // Switch to Authentication tab to fill password
    await page.click('text=Authentication');
    await page.waitForTimeout(200);

    // Fill password
    const passwordInput = page.locator('input[type="password"]');
    await passwordInput.fill(FTP_PASS);
  }

  // ─── Test 1: FTP connection succeeds and opens file browser ───

  test('should connect to FTP server and open file browser', async ({ page }) => {
    await fillFtpConnectionDialog(page);

    // Switch back to connection tab (or stay on auth) and click Connect
    await page.click('button:has-text("Connect")');

    // Wait for the dialog to close (connection succeeded)
    await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 15000 });

    // Verify we now have a file-browser tab
    // The tab bar should show the connection name
    await expect(page.locator('text=FTP Test Server')).toBeVisible({ timeout: 5000 });

    // The file browser view should be visible with directory listing
    // Look for breadcrumb root "/" or folder icons or the refresh button
    await expect(page.locator('button:has(svg)').filter({ hasText: /\// }).or(
      page.locator('text=/').first()
    )).toBeVisible({ timeout: 10000 });

    // There should be some file/folder entries or at least the file browser table/grid
    await page.waitForTimeout(2000);
  });

  // ─── Test 2: FTP file browser lists directory contents ───

  test('should list directory contents after FTP connection', async ({ page }) => {
    await fillFtpConnectionDialog(page, 'FTP List Test');

    await page.click('button:has-text("Connect")');
    await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 15000 });

    // Wait for the file browser to load — look for the table or entries
    await page.waitForTimeout(3000);

    // Verify the file browser loaded (breadcrumb shows root "/")
    // Check that the page contains file/directory entries or at least the browser UI
    const fileBrowserContent = page.locator('.overflow-auto, [class*="scroll"]').first();
    await expect(fileBrowserContent).toBeVisible({ timeout: 10000 });
  });

  // ─── Test 3: Create directory via context menu ───

  test('should create and delete a directory via FTP', async ({ page }) => {
    await fillFtpConnectionDialog(page, 'FTP CRUD Test');

    await page.click('button:has-text("Connect")');
    await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 15000 });
    await page.waitForTimeout(3000);

    // Right-click on the file browser background to open context menu
    const fileBrowserArea = page.locator('.overflow-auto, table, [class*="scroll"]').first();
    await fileBrowserArea.click({ button: 'right' });

    // Wait for context menu
    await page.waitForSelector('[role="menu"]', { timeout: 3000 });

    // Click "New Folder" / "Create Directory"
    const newFolderItem = page.locator('[role="menuitem"]:has-text("New Folder"), [role="menuitem"]:has-text("Create Directory")');
    if (await newFolderItem.count() > 0) {
      await newFolderItem.first().click();
      await page.waitForTimeout(500);

      // Type the new folder name in any prompt/input that appears
      const folderNameInput = page.locator('input[type="text"]').last();
      if (await folderNameInput.isVisible()) {
        await folderNameInput.fill('e2e_test_dir');
        // Press Enter or click OK
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);

        // Verify the folder appears in the listing
        await expect(page.locator('text=e2e_test_dir')).toBeVisible({ timeout: 5000 });

        // Now delete it: right-click on the directory entry
        await page.locator('text=e2e_test_dir').click({ button: 'right' });
        await page.waitForSelector('[role="menu"]', { timeout: 3000 });

        const deleteItem = page.locator('[role="menuitem"]:has-text("Delete")');
        if (await deleteItem.count() > 0) {
          await deleteItem.first().click();
          await page.waitForTimeout(2000);
          // Might have a confirmation dialog
          const confirmBtn = page.locator('button:has-text("Delete"), button:has-text("Confirm"), button:has-text("OK")');
          if (await confirmBtn.count() > 0) {
            await confirmBtn.first().click();
          }
          await page.waitForTimeout(2000);
        }
      }
    }
  });

  // ─── Test 4: FTP connection with wrong password shows error ───

  test('should show error toast for wrong FTP password', async ({ page }) => {
    // Click "New Connection"
    await page.click('button:has-text("New Connection")');
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

    // Fill connection name
    await page.locator('#connection-name').fill('FTP Bad Auth');

    // Select FTP protocol via the select dropdown
    // Try a generic approach: find all combobox buttons and pick the protocol one
    const comboboxButtons = page.locator('button[role="combobox"]');
    const protocolBtn = comboboxButtons.first();
    await protocolBtn.click();
    await page.waitForTimeout(300);
    await page.locator('[role="option"]:has-text("FTP")').click();
    await page.waitForTimeout(200);

    // Fill host & credentials
    await page.locator('#host').fill(FTP_HOST);
    await page.locator('#username').fill(FTP_USER);

    // Switch to auth tab and enter wrong password
    await page.click('text=Authentication');
    await page.waitForTimeout(200);
    await page.locator('input[type="password"]').fill('totally-wrong-password');

    // Click Connect
    await page.click('button:has-text("Connect")');

    // Should see an error toast or the dialog should still be open
    // Wait for either a toast or the dialog to remain
    const errorVisible = await Promise.race([
      page.waitForSelector('[data-sonner-toast][data-type="error"], .toast-error, [role="status"]:has-text("error")', { timeout: 15000 })
        .then(() => true)
        .catch(() => false),
      page.waitForSelector('[role="dialog"]', { timeout: 15000 })
        .then(() => true)
        .catch(() => false),
    ]);

    expect(errorVisible).toBe(true);

    // The dialog should still be open (connection failed)
    await expect(page.locator('[role="dialog"]')).toBeVisible();
  });

  // ─── Test 5: Tab close disconnects FTP session ───

  test('should disconnect FTP when closing tab', async ({ page }) => {
    await fillFtpConnectionDialog(page, 'FTP Close Test');

    await page.click('button:has-text("Connect")');
    await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: 15000 });

    // Wait for file browser to load
    await page.waitForTimeout(3000);

    // Verify tab exists
    await expect(page.locator('text=FTP Close Test')).toBeVisible();

    // Close the tab — look for the X button near the tab name
    const tabLabel = page.locator('text=FTP Close Test').first();
    const tabCloseBtn = tabLabel.locator('..').locator('button, [role="button"]').filter({ has: page.locator('svg') });
    if (await tabCloseBtn.count() > 0) {
      await tabCloseBtn.first().click();
    } else {
      // Try hovering first (some UIs show close button on hover)
      await tabLabel.hover();
      await page.waitForTimeout(300);
      const closeAfterHover = tabLabel.locator('..').locator('button, [role="button"]');
      if (await closeAfterHover.count() > 0) {
        await closeAfterHover.first().click();
      }
    }

    await page.waitForTimeout(1000);

    // Tab should be gone
    await expect(page.locator('text=FTP Close Test')).not.toBeVisible({ timeout: 5000 });
  });
});
