import { test, expect, routeLiveManifest, routePlaylist, seedPlaylist, neuterVideo, type Page } from './helpers';

// The home screen: what the app opens on once channels are loaded.
test.use({ startViewBaseline: 'app-default' });

const CARD = '#view-home .home-card';

async function boot(page: Page): Promise<void> {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator(CARD)).toHaveCount(5);
}

function back(page: Page): Promise<void> {
  return page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  });
}

test('opens on the home screen with the sections and the channel count', async ({ page }) => {
  await boot(page);

  await expect(page.locator('.tab-bar-item.active')).toHaveAttribute('data-section', 'home');
  await expect(page.locator('#home-greeting')).toHaveText(/^Good (morning|afternoon|evening)$/);
  await expect(page.locator('#home-status')).toHaveText('2 channels available');
  await expect(page.locator(`${CARD} .home-card-title`))
    .toHaveText(['Live TV', 'Movies', 'Series', 'Access', 'Settings']);
  await expect(page.locator('[data-count-for="live"]')).toHaveText('2 channels');
  // An M3U-only setup has no catalogue behind Movies and Series.
  await expect(page.locator('[data-count-for="movies"]')).toHaveText('Needs an Xtream account');
  await expect(page.locator('[data-count-for="series"]')).toHaveText('Needs an Xtream account');
  // Nothing watched yet: no resume, and focus starts on the first section.
  await expect(page.locator('[data-home-action="resume"]')).toHaveCount(0);
  await expect(page.locator(`${CARD}.focused`)).toHaveAttribute('data-section', 'live');
  await expect(page.locator('#home-activation')).not.toHaveText('—');
});

test('lays the blocks out in rows that fit the screen', async ({ page }) => {
  await boot(page);

  const layout = await page.evaluate(() => {
    const boxes = (selector: string) => Array.from(document.querySelectorAll(selector))
      .map(element => element.getBoundingClientRect());
    const cards = boxes('#view-home .home-card');
    const channels = boxes('#view-home .home-channel');
    const hero = document.querySelector('.home-welcome')!.getBoundingClientRect();
    const last = document.querySelector('.home-last')!.getBoundingClientRect();
    const footer = document.querySelector('.home-footer')!.getBoundingClientRect();
    const bar = document.querySelector('.tab-bar')!.getBoundingClientRect();
    const sameRow = (list: DOMRect[]) => list.every(box => Math.abs(box.top - list[0].top) < 1);
    const noOverlap = (list: DOMRect[]) => list.every((box, i) => i === 0 || box.left >= list[i - 1].right);
    const widths = (list: DOMRect[]) => list.map(box => Math.round(box.width));
    return {
      cardsRow: sameRow(cards) && noOverlap(cards),
      cardWidths: widths(cards),
      cardGap: Math.round(cards[1].left - cards[0].right),
      channelsRow: sameRow(channels) && noOverlap(channels),
      channelGap: channels.length > 1 ? Math.round(channels[1].left - channels[0].right) : null,
      heroBesideLast: hero.right <= last.left,
      heroGap: Math.round(last.left - hero.right),
      lastSize: [Math.round(last.width), Math.round(last.height)],
      belowBar: last.top >= bar.bottom,
      cardsBelowHero: cards[0].top >= last.bottom,
      channelsBelowCards: channels[0].top >= cards[0].bottom,
      footerBelowChannels: footer.top >= channels[0].bottom,
      footerBottom: Math.round(footer.bottom),
      scrolls: document.documentElement.scrollHeight > window.innerHeight,
    };
  });

  expect(layout.cardsRow).toBe(true);
  expect(Math.max(...layout.cardWidths) - Math.min(...layout.cardWidths)).toBeLessThanOrEqual(1);
  expect(layout.cardGap).toBe(18);
  expect(layout.channelsRow).toBe(true);
  expect(layout.channelGap).toBe(14);
  expect(layout.heroBesideLast).toBe(true);
  expect(layout.heroGap).toBe(40);
  expect(layout.lastSize).toEqual([774, 496]);
  expect(layout.belowBar).toBe(true);
  expect(layout.cardsBelowHero).toBe(true);
  expect(layout.channelsBelowCards).toBe(true);
  expect(layout.footerBelowChannels).toBe(true);
  expect(layout.footerBottom).toBe(1080);
  expect(layout.scrolls).toBe(false);
});

test('a section card opens its section, and Back from it returns home', async ({ page }) => {
  await boot(page);

  await page.locator(`${CARD}[data-section="live"]`).click();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.tab-bar-item.active')).toHaveAttribute('data-section', 'live');
  await back(page);
  await expect(page.locator('#view-home')).toBeVisible();

  await page.locator(`${CARD}[data-section="access"]`).click();
  await expect(page.locator('#view-access')).toBeVisible();
  await expect(page.locator('#access-key')).toHaveText('123 456');
  await back(page);
  await expect(page.locator('#view-home')).toBeVisible();

  await page.locator(`${CARD}[data-section="settings"]`).click();
  await expect(page.locator('#view-settings')).toBeVisible();
});

test('the D-pad walks the cards and OK opens the focused one', async ({ page }) => {
  await boot(page);

  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`${CARD}.focused`)).toHaveAttribute('data-section', 'movies');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`${CARD}.focused`)).toHaveAttribute('data-section', 'live');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-home .home-channel.focused')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('Up from the top of the home screen reaches the bar, and TV opens the list', async ({ page }) => {
  await boot(page);

  // From the card row: the hero's button, then the bar.
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-home-action="all"].focused')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar-item.focused')).toHaveAttribute('data-section', 'home');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('a featured channel plays, and the home screen then offers to resume it', async ({ page }) => {
  await boot(page);

  await page.locator('#view-home .home-channel').nth(1).click();
  await expect(page.locator('#view-player')).toBeVisible();
  // Park the pointer: left over the row, it would take focus again on return, as a Magic Remote does.
  await page.mouse.move(960, 300);
  await back(page);
  await expect(page.locator('#view-channels')).toBeVisible();
  await back(page);
  await expect(page.locator('#view-home')).toBeVisible();

  await expect(page.locator('#home-last-name')).toHaveText('Channel Two');
  const resume = page.locator('[data-home-action="resume"]');
  await expect(resume).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
});

test('Back on the home screen asks before leaving the app', async ({ page }) => {
  await boot(page);

  await back(page);

  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('.toast.visible')).toContainText('again');
});

test('uses the bundled typefaces', async ({ page }) => {
  await boot(page);

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = (selector: string) => getComputedStyle(document.querySelector(selector)!).fontFamily;
    return {
      greeting: family('#home-greeting'),
      status: family('#home-status'),
      loaded: Array.from(document.fonts).filter(face => face.status === 'loaded').map(face => face.family),
    };
  });

  expect(fonts.greeting).toContain('Newsreader');
  expect(fonts.status).toContain('Manrope');
  expect(fonts.loaded).toContain('Newsreader');
  expect(fonts.loaded).toContain('Manrope');
});
