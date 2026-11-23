import { expect, test } from '@playwright/test';

test.use({
  baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL ?? 'http://localhost:1420',
  reducedMotion: 'reduce',
});

for (const stripWidth of [128, 203]) {
  for (const selected of ['ssh', 'local']) {
    test(`Move Tab Right keeps both headers visible in a ${stripWidth}px strip with ${selected} selected`, async ({ page }) => {
      await page.addInitScript(activeTabId => {
        const tabs = [
          { id: 'ssh', name: 'production-application-analytics-primary', tabType: 'terminal', protocol: 'SSH' },
          { id: 'local', name: 'zsh', tabType: 'local-terminal' },
        ].map(tab => ({ ...tab, reconnectCount: 0, connectionStatus: 'pending' }));
        localStorage.setItem('r-shell-language', 'zh-CN');
        localStorage.setItem('r-shell-terminal-groups', JSON.stringify({
          version: 2,
          data: {
            groups: { '1': { id: '1', tabs, activeTabId } },
            activeGroupId: '1', nextGroupId: 2,
            gridLayout: { type: 'leaf', groupId: '1' },
            tabToGroupMap: { ssh: '1', local: '1' },
          },
        }));
      }, selected);
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
