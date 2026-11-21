import { test, expect, routePlaylist, seedPlaylist, enterTab, SAMPLE_M3U, type Page } from './helpers';

// The Settings card screen. The other Settings specs drive the option panes
// behind it; this one runs with the app's own entry point.
test.use({ startViewBaseline: 'app-default' });

const back = (page: Page) => page.evaluate(() =>
  document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));

async function openCards(page: Page): Promise<void> {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await enterTab(page, 'settings');
  await expect(page.locator('#view-prefs')).toBeVisible();
}

test('the Settings tab opens the card screen, in three columns, with the device identifiers', async ({ page }) => {
  await openCards(page);

  await expect(page.locator('#view-prefs .prefs-title')).toHaveText('Settings');
  await expect(page.locator('#view-prefs .prefs-eyebrow')).toContainText('Version');
  await expect(page.locator('#view-prefs .prefs-group-title'))
    .toHaveText(['Privacy and visibility', 'History and data', 'Format and playback', 'System']);
  await expect(page.locator('#prefs-mac')).toHaveText(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  await expect(page.locator('#prefs-key')).toHaveText('123 456');

  // Three cards share the first row, and the title is not hidden under the top bar.
  const tops = await page.locator('#view-prefs .prefs-group').first().locator('.prefs-card')
    .evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().top)));
  // The focused card is drawn a pixel bolder, so compare within that.
  expect(tops).toHaveLength(3);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
  const title = (await page.locator('#view-prefs .prefs-title').boundingBox())!;
  expect(title.y).toBeGreaterThan(96);
  // Focus starts on the first card.
  await expect(page.locator('#view-prefs .prefs-card.focused')).toHaveAttribute('data-card-id', 'language');
});

test('a switch card flips and keeps its value, and the language card changes the language at once', async ({ page }) => {
  await openCards(page);

  const refresh = page.locator('.prefs-card[data-card-id="auto-refresh"]');
  await expect(refresh.locator('.prefs-switch')).toHaveText('On');
  await refresh.click();
  await expect(refresh.locator('.prefs-switch')).toHaveText('Off');
  await expect(page.locator('#prefs-value-auto-refresh')).toHaveText('Disabled');
  expect(await page.evaluate(() => localStorage.getItem('iptv_playlist_refresh_interval_hours'))).toBe('0');

  // System -> Português: the screen itself is redrawn in the new language.
  await page.locator('.prefs-card[data-card-id="language"]').click();
  await expect(page.locator('#view-prefs .prefs-title')).toHaveText('Configurações');
  await expect(page.locator('#prefs-value-language')).toHaveText('Português (Brasil)');
});

test('an empty history has nothing to clear', async ({ page }) => {
  await openCards(page);

  await expect(page.locator('#prefs-value-clear-movies')).toHaveText('Empty');
  await page.locator('.prefs-card[data-card-id="clear-movies"]').click();
  await expect(page.locator('#view-prefs')).toBeVisible();
  await expect(page.locator('#prefs-value-clear-movies')).toHaveText('Empty');
});

test('a card opens its option pane, and Back returns to the cards', async ({ page }) => {
  await openCards(page);

  await page.locator('.prefs-card[data-card-id="appearance"]').click();
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('.settings-nav-item.active')).toHaveAttribute('data-settings-target', 'appearance');

  await back(page);
  await expect(page.locator('#view-prefs')).toBeVisible();
  await expect(page.locator('#view-settings')).toBeHidden();

  // The card that is not available yet does nothing.
  await page.locator('.prefs-card[data-card-id="cloud"]').click({ force: true });
  await expect(page.locator('#view-prefs')).toBeVisible();
  await expect(page.locator('#prefs-value-cloud')).toHaveText('Coming soon');
});

test('the stream pane shows a panel access by name only: no server address, no account fields', async ({ page }) => {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const url = 'http://host.example.com:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts';
  await page.route('**/api/device/v1/check-activation', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      activated: true, status: 'active', expiry_date: '2030-01-05 00:00:00', trial: false, lifetime: false,
      domain: '', has_playlist: false, manage_key: '123456',
      web_playlists: [{ id: 1, name: 'N1', m3u_url: url }],
      server_time: Math.floor(Date.now() / 1000),
    }),
  }));
  await page.addInitScript(() => {
    if (localStorage.getItem('iptv_playlists')) return;
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'xsol-web-1', name: 'N1', url: 'http://host.example.com:8080', source: 'xtream',
      xtream: { username: 'u1', password: 'p1' },
    }]));
  });
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.locator('.prefs-card[data-card-id="stream"]').click();

  const pane = page.locator('#settings-sources');
  await expect(pane.locator('.xtream-managed-name')).toHaveText('N1');
  await expect(pane.locator('.xtream-url')).toBeHidden();
  await expect(pane.locator('.xtream-username')).toBeHidden();
  await expect(pane.locator('.xtream-password')).toBeHidden();
  await expect(pane.locator('#add-xtream')).toBeHidden();
  await expect(pane.locator('.remove-xtream')).toBeHidden();
  // The stream format is what remains to choose.
  await expect(pane.locator('.xtream-output .dropdown')).toBeVisible();

  // Saving from here keeps the stored access intact.
  await page.locator('#save-settings').click();
  await expect(page.locator('#view-prefs')).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'));
  expect(stored).toMatchObject([{
    id: 'xsol-web-1', name: 'N1', url: 'http://host.example.com:8080', xtream: { username: 'u1', password: 'p1' },
  }]);
});
