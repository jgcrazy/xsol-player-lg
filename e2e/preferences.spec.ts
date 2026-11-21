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
  const firstRow = tops.slice(0, 3);
  expect(Math.max(...firstRow) - Math.min(...firstRow)).toBeLessThanOrEqual(2);
  expect(tops[3]).toBeGreaterThan(tops[0] + 100);
  const title = (await page.locator('#view-prefs .prefs-title').boundingBox())!;
  expect(title.y).toBeGreaterThan(96);
  // Focus starts on the first card.
  await expect(page.locator('#view-prefs .prefs-card.focused')).toHaveAttribute('data-card-id', 'parental');
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

test('hiding a TV category removes it and its channels, and showing it brings them back', async ({ page }) => {
  await routePlaylist(page, [
    '#EXTM3U',
    '#EXTINF:-1 group-title="Alpha",ch1', 'http://host/ch1.m3u8',
    '#EXTINF:-1 group-title="Bravo",ch2', 'http://host/ch2.m3u8',
    '#EXTINF:-1 group-title="Bravo",ch3', 'http://host/ch3.m3u8',
  ].join('\n'));
  await seedPlaylist(page);
  await page.goto('/');
  await enterTab(page, 'settings');

  const card = page.locator('.prefs-card[data-card-id="hide-live"]');
  await expect(page.locator('#prefs-value-hide-live')).toHaveText('All visible');
  await expect(card.locator('.prefs-switch')).toHaveText('Off');
  await card.click();

  // The list of categories, each one a switch.
  await expect(page.locator('#view-prefs .prefs-title')).toHaveText('Hide TV categories');
  await expect(page.locator('.prefs-row .prefs-row-name')).toHaveText(['Alpha', 'Bravo']);
  await page.locator('.prefs-row[data-row-key="Bravo"]').click();
  await expect(page.locator('.prefs-row[data-row-key="Bravo"] .prefs-switch')).toHaveText('Hidden');

  // Back returns to the cards, with the card saying what is hidden. The pointer
  // is parked first: left over the list, it would land on a card and take focus.
  await page.mouse.move(960, 20);
  await back(page);
  await expect(page.locator('#prefs-value-hide-live')).toHaveText('1 category hidden');
  await expect(card.locator('.prefs-switch')).toHaveText('On');
  await expect(card).toHaveClass(/focused/);

  await enterTab(page, 'live');
  await expect(page.locator('#view-channels .group-name')).not.toContainText(['Bravo']);
  await expect(page.locator('#view-channels .channel-item .channel-name')).toHaveText(['ch1']);

  // Showing it again restores the category and its channels.
  await enterTab(page, 'settings');
  await card.click();
  await page.locator('.prefs-row[data-row-key="Bravo"]').click();
  await back(page);
  await expect(page.locator('#prefs-value-hide-live')).toHaveText('All visible');
  await enterTab(page, 'live');
  await expect(page.locator('#view-channels .channel-item')).toHaveCount(3);
});

test('hiding a movie category removes it from Movies; an access without a catalog says so', async ({ page }) => {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const action = params.get('action');
    let body: unknown = [];
    if (action === 'get_vod_categories') {
      body = [{ category_id: '1', category_name: 'Cat A' }, { category_id: '2', category_name: 'Cat B' }];
    } else if (action === 'get_vod_streams') {
      const all = [
        { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
        { stream_id: 20, name: 'Movie Two', stream_icon: '', container_extension: 'mp4', category_id: '2' },
      ];
      const category = params.get('category_id');
      body = category ? all.filter(movie => movie.category_id === category) : all;
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
  await page.goto('/');
  await enterTab(page, 'settings');

  await page.locator('.prefs-card[data-card-id="hide-movies"]').click();
  await expect(page.locator('.prefs-row .prefs-row-name')).toHaveText(['Cat A', 'Cat B']);
  await page.locator('.prefs-row[data-row-key="Cat A"]').click();
  await back(page);
  await expect(page.locator('#prefs-value-hide-movies')).toHaveText('1 category hidden');

  await enterTab(page, 'movies');
  const provider = page.locator('#view-movies .catalog-cat:not([data-category-id^="~"]) .catalog-cat-name');
  await expect(provider).toHaveText(['Cat B']);
  await expect(page.locator('#view-movies .catalog-grid .catalog-tile-name')).toHaveText(['Movie Two']);

  // This account has no series: the list explains instead of staying empty.
  await enterTab(page, 'settings');
  await page.locator('.prefs-card[data-card-id="hide-series"]').click();
  await expect(page.locator('.prefs-picker-empty')).toHaveText('Not available on this access');
});

test('the time format card switches every clock between 24 and 12 hours, and it sticks', async ({ page }) => {
  await openCards(page);
  const clock = page.locator('.tab-bar-time');
  await expect(clock).toHaveText(/^\d{2}:\d{2}$/);
  await expect(page.locator('#prefs-value-time-format')).toHaveText('24 hours');

  await page.locator('.prefs-card[data-card-id="time-format"]').click();

  await expect(page.locator('#prefs-value-time-format')).toHaveText('12 hours');
  await expect(clock).toHaveText(/^\d{1,2}:\d{2} (AM|PM)$/);

  await page.reload();
  await expect(page.locator('.tab-bar-time')).toHaveText(/^\d{1,2}:\d{2} (AM|PM)$/);
});

const type = async (page: Page, digits: string): Promise<void> => {
  for (const digit of digits) await page.locator(`.pin-prompt [data-pin-key="${digit}"]`).click();
};

test('parental control asks for a PIN twice to turn on, then guards Settings and Access', async ({ page }) => {
  await openCards(page);
  const card = page.locator('.prefs-card[data-card-id="parental"]');
  await expect(card.locator('.prefs-switch')).toHaveText('Off');

  // Two different entries are refused; the same PIN twice turns it on.
  await card.click();
  await expect(page.locator('#pin-title')).toHaveText('Create a PIN');
  await type(page, '1234');
  await expect(page.locator('#pin-title')).toHaveText('Repeat the PIN');
  await type(page, '9999');
  await expect(page.locator('#pin-title')).toHaveText('Create a PIN');
  await expect(page.locator('#pin-hint')).toHaveText('The two PINs were different. Start again.');
  await type(page, '1234');
  await type(page, '1234');
  await expect(page.locator('.pin-prompt')).toBeHidden();
  await expect(card.locator('.prefs-switch')).toHaveText('On');
  // Only a digest is kept.
  expect(await page.evaluate(() => localStorage.getItem('iptv_parental'))).not.toContain('1234');

  // Leaving and coming back to Settings now needs the PIN; a wrong one stays out.
  await enterTab(page, 'home');
  await expect(page.locator('#view-home')).toBeVisible();
  await enterTab(page, 'settings');
  await expect(page.locator('#pin-title')).toHaveText('Enter the PIN');
  await expect(page.locator('#view-prefs')).toBeHidden();
  await type(page, '0000');
  await expect(page.locator('#pin-hint')).toHaveText('Wrong PIN. Try again.');
  await expect(page.locator('#view-prefs')).toBeHidden();
  await type(page, '1234');
  await expect(page.locator('#view-prefs')).toBeVisible();

  // The Access screen is guarded the same way; Cancel leaves things as they were.
  await enterTab(page, 'home');
  await page.locator('#view-home [data-section="access"]').click();
  await expect(page.locator('#pin-title')).toHaveText('Enter the PIN');
  await page.locator('.pin-prompt [data-pin-key="cancel"]').click();
  await expect(page.locator('.pin-prompt')).toBeHidden();
  await expect(page.locator('#view-home')).toBeVisible();

  // TV, Movies and Series are never asked for it.
  await enterTab(page, 'live');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.pin-prompt')).toBeHidden();
});

test('a forgotten PIN is recovered with the device key, which turns parental control off', async ({ page }) => {
  await openCards(page);
  await page.locator('.prefs-card[data-card-id="parental"]').click();
  await type(page, '1234');
  await type(page, '1234');
  await enterTab(page, 'home');
  await enterTab(page, 'settings');

  await page.locator('.pin-prompt [data-pin-key="link"]').click();
  await expect(page.locator('#pin-title')).toHaveText('Enter the device key');
  await expect(page.locator('.pin-dot')).toHaveCount(6);
  await type(page, '000000');
  await expect(page.locator('#pin-hint')).toContainText('not this device');
  await type(page, '123456');

  await expect(page.locator('#view-prefs')).toBeVisible();
  await expect(page.locator('.prefs-card[data-card-id="parental"] .prefs-switch')).toHaveText('Off');
});
