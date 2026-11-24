import { expect, test } from '@playwright/test';

test.use({
  baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL ?? 'http://localhost:1420',
  reducedMotion: 'reduce',
});

type SavedTab = {
  id: string;
  name: string;
  tabType: 'terminal' | 'local-terminal';
  protocol?: string;
};

// Runs in the new browser context before the application's session restore.
function seedLayout({ tabs, activeTabId }: { tabs: SavedTab[]; activeTabId: string }) {
  const saved = tabs.map(tab => ({ ...tab, reconnectCount: 0, connectionStatus: 'pending' }));
  localStorage.setItem('r-shell-language', 'zh-CN');
  localStorage.setItem('r-shell-terminal-groups', JSON.stringify({
    version: 2,
    data: {
      groups: { '1': { id: '1', tabs: saved, activeTabId } },
      activeGroupId: '1', nextGroupId: 2,
      gridLayout: { type: 'leaf', groupId: '1' },
      tabToGroupMap: Object.fromEntries(tabs.map(tab => [tab.id, '1'])),
    },
  }));
}

for (const stripWidth of [128, 203]) {
  for (const selected of ['ssh', 'local']) {
    test(`Move Tab Right keeps both headers visible in a ${stripWidth}px strip with ${selected} selected`, async ({ page }) => {
      await page.addInitScript(seedLayout, {
        tabs: [
          { id: 'ssh', name: 'production-application-analytics-primary', tabType: 'terminal', protocol: 'SSH' },
          { id: 'local', name: 'zsh', tabType: 'local-terminal' },
        ],
        activeTabId: selected,
      });
      await page.goto('/');
      // Constrain just the strip, as in a narrow pane with the sidebars open.
      // Use the application's real tab styles and scrolling behavior.
      const strip = page.locator('[data-tab-bar-group="1"]');
      await page.addStyleTag({ content: `[data-tab-bar-group="1"] { max-inline-size: ${stripWidth}px; }` });
      const headers = strip.locator('[data-tab-id]');
      const ssh = strip.locator('[data-tab-id="ssh"] button[aria-pressed]');
      const local = strip.locator('[data-tab-id="local"] button[aria-pressed]');
      await expect(headers.first()).toHaveAttribute('data-tab-id', 'ssh');

      await ssh.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^右移标签页/ }).click();

      await expect(headers).toHaveCount(2);
      await expect(headers.first()).toHaveAttribute('data-tab-id', 'local');
      await expect(headers.last()).toHaveAttribute('data-tab-id', 'ssh');
      await expect(local).toHaveAttribute('aria-pressed', String(selected === 'local'));
      // These assertions precede click(), which would auto-scroll a hidden tab.
      await expect(local).toBeInViewport({ ratio: 0.99 });
      await expect(ssh).toBeInViewport({ ratio: 0.99 });
      await local.click();
      await expect(local).toHaveAttribute('aria-pressed', 'true');
    });
  }
}

test('selecting SSH from a local tab keeps its header visible when the remote tools open', async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 730 });
  const tabs = Array.from({ length: 11 }, (_, i): SavedTab =>
    i >= 3 && i % 2 === 1
      ? { id: `local-${i}`, name: 'zsh', tabType: 'local-terminal' }
      : { id: `ssh-${i}`, name: 'QA server', tabType: 'terminal', protocol: 'SSH' });
  await page.addInitScript(seedLayout, { tabs, activeTabId: 'local-9' });
  await page.goto('/');

  const strip = page.locator('[data-tab-bar-group="1"]');
  const remote = strip.locator('[data-tab-id="ssh-10"]');
  const remoteButton = remote.locator('button[aria-pressed]');
  await expect(strip.locator('[data-tab-id="local-9"] button[aria-pressed]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#right-sidebar')).toHaveCount(0);
  const localWidth = await strip.evaluate(el => el.clientWidth);

  await remoteButton.click();
  await expect(remoteButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#right-sidebar')).toBeVisible();
  await expect.poll(() => strip.evaluate(el => el.clientWidth)).toBeLessThan(localWidth - 100);
  // Measure the whole header after the real panels resize. Another locator
  // interaction here would scroll the target back into view and mask the bug.
  await expect(remote).toBeInViewport({ ratio: 0.99 });
});
