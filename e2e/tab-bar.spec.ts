import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab, enterSettings, backToLive } from './helpers';

// Seed one Xtream account so the tab bar is enabled; its get.php serves the
// sample M3U so the channels view loads normally.
async function seedXtream(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

test('the tab bar is docked (always visible) and offsets the content below it', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Always visible on the channels view — no pointer reveal needed.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item')).toHaveText(['Home', 'TV', 'Movies', 'Series', 'Settings', '']);
  // Search is the far-right magnifier icon (no text label).
  await expect(page.locator('.tab-bar-item[data-section="search"] svg')).toBeVisible();
  // Docked → the view sits below the bar (top offset applied via the body class).
  await expect(page.locator('body.tabbar-docked')).toHaveCount(1);
});

test('clicking the Movies tab enters the Movies view', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();
});

test('the guide opens below the docked bar under TV, and Back returns to the list', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg')).toBeVisible();
  // The guide has no item of its own: the bar stays docked with TV lit.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item[data-section="epg"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="live"].active')).toHaveCount(1);
  const bar = (await page.locator('.tab-bar').boundingBox())!;
  const epg = (await page.locator('#view-epg .epg-view').boundingBox())!;
  expect(epg.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);

  await page.keyboard.press('Escape');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.tab-bar-item[data-section="live"].active')).toHaveCount(1);
});

test('the Red key leaves the guide and the Blue key leaves Settings', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  const press = (code: number) => page.evaluate(
    (k) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })), code);

  await press(403);
  await expect(page.locator('#view-epg')).toBeVisible();
  await press(403);
  await expect(page.locator('#view-channels')).toBeVisible();

  await press(406);
  await expect(page.locator('#view-prefs')).toBeVisible();
  await press(406);
  await expect(page.locator('#view-prefs')).toBeHidden();
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('the legend beside the sections tells what the colour keys do on each screen', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  const legend = page.locator('.tab-bar-legend-item');

  await expect(legend).toHaveText(['Guide', 'Favorite', 'Edit', 'Settings']);
  await enterTab(page, 'movies');
  await expect(legend).toHaveText(['Guide', 'Favorite', 'Sort', 'Settings']);
  await enterTab(page, 'epg');
  await expect(legend).toHaveText(['Back', 'Search', 'Settings']);
  await enterSettings(page);
  await expect(legend).toHaveText(['Guide', 'Back']);

  // It stays clear of the sections: nothing overlaps the first icon.
  const bar = (await page.locator('.tab-bar-legend').boundingBox())!;
  const first = (await page.locator('.tab-bar-item').first().boundingBox())!;
  expect(bar.x + bar.width).toBeLessThanOrEqual(first.x);
});

test('the Settings tab (after Series) opens the settings view', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterSettings(page);
  await expect(page.locator('#view-settings')).toBeVisible();
});

test('the tab bar is hidden during full-screen playback', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.tab-bar')).toBeVisible();

  // Play the focused channel; the player takes over full-screen and the bar hides.
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.tab-bar')).toBeHidden();
  await expect(page.locator('body.tabbar-docked')).toHaveCount(0);
});

test('the search box keeps the current view until a query is typed, then covers it', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Open the search box from the channels view.
  await enterTab(page, 'search');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();

  // No results view yet (no "Type to search" hint covering the content).
  await expect(page.locator('#view-search')).toBeHidden();
  await expect(page.locator('#view-channels')).toBeVisible();

  // Typing shows the results view over the current one.
  await page.locator('.tab-bar-search-input').fill('Channel');
  await expect(page.locator('#view-search')).toBeVisible();

  // Clearing the box restores the underlying view.
  await page.locator('.tab-bar-search-input').fill('');
  await expect(page.locator('#view-search')).toBeHidden();
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('opening Search does not cancel the catalog loading underneath it', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  let releaseCategories = () => {};
  let markCategoriesRequested = () => {};
  const categoriesRequested = new Promise<void>((resolve) => {
    markCategoriesRequested = resolve;
  });
  const categoryGate = new Promise<void>((resolve) => {
    releaseCategories = resolve;
  });
  await page.route('**/player_api.php*', async (route) => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'get_vod_categories') {
      markCategoriesRequested();
      await categoryGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]),
      });
      return;
    }
    if (action === 'get_vod_streams') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          stream_id: '10',
          name: 'Movie One',
          category_id: '1',
          container_extension: 'mp4',
        }]),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'movies');
  await categoriesRequested;
  await enterTab(page, 'search');
  releaseCategories();

  await expect(page.locator('#view-movies')).toContainText('Movie One');
});

test('M3U-only shows a docked bar with Home/TV/Settings/Search only (no Movies/Series)', async ({ page }) => {
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { name: 'Test', url: 'http://host.example.com/playlist.m3u' },
    ]));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // The bar is docked, but with the reduced M3U section set.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item')).toHaveText(['Home', 'TV', 'Settings', '']);
  await expect(page.locator('.tab-bar-item[data-section="movies"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="series"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="search"] svg')).toBeVisible();
  await expect(page.locator('body.tabbar-docked')).toHaveCount(1);

  // The search magnifier sits right before the clock's divider.
  const clock = (await page.locator('.tab-bar-clock').boundingBox())!;
  const icon = (await page.locator('.tab-bar-search .search-icon').boundingBox())!;
  expect(clock.x - (icon.x + icon.width)).toBe(34);
  const inner = (await page.locator('.tab-bar-inner').boundingBox())!;
  expect((inner.x + inner.width) - (clock.x + clock.width)).toBeLessThan(1);
});

test('no playlist or account configured shows Home/TV/Settings/Search only (no Movies/Series)', async ({ page }) => {
  // Seed nothing — first run opens the Access screen with the bar docked.
  await page.goto('/');
  await expect(page.locator('#view-access')).toBeVisible();

  // The docked bar must not offer the Xtream-only Movies/Series sections.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item[data-section="movies"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="series"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item')).toHaveText(['Home', 'TV', 'Settings', '']);
});

test('Cancel in a Settings category returns to the cards, still under Settings', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterSettings(page);
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('.tab-bar-item.active')).toHaveText('Settings');

  await page.locator('#cancel-settings').click();
  await expect(page.locator('#view-prefs')).toBeVisible();
  await expect(page.locator('.tab-bar-item.active')).toHaveText('Settings');

  // Leaving for the list moves the active tab with it.
  await enterTab(page, 'live');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.tab-bar-item.active')).toHaveText('TV');
});
