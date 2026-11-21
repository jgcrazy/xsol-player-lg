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
    } else if (path === 'delete-device-web-playlist' || path === 'delete-playlist') {
      state.domain = '';
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
  await expect(page.locator('.access-row-name')).toHaveText('N1', { timeout: 15_000 });
  await expect(page.locator('#view-access')).toBeVisible();
  await expect(page.locator('.toast.visible')).toContainText('2 channels');
  const sources = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'));
  expect(sources).toMatchObject([{ id: 'xsol-web-1', name: 'N1', url: 'http://host/playlist.m3u', source: 'url' }]);

  // Back now leads to the channels the playlist brought.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  });
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.getByText('Channel One')).toBeVisible();
});

test('a playlist saved on the portal shows up even before it is set as the active one', async ({ page }) => {
  await routePlaylist(page);
  let saved = false;
  await page.route('**/api/device/v1/check-activation', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      activated: true, status: 'active', expiry_date: '2030-01-05 00:00:00', trial: false, lifetime: false,
      // "Add" on the portal stores the playlist; nothing makes it the device's active one.
      domain: '', has_playlist: false, manage_key: '123456',
      web_playlists: saved ? [{ id: 5, name: 'N1', m3u_url: 'http://host/playlist.m3u' }] : [],
      server_time: Math.floor(Date.now() / 1000),
    }),
  }));
  await page.goto('/');
  await expect(page.locator('#access-playlist')).toHaveText('None linked yet');

  saved = true;

  await expect(page.locator('.access-row-name')).toHaveText('N1', { timeout: 15_000 });
  await expect(page.locator('.toast.visible')).toContainText('2 channels');
  const sources = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'));
  expect(sources).toMatchObject([{ id: 'xsol-web-5', name: 'N1', url: 'http://host/playlist.m3u' }]);
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

// The IPTV server the account is checked against before the panel hears of it.
async function routeXtreamServer(page: Page, password: string): Promise<void> {
  await page.route('http://host:8080/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/player_api.php') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ user_info: { auth: url.searchParams.get('password') === password ? 1 : 0 } }),
    });
  });
}

test('signing in on the TV with a server URL, username and password', async ({ page }) => {
  const m3u = 'http://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts';
  await routeXtreamServer(page, 'p1');
  const panel = await scriptedPanel(page);
  await page.goto('/');
  await expect(page.locator('#access-key')).toHaveText('123 456');

  await page.locator('[data-access-action="login-open"]').click();
  await page.locator('[data-access-field="target"]').fill('host:8080');
  await page.locator('[data-access-field="username"]').fill('u1');
  await page.locator('[data-access-field="password"]').fill('wrong');
  await page.locator('[data-access-action="login-submit"]').click();

  // A mistyped account is caught on the IPTV server: the panel is never told.
  await expect(page.locator('#access-notice')).toHaveText('Wrong username or password.');
  expect(panel.calls.some(call => call.path === 'bind-account')).toBe(false);

  await page.locator('[data-access-field="password"]').fill('p1');
  await page.locator('[data-access-action="login-submit"]').click();

  await expect(page.locator('.access-row-name')).toHaveText('Saved from TV', { timeout: 15_000 });
  const bind = panel.calls.find(call => call.path === 'bind-account')!;
  expect(bind.signed).toBe(true);
  expect(bind.body).toMatchObject({ username: 'u1', password: 'p1', server_host: 'http://host:8080', manual: true });
  const save = panel.calls.find(call => call.path === 'save-playlist')!;
  expect(save.signed).toBe(true);
  expect(save.body.playlist_url).toBe(m3u);
  // The account becomes an Xtream source, so Movies and Series work.
  const sources = await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'));
  expect(sources).toMatchObject([{
    id: 'xsol-web-1', source: 'xtream', url: 'http://host:8080', xtream: { username: 'u1', password: 'p1' },
  }]);
});

test('a playlist code stands for the server it is registered with', async ({ page }) => {
  await routeXtreamServer(page, 'p1');
  const panel = await scriptedPanel(page);
  await page.goto('/');
  await expect(page.locator('#access-key')).toHaveText('123 456');

  await page.locator('[data-access-action="login-open"]').click();
  await page.locator('[data-access-field="target"]').fill('99999');
  await page.locator('[data-access-field="username"]').fill('u1');
  await page.locator('[data-access-field="password"]').fill('p1');
  await page.locator('[data-access-action="login-submit"]').click();
  await expect(page.locator('#access-notice')).toHaveText('Code not found. Check it and try again.');
  await expect(page.locator('[data-access-field="target"]')).toHaveValue('99999');

  panel.redeem = { success: true, m3u_url: 'http://host:8080' };
  await page.locator('[data-access-field="target"]').fill('12345');
  await page.locator('[data-access-action="login-submit"]').click();

  await expect(page.locator('.access-row-name')).toHaveText('Saved from TV', { timeout: 15_000 });
  expect(panel.calls.find(call => call.path === 'redeem-playlist-code' && call.body.code === '12345')).toBeTruthy();
  // The code's server is what the panel matches against its partner list.
  expect(panel.calls.find(call => call.path === 'bind-account')!.body.server_host).toBe('http://host:8080');
  expect(panel.calls.find(call => call.path === 'save-playlist')!.body.playlist_url)
    .toBe('http://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts');
});

test('a code alone asks for the account, keeping the code', async ({ page }) => {
  await routeXtreamServer(page, 'p1');
  const panel = await scriptedPanel(page);
  panel.redeem = { success: true, m3u_url: 'http://host:8080' };
  await page.goto('/');
  await expect(page.locator('#access-key')).toHaveText('123 456');

  await page.locator('[data-access-action="login-open"]').click();
  await page.locator('[data-access-field="target"]').fill('12345');
  await page.locator('[data-access-action="login-submit"]').click();

  await expect(page.locator('#access-notice')).toHaveText('Code accepted. Enter the username and password.');
  await expect(page.locator('[data-access-field="target"]')).toHaveValue('12345');
  await expect(page.locator('[data-access-field="username"]')).toHaveClass(/focused/);
  expect(panel.calls.some(call => call.path === 'bind-account')).toBe(false);
});

test('the configured accesses can be selected and removed', async ({ page }) => {
  await routePlaylist(page);
  const panel = await scriptedPanel(page);
  panel.domain = 'http://host/playlist.m3u';
  panel.name = 'N1';
  await page.addInitScript(() => {
    if (localStorage.getItem('iptv_playlists')) return;
    // The portal list is already known and waiting, switched off, as it arrives
    // while another access is in use.
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'P1', url: 'http://host/playlist.m3u' },
      { id: 'xsol-web-1', name: 'N1', url: 'http://host/playlist.m3u', source: 'url', enabled: false },
    ]));
  });
  await page.goto('/');
  // Only the access in use is loaded: the TV screen shows no second source.
  await expect(page.locator('#view-channels .channel-item')).toHaveCount(2);
  await expect(page.locator('#view-channels .playlist-tab')).toHaveCount(0);
  await enterTab(page, 'access');
  const names = page.locator('.access-row-name');
  await expect(names).toHaveText(['P1', 'N1'], { timeout: 15_000 });
  // Only the access actually in use says so: the portal list arrived switched off.
  await expect(page.locator('.access-row.is-in-use .access-row-name')).toHaveText(['P1']);

  // Selecting one leaves it as the only access in use.
  await page.locator('[data-access-action="use"][data-id="xsol-web-1"]').click();
  await expect(page.locator('.access-row.is-in-use .access-row-name')).toHaveText(['N1']);
  await expect.poll(() => page.evaluate(() =>
    (JSON.parse(localStorage.getItem('iptv_playlists') || '[]') as Array<{ id: string; enabled?: boolean }>)
      .map(item => item.id + ':' + (item.enabled !== false)))).toEqual(['p1:false', 'xsol-web-1:true']);

  // Remove asks once more before it acts, then deletes it on the panel too.
  const remove = page.locator('[data-access-action="remove"][data-id="xsol-web-1"]');
  await remove.click();
  await expect(remove).toHaveText('Confirm removal');
  expect(panel.calls.some(call => call.path === 'delete-device-web-playlist')).toBe(false);
  await remove.click();

  await expect(names).toHaveText(['P1']);
  const deleted = panel.calls.find(call => call.path === 'delete-device-web-playlist')!;
  expect(deleted.signed).toBe(true);
  expect(deleted.body.playlist_id).toBe('1');
  expect(panel.calls.some(call => call.path === 'delete-playlist')).toBe(true);
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
