import { test, expect, enterTab, routePlaylist, seedPlaylist } from './helpers';

// App bootstrap / first run.

test('opens the Access screen on first run when no playlist is configured', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-access')).toBeVisible();
  // The MAC is generated on the TV; the key and the activation come from the panel.
  await expect(page.locator('#access-mac')).toHaveText(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  await expect(page.locator('#access-key')).toHaveText('123 456');
  await expect(page.locator('#access-status')).toHaveText('Activated');
  await expect(page.locator('#view-access img.access-qr')).toBeVisible();
  await expect(page.locator('.tab-bar-item.active')).toHaveAttribute('data-section', 'access');
});

test('a playlist saved on the portal reaches the TV while the Access screen is open', async ({ page }) => {
  await routePlaylist(page);
  let linked = false;
  await page.route('**/api/device/v1/check-activation', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      activated: true, status: 'active', expiry_date: '2030-01-01 00:00:00', trial: false, lifetime: false,
      domain: linked ? 'http://host/playlist.m3u' : '', has_playlist: linked,
      manage_key: '123456', server_time: Math.floor(Date.now() / 1000),
    }),
  }));
  await page.goto('/');
  await expect(page.locator('#access-key')).toHaveText('123 456');
  await expect(page.locator('#view-access')).toBeVisible();

  linked = true;

  // The next poll picks it up; no key press on the TV.
  await expect(page.locator('#view-channels')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Channel One')).toBeVisible();
  const sources = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'));
  expect(sources).toMatchObject([{ id: 'xsol-panel', url: 'http://host/playlist.m3u', source: 'url' }]);
});

test('Back from the Access screen leaves it, and the Access tab returns to it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-access')).toBeVisible();
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  });
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'access');
  await expect(page.locator('#view-access')).toBeVisible();
  await expect(page.locator('#access-key')).toHaveText('123 456');
});

test('loads and renders channels from a configured playlist', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);

  await page.goto('/');

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.getByText('Channel One')).toBeVisible();
  await expect(page.getByText('Channel Two')).toBeVisible();
});
