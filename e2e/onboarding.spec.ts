import { test, expect, enterTab, routePlaylist, seedPlaylist, type Page } from './helpers';

// App bootstrap / first run.

test('opens the Access screen on first run when no playlist is configured', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-access')).toBeVisible();
  // The MAC is generated on the TV; the key and the activation come from the panel.
  await expect(page.locator('#access-mac')).toHaveText(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  await expect(page.locator('#access-key')).toHaveText('123 456');
  await expect(page.locator('#access-status')).toHaveText('Activated');
  await expect(page.locator('#view-access img.access-qr')).toBeVisible();
  // Access has no item of its own in the bar; it sits under Home.
  await expect(page.locator('.tab-bar-item.active')).toHaveAttribute('data-section', 'home');
});

// A panel whose answers a test can change as it goes. Registered after the
// fixture's stand-in, so it wins.
interface PanelState {
  domain: string;
  name: string;
  calls: Array<{ path: string; body: Record<string, unknown>; signed: boolean }>;
  redeem: Record<string, unknown>;
}

async function scriptedPanel(page: Page): Promise<PanelState> {
  const state: PanelState = { domain: '', name: '', calls: [], redeem: { success: false, message: 'code_not_found' } };
  await page.route('**/api/device/v1/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/device\/v1\//, '');
    const body = request.postDataJSON() ?? {};
    state.calls.push({ path, body, signed: !!request.headers()['x-device-signature'] });
    const serverTime = Math.floor(Date.now() / 1000);
    let status = 200;
    let payload: Record<string, unknown> = { success: true };
    if (path === 'register') {
      payload = {
        success: true, device_secret: 's'.repeat(64), device_token: 't'.repeat(64), manage_key: '123456',
        activated: true, status: 'active',
      };
    } else if (path === 'check-activation') {
      payload = {
        activated: true, status: 'active', expiry_date: '2030-01-05 00:00:00', trial: false, lifetime: false,
        domain: state.domain, has_playlist: state.domain !== '', manage_key: '123456',
        web_playlists: state.domain ? [{ id: 1, name: state.name, m3u_url: state.domain }] : [],
      };
    } else if (path === 'redeem-playlist-code') {
      payload = state.redeem;
      status = payload.success === true ? 200 : 404;
    } else if (path === 'save-playlist') {
      state.domain = String(body.playlist_url);
      state.name = 'Saved from TV';
    }
    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ ...payload, server_time: serverTime }),
    });
  });
  return state;
}

test('a playlist saved on the portal reaches the TV while the Access screen is open', async ({ page }) => {
  await routePlaylist(page);
  const panel = await scriptedPanel(page);
  await page.goto('/');
  await expect(page.locator('#access-key')).toHaveText('123 456');
  await expect(page.locator('#access-playlist')).toHaveText('None linked yet');
  await expect(page.locator('#access-status-detail')).toHaveText(/^Valid until /);

  panel.domain = 'http://host/playlist.m3u';
  panel.name = 'N1';

  // The next poll picks it up, with no key press on the TV, and the screen says so.
  await expect(page.locator('#access-playlist')).toHaveText('N1', { timeout: 15_000 });
  await expect(page.locator('#view-access')).toBeVisible();
  await expect(page.locator('.toast.visible')).toContainText('2 channels');
  const sources = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'));
  expect(sources).toMatchObject([{ id: 'xsol-panel', url: 'http://host/playlist.m3u', source: 'url' }]);

  // Back now leads to the channels the playlist brought.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  });
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.getByText('Channel One')).toBeVisible();
});

test('the Refresh button turns while it checks', async ({ page }) => {
  await scriptedPanel(page);
  await page.goto('/');
  await expect(page.locator('#access-key')).toHaveText('123 456');
  const refresh = page.locator('[data-access-action="refresh"]');
  await expect(refresh).not.toHaveClass(/is-refreshing/);

  await refresh.click();

  await expect(refresh).toHaveClass(/is-refreshing/);
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  const animated = await page.locator('.access-refresh-icon')
    .evaluate(icon => getComputedStyle(icon).animationName);
  expect(animated).toBe('access-spin');
  await expect(refresh).not.toHaveClass(/is-refreshing/);
});

test('signing in on the TV with server, username and password', async ({ page }) => {
  const m3u = 'http://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts';
  await page.route('http://host:8080/**', route => route.fulfill({ status: 404, body: '' }));
  const panel = await scriptedPanel(page);
  await page.goto('/');
  await expect(page.locator('#access-key')).toHaveText('123 456');

  await page.locator('[data-access-action="login-account"]').click();
  await page.locator('[data-access-field="server"]').fill('host:8080');
  await page.locator('[data-access-field="username"]').fill('u1');
  await page.locator('[data-access-field="password"]').fill('p1');
  await page.locator('[data-access-action="login-submit"]').click();

  await expect(page.locator('#access-playlist')).toHaveText('Saved from TV', { timeout: 15_000 });
  const bind = panel.calls.find(call => call.path === 'bind-account')!;
  expect(bind.signed).toBe(true);
  expect(bind.body).toMatchObject({ username: 'u1', password: 'p1', server_host: 'http://host:8080', manual: true });
  const save = panel.calls.find(call => call.path === 'save-playlist')!;
  expect(save.signed).toBe(true);
  expect(save.body.playlist_url).toBe(m3u);
  // The account becomes an Xtream source, so Movies and Series work.
  const sources = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'));
  expect(sources).toMatchObject([{
    id: 'xsol-panel', source: 'xtream', url: 'http://host:8080', xtream: { username: 'u1', password: 'p1' },
  }]);
});

test('signing in with a code that names only the server asks for the account', async ({ page }) => {
  await page.route('http://host:8080/**', route => route.fulfill({ status: 404, body: '' }));
  const panel = await scriptedPanel(page);
  await page.goto('/');
  await expect(page.locator('#access-key')).toHaveText('123 456');

  await page.locator('[data-access-action="login-code"]').click();
  await page.locator('[data-access-field="code"]').fill('99999');
  await page.locator('[data-access-action="login-submit"]').click();
  await expect(page.locator('#access-notice')).toHaveText('Code not found. Check it and try again.');
  await expect(page.locator('[data-access-field="code"]')).toHaveValue('99999');

  panel.redeem = { success: true, m3u_url: 'http://host:8080' };
  await page.locator('[data-access-field="code"]').fill('12345');
  await page.locator('[data-access-action="login-submit"]').click();

  await expect(page.locator('.access-locked-server')).toHaveText('http://host:8080');
  await expect(page.locator('[data-access-field="server"]')).toHaveCount(0);
  await page.locator('[data-access-field="username"]').fill('u1');
  await page.locator('[data-access-field="password"]').fill('p1');
  await page.locator('[data-access-action="login-submit"]').click();

  await expect(page.locator('#access-playlist')).toHaveText('Saved from TV', { timeout: 15_000 });
  expect(panel.calls.find(call => call.path === 'redeem-playlist-code' && call.body.code === '12345')).toBeTruthy();
  expect(panel.calls.find(call => call.path === 'bind-account')!.body.server_host).toBe('http://host:8080');
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
