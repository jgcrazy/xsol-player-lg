import { writeFileSync } from 'node:fs';
import { test, expect, neuterVideo, routeLiveManifest, enterTab, type Page } from './helpers';

// Captures the LG Content Store screenshots from the real app over synthetic data.
// Skipped unless STORE_SHOTS_DIR is set; see store/README.md.
test.skip(!process.env.STORE_SHOTS_DIR, 'store screenshots are generated on demand');
test.use({
  timezoneId: 'America/Sao_Paulo',
  startViewBaseline: 'app-default',
  livePreviewBaseline: 'off',
  viewport: { width: 1920, height: 1080 },
});

const OUT = process.env.STORE_SHOTS_DIR ?? '';
const HOST = 'http://host.example.com:8080';

const GROUPS: Record<string, string[]> = {
  News: ['News 1', 'News 2', 'News 3', 'World News'],
  Sports: ['Sports 1', 'Sports 2', 'Sports Extra', 'Arena'],
  Cinema: ['Cinema 1', 'Cinema 2', 'Cinema Classics', 'Premiere'],
  Kids: ['Kids 1', 'Kids 2', 'Cartoons'],
  Music: ['Music 1', 'Music 2', 'Live Concerts'],
  Documentary: ['Nature', 'Science', 'History'],
};
const CHANNELS = Object.entries(GROUPS).flatMap(([group, names]) => names.map((name) => ({ group, name })));
const HUES = [210, 28, 340, 150, 270, 45, 190, 10, 300, 90];

function initials(name: string): string {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function logoSvg(name: string, hue: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<rect width="96" height="96" rx="20" fill="hsl(${hue},45%,30%)"/>
<text x="48" y="60" font-family="Arial, sans-serif" font-size="38" font-weight="700" text-anchor="middle" fill="#fff">${initials(name)}</text></svg>`;
}

function posterSvg(title: string, hue: number): string {
  const words = title.split(' ');
  const lines = words.length > 2 ? [words.slice(0, 2).join(' '), words.slice(2).join(' ')] : [title];
  const text = lines.map((l, i) => `<text x="150" y="${300 + i * 36}" font-family="Georgia, serif" font-size="30" text-anchor="middle" fill="#f4ece0">${l}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,34%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},60%,12%)"/></linearGradient>
<radialGradient id="s" cx="50%" cy="32%" r="45%"><stop offset="0" stop-color="hsl(${hue},80%,70%)" stop-opacity=".55"/><stop offset="1" stop-color="hsl(${hue},80%,70%)" stop-opacity="0"/></radialGradient></defs>
<rect width="300" height="450" fill="url(#g)"/><rect width="300" height="450" fill="url(#s)"/>
<circle cx="150" cy="150" r="58" fill="none" stroke="#f4ece0" stroke-opacity=".5" stroke-width="3"/>${text}</svg>`;
}

const MOVIES = [
  'Silent Harbor', 'Crimson Valley', 'The Last Signal', 'Paper Moons', 'Iron Orchard', 'Winter Lantern',
  'Echo Drive', 'Hollow Crown', 'Glass Meridian', 'Northern Tide', 'Velvet Static', 'Amber Road',
  'Salt and Smoke', 'Midnight Atlas', 'Quiet Engines', 'Golden Hour',
];
const SERIES = ['Harbor Lights', 'The Long Table', 'Parallel Streets', 'Dust and Stars', 'Cold Frontier', 'Open Water'];

function pad(n: number): string { return String(n).padStart(2, '0'); }

function xmltv(): string {
  const day = '20261121';
  const programmes: string[] = [];
  const titles: Record<string, string[]> = {
    News: ['Morning Edition', 'Headlines', 'Midday Report', 'Evening News', 'The Debate', 'Late Edition'],
    Sports: ['Match Day', 'Highlights', 'Live Match', 'Sports Center', 'The Classic', 'Replay'],
    Cinema: ['Feature Film', 'Matinee', 'Prime Cinema', 'Night Feature', 'Short Stories', 'Cult Hour'],
    Kids: ['Cartoon Hour', 'Adventure Club', 'Story Time', 'Funny Friends', 'Puzzle Time', 'Bedtime'],
    Music: ['Top Hits', 'Acoustic Session', 'Live Set', 'Chart Show', 'Classics', 'Night Mix'],
    Documentary: ['Wild Planet', 'Deep Sea', 'Ancient Worlds', 'Space Frontier', 'How It Works', 'Great Voyages'],
  };
  CHANNELS.forEach((channel, index) => {
    const id = `c${index + 1}`;
    const list = titles[channel.group];
    // Back-to-back programmes from 14:00, one to two hours each, running past midnight.
    let minutes = 14 * 60;
    let slot = 0;
    while (minutes < 26 * 60) {
      const length = 60 + ((index + slot) % 3) * 30;
      const end = minutes + length;
      const stamp = (m: number) => {
        const d = m >= 24 * 60 ? '20261122' : day;
        const mm = m % (24 * 60);
        return `${d}${pad(Math.floor(mm / 60))}${pad(mm % 60)}00 -0300`;
      };
      programmes.push(`<programme channel="${id}" start="${stamp(minutes)}" stop="${stamp(end)}"><title>${list[slot % list.length]}</title><desc>Demo programme.</desc></programme>`);
      minutes = end;
      slot++;
    }
  });
  const channels = CHANNELS.map((c, i) => `<channel id="c${i + 1}"><display-name>${c.name}</display-name></channel>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><tv>${channels}${programmes.join('')}</tv>`;
}

async function seed(page: Page): Promise<void> {
  const m3u = ['#EXTM3U'].concat(CHANNELS.flatMap((c, i) => [
    `#EXTINF:-1 tvg-id="c${i + 1}" tvg-logo="${HOST}/logo/${i}.svg" group-title="${c.group}",${c.name}`,
    `http://streams.example.com/${i + 1}.m3u8`,
  ])).join('\n');
  await page.route('**/get.php*', (route) => route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: m3u }));
  await page.route('**/xmltv.php*', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: xmltv() }));
  await page.route('**/logo/*.svg', (route) => {
    const i = Number(route.request().url().match(/logo\/(\d+)/)![1]);
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: logoSvg(CHANNELS[i].name, HUES[i % HUES.length]) });
  });
  await page.route('**/poster/*.svg', (route) => {
    const m = route.request().url().match(/poster\/(m|s)(\d+)/)!;
    const title = (m[1] === 'm' ? MOVIES : SERIES)[Number(m[2])];
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: posterSvg(title, HUES[(Number(m[2]) * 3) % HUES.length]) });
  });
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('get_vod_categories')) return json([{ category_id: '1', category_name: 'Drama' }, { category_id: '2', category_name: 'Adventure' }]);
    if (url.includes('get_vod_streams')) {
      return json(MOVIES.map((name, i) => ({
        stream_id: 100 + i, name, stream_icon: `${HOST}/poster/m${i}.svg`, container_extension: 'mp4',
        category_id: i % 2 ? '2' : '1', rating: String(6 + (i % 4)), added: String(1700000000 - i * 86400), year: String(2015 + (i % 10)),
      })));
    }
    if (url.includes('get_series_categories')) return json([{ category_id: '1', category_name: 'Drama' }]);
    if (url.includes('get_series')) {
      return json(SERIES.map((name, i) => ({
        series_id: 200 + i, name, cover: `${HOST}/poster/s${i}.svg`, category_id: '1', rating: String(7 + (i % 3)), last_modified: String(1700000000 - i * 86400),
      })));
    }
    return json({});
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'Demo', url: 'http://host.example.com:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
    localStorage.setItem('iptv_locale_preference', '"en"');
  });
}

const press = (page: Page, code: number) => page.evaluate(
  (k) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })), code);

async function shot(page: Page, name: string): Promise<void> {
  await page.addStyleTag({ content: '.toast { display: none !important; }' });
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/store-${name}.png` });
}

// Numbered UI elements for the LG UX scenario document (store/ux-scenario.md):
// [selector, name, what it does]. Elements that are not on screen are skipped.
type Marker = [string, string, string];

async function annotate(page: Page, name: string, markers: Marker[]): Promise<void> {
  const items: { n: number; name: string; text: string; x: number; y: number; w: number; h: number }[] = [];
  for (const [selector, label, text] of markers) {
    const box = await page.locator(selector).first().boundingBox().catch(() => null);
    if (!box) continue;
    items.push({ n: items.length + 1, name: label, text, x: box.x, y: box.y, w: box.width, h: box.height });
  }
  writeFileSync(`${OUT}/ux-${name}.json`, JSON.stringify(items, null, 2));
}

const TAB = (id: string): string => `.tab-bar-item[data-section="${id}"]`;

test('captures the store screenshots', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.setFixedTime(new Date('2026-11-21T20:40:00-03:00'));
  await seed(page);
  await neuterVideo(page);
  await routeLiveManifest(page);
  await page.goto('/');

  await expect(page.locator('#view-home')).toBeVisible();
  // Watch one channel first, so the home card has somewhere to resume.
  await enterTab(page, 'live');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '2-live');
  await annotate(page, '2-live', [
    ['.tab-bar-items', 'Section bar', 'Switches between Home, Live, Movies, Series, Settings and Search. Left/Right moves, OK opens.'],
    ['.tab-bar-legend', 'Colour-key legend', 'Shows what the Red, Green, Yellow and Blue keys do on this screen.'],
    ['.group-item', 'Channel group', 'A group of channels. Up/Down moves, OK shows its channels, Right goes to the channel list.'],
    ['.channel-item', 'Channel', 'A live channel. OK plays it full screen; Back returns here. Green marks it as a favorite.'],
  ]);
  await press(page, 13);
  await page.waitForTimeout(800);
  await press(page, 27);
  await enterTab(page, 'home');
  await expect(page.locator('#view-home [data-home-action="resume"]')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '1-home');
  await annotate(page, '1-home', [
    ['.tab-bar-brand', 'App name and logo', 'XSol Player logo; not a button.'],
    ['[data-home-action="resume"]', 'Resume', 'OK plays the last watched channel.'],
    ['[data-section="live"]', 'Section card', 'Opens a section (Live, Movies, Series, Access, Settings). Left/Right moves between cards.'],
    ['.home-channel', 'On-air channel', 'A featured channel. OK plays it.'],
  ]);

  await press(page, 403); // Red: the guide
  await expect(page.locator('#view-epg')).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, '3-guide');
  await annotate(page, '3-guide', [
    ['.tab-bar-items', 'Section bar', 'The Red key opens the Guide and leaves it again.'],
    ['#view-epg', 'Program guide', 'Channels on the left, programs on a timeline. Up/Down changes channel, Left/Right moves in time, OK opens a program (play, catch-up, reminder).'],
  ]);
  await press(page, 403);

  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-tile').first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await shot(page, '4-movies');
  await annotate(page, '4-movies', [
    ['#view-movies .catalog-search', 'Search box', 'OK focuses the field to search movies by title.'],
    ['#view-movies .catalog-cat', 'Category', 'A movie category. OK shows its movies.'],
    ['#view-movies .catalog-tile', 'Movie poster', 'A movie. OK opens its detail page with Play, trailer-style info and a watchlist button. Green adds it to favorites.'],
    ['.tab-bar-legend', 'Colour-key legend', 'Green: favorite. Yellow: change sort. Red/Blue as labeled.'],
  ]);

  await enterTab(page, 'series');
  await expect(page.locator('#view-series .catalog-tile').first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  await shot(page, '5-series');
  await annotate(page, '5-series', [
    ['#view-series .catalog-search', 'Search box', 'OK focuses the field to search series by title.'],
    ['#view-series .catalog-cat', 'Category', 'A series category. OK shows its series.'],
    ['#view-series .catalog-tile', 'Series poster', 'A series. OK opens its seasons and episodes. Green adds it to favorites.'],
    ['.tab-bar-legend', 'Colour-key legend', 'Green: favorite. Yellow: change sort. Red/Blue as labeled.'],
  ]);

  await enterTab(page, 'home');
  await enterTab(page, 'search');
  await page.locator('.tab-bar-search-input').fill('s');
  await page.waitForTimeout(1500);
  await shot(page, '6-search');
  await annotate(page, '6-search', [
    ['.tab-bar-search-input', 'Search field', 'Type with the on-screen keyboard (or the remote); results update as you type across channels, programs, movies and series.'],
  ]);
  await page.locator('.tab-bar-search-input').fill('');

  await enterTab(page, 'settings');
  await expect(page.locator('#view-prefs')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '7-settings');
  await annotate(page, '7-settings', [
    ['.prefs-card-title', 'Setting card', 'A group of settings (playlists, language, parental control, data). OK opens it.'],
    ['.prefs-back', 'Back', 'Returns to the previous screen. The Blue key does the same.'],
  ]);
});
