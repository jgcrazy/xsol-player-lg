import { test as base, expect, type Page } from '@playwright/test';
import { postTargetApis, removeApis } from '../scripts/chromium-53-simulation.mjs';

export { expect, type Page };

export const PLAYLIST_URL = 'http://host.example.com/playlist.m3u';

export const SAMPLE_M3U = [
  '#EXTM3U url-tvg="http://epg.example.com/guide.xml"',
  '#EXTINF:-1 tvg-id="one" group-title="News",Channel One',
  'http://streams.example.com/one.m3u8',
  '#EXTINF:-1 tvg-id="two" group-title="Movies",Channel Two',
  'http://streams.example.com/two.m3u8',
].join('\n');

export const SEARCH_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="News",Alpha News',
  'http://streams.example.com/1.m3u8',
  '#EXTINF:-1 group-title="News",Beta News',
  'http://streams.example.com/2.m3u8',
  '#EXTINF:-1 group-title="Entertainment",Alpha Movies',
  'http://streams.example.com/3.m3u8',
  '#EXTINF:-1 group-title="Sports",Delta Sports',
  'http://streams.example.com/4.m3u8',
].join('\n');

// A minimal segment-less *live* HLS manifest: hls.js reaches MANIFEST_PARSED and
// just polls for live segments — no fatal error, so no auto-zap to the next
// channel and the OSD keeps showing channel info.
export const LIVE_MANIFEST =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';

/** Serve an M3U body for the configured playlist URL (glob-matched by filename). */
/**
 * Stand-in for the activation panel. Matched by path, so no spec ever reaches a
 * real server; a spec that cares registers its own route afterwards and wins.
 */
export async function stubPanel(page: Page): Promise<void> {
  await page.route('**/api/device/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const serverTime = Math.floor(Date.now() / 1000);
    const body = path.endsWith('/register')
      ? {
          success: true, reissued: false, device_secret: 's'.repeat(64),
          device_token: 't'.repeat(64), manage_key: '123456', server_time: serverTime,
          activated: true, status: 'active', expiry_date: '2030-01-01 00:00:00', trial: false, lifetime: false,
        }
      : path.endsWith('/check-activation')
        ? {
            activated: true, status: 'active', expiry_date: '2030-01-01 00:00:00', trial: false,
            lifetime: false, domain: '', has_playlist: false, ownership_ok: true,
            manage_key: '123456', server_time: serverTime,
          }
        : { success: true, server_time: serverTime };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });
}

export async function routePlaylist(page: Page, body = SAMPLE_M3U): Promise<void> {
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body }));
}

/** Serve the minimal live manifest for any *.m3u8 stream. */
export async function routeLiveManifest(page: Page): Promise<void> {
  await page.route('**/*.m3u8', (route) =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: LIVE_MANIFEST }));
}

export async function readUserDataStore<T>(
  page: Page,
  storeName: string,
): Promise<{ key: string; value: T }[]> {
  return page.evaluate((store) => new Promise((resolve, reject) => {
    const open = indexedDB.open('iptv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      tx.oncomplete = () => db.close();
    };
  }), storeName) as Promise<{ key: string; value: T }[]>;
}

/**
 * Keep VOD alive in the player by neutering the <video> element so an empty mock
 * movie/episode body can't fire `error` and auto-eject back to the catalog. The
 * player's VOD error handler (player.ts `onError`) calls the very `onBack()` the
 * Back key uses, so without this the eject races the test's own scripted
 * navigation and drops the detail screen. Must run before the page loads.
 */
export async function neuterVideo(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const P = HTMLMediaElement.prototype;
    P.load = function () { /* no-op */ };
    P.play = function () { return Promise.resolve(); };
    Object.defineProperty(P, 'src', { configurable: true, set() { /* no-op */ }, get() { return ''; } });
  });
}

/** Pre-seed one configured URL playlist so the app boots into the channel list. */
export async function seedPlaylist(page: Page, url = PLAYLIST_URL): Promise<void> {
  await page.addInitScript((u) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'Test', url: u }]));
  }, url);
}

/**
 * First run (no source configured) lands on the Access screen. Specs about
 * Settings itself start from there with the Blue key, the remote's Settings
 * shortcut, which leaves the pointer where it was.
 */
export async function gotoFirstRunSettings(page: Page): Promise<void> {
  await page.goto('/');
  await openFirstRunSettings(page);
}

/** Same as gotoFirstRunSettings, for a spec that reloads to apply a stored preference. */
export async function reloadFirstRunSettings(page: Page): Promise<void> {
  await page.reload();
  await openFirstRunSettings(page);
}

async function openFirstRunSettings(page: Page): Promise<void> {
  await expect(page.locator('#view-access')).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 406, bubbles: true }),
  ));
  await expect(page.locator('#view-settings')).toBeVisible();
}

/** Enter a section via the docked tab bar (always visible for an Xtream account).
 *  Uses a coordinate mouse press so the click carries clientX/clientY for the tab
 *  bar's coordinate hit-test. */
export async function enterTab(
  page: Page,
  section: 'home' | 'live' | 'epg' | 'movies' | 'series' | 'access' | 'settings' | 'search',
): Promise<void> {
  // The guide and the Access screen have no item of their own in the bar.
  if (section === 'epg') {
    // The Red key only means something once the app has a view up.
    await expect(page.locator('.tab-bar-item[data-section="live"]')).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(
      new KeyboardEvent('keydown', { keyCode: 403, bubbles: true }),
    ));
    return;
  }
  if (section === 'access') {
    await enterTab(page, 'home');
    await page.locator('#view-home [data-section="access"]').click();
    return;
  }
  const tab = page.locator(`.tab-bar-item[data-section="${section}"]`);
  await expect(tab).toBeVisible();
  const box = await tab.boundingBox();
  if (!box) throw new Error(`tab ${section} has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

// Both channel rows have a fixed height because their lists are virtualized, so
// their two text lines overflow into the neighbouring row instead of growing it.
// Returns the row's inner height and the height its text actually needs, adding
// the secondary line first when the fixture has no EPG data for it.
export async function measureRowTextFit(
  page: Page,
  rowSelector: string,
  infoClass: string,
  secondLineClass: string,
): Promise<{ available: number; needed: number }> {
  const row = page.locator(rowSelector).first();
  await expect(row).toBeVisible();
  return row.evaluate(
    (el: HTMLElement, [info, second]) => {
      const box = el.querySelector<HTMLElement>(`.${info}`);
      if (!box) throw new Error(`row has no .${info}`);
      if (!box.querySelector(`.${second}`)) {
        const line = document.createElement('div');
        line.className = second;
        line.textContent = 'Programme';
        box.appendChild(line);
      }
      const style = getComputedStyle(el);
      const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      return {
        available: el.getBoundingClientRect().height - chrome,
        needed: box.scrollHeight,
      };
    },
    [infoClass, secondLineClass],
  );
}

// Computed once per worker: walking the compat data per test is wasteful.
const POST_TARGET_APIS = postTargetApis();

// Every spec imports `test` from here; it stands in for the activation panel
// before each test so no file has to repeat it.
export const test = base.extend<{
  livePreviewBaseline: 'off' | 'app-default';
  startViewBaseline: 'channels' | 'app-default';
}>({
  // The app ships with Live preview on, which turns "select a channel" into an
  // in-list preview. Most specs are about full-screen playback, so the suite
  // starts from Off unless a spec asks for the shipped default. A stored
  // preference, including one the app itself saves, is never overwritten.
  livePreviewBaseline: ['off', { option: true }],
  // Likewise the app ships with a home screen, while nearly every spec is about a
  // view it reaches from the channel list. The suite boots there unless a spec opts out.
  startViewBaseline: ['channels', { option: true }],
  page: async ({ page, livePreviewBaseline, startViewBaseline }, use, testInfo) => {
    if (livePreviewBaseline === 'off') {
      await page.addInitScript(() => {
        if (localStorage.getItem('iptv_live_preview') === null) {
          localStorage.setItem('iptv_live_preview', 'false');
        }
      });
    }
    if (startViewBaseline === 'channels') {
      await page.addInitScript(() => {
        if (localStorage.getItem('iptv_start_view') === null) {
          localStorage.setItem('iptv_start_view', '"channels"');
        }
      });
    }
    // The simulation project strips every API Chromium 53 lacks before the app
    // loads, so unguarded use fails here instead of on a TV.
    if (testInfo.project.name === 'chromium-53-simulation') {
      await page.addInitScript(removeApis, POST_TARGET_APIS);
    }
    await stubPanel(page);
    await use(page);
  },
});

// The simulation project runs with Chromium 53's API surface. Assertions that
// merely *introspect* through a newer API (rather than exercise app behavior)
// cannot run there; the behavior they observe is covered by the `chromium`
// project.
export const isChromium53 = (): boolean => test.info().project.name === 'chromium-53-simulation';
