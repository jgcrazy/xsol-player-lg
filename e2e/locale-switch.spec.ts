import { test, expect, routePlaylist, seedPlaylist, enterTab, enterSettings, backToLive } from './helpers';

test('switching between the two languages refreshes cached Recently Watched labels', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');

  const recentLabel = page.locator(
    '[data-group="builtin:recently-watched"] .group-name',
  );
  await expect(recentLabel).toHaveText('Recently Watched');

  const locales = [
    ['pt-BR', 'Assistidos recentemente'],
    ['en', 'Recently Watched'],
  ];
  for (const [locale, label] of locales) {
    await enterSettings(page, 'appearance');
    await page.locator('#app-language .dropdown-trigger').click();
    await page.locator(`#app-language [data-dropdown-value="${locale}"]`).click();
    await page.locator('#save-settings').click();
    await backToLive(page);
    await expect(recentLabel).toHaveText(label);
  }
});
