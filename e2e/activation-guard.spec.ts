import {
  test, expect, enterTab, neuterVideo, routeLiveManifest, routePlaylist, seedPlaylist, type Page, enterSettings
} from './helpers';

// What the app does with the activation state while it runs: lock on expiry or a
// block, unlock on renewal, and report presence to the panel.

interface Panel {
  status: 'active' | 'expired' | 'blocked';
  heartbeats: Array<{ body: Record<string, unknown>; signed: boolean }>;
}

async function scriptedPanel(page: Page, status: Panel['status'] = 'active'): Promise<Panel> {
  const panel: Panel = { status, heartbeats: [] };
  await page.route('**/api/device/v1/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/device\/v1\//, '');
    const serverTime = Math.floor(Date.now() / 1000);
    let payload: Record<string, unknown> = { success: true };
    if (path === 'register') {
      payload = {
        success: true, device_secret: 's'.repeat(64), device_token: 't'.repeat(64), manage_key: '123456',
        activated: panel.status === 'active', status: panel.status,
      };
    } else if (path === 'check-activation') {
      payload = {
        activated: panel.status === 'active', status: panel.status,
        expiry_date: '2030-01-05 00:00:00', trial: false, lifetime: false,
        domain: '', has_playlist: false, manage_key: '123456',
      };
    } else if (path === 'heartbeat') {
      panel.heartbeats.push({
        body: request.postDataJSON() ?? {},
        signed: !!request.headers()['x-device-signature'],
      });
      payload = { success: true, online: true };
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ ...payload, server_time: serverTime }),
    });
  });
  return panel;
}

async function boot(page: Page): Promise<void> {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
}

function key(page: Page, keyCode: number): Promise<void> {
  return page.evaluate(
    code => { document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })); },
    keyCode,
  );
}

for (const status of ['expired', 'blocked'] as const) {
  test(`a device the panel has ${status} gets the Access screen and nothing else`, async ({ page }) => {
    await scriptedPanel(page, status);
    await boot(page);

    await expect(page.locator('#view-access')).toBeVisible();
    await expect(page.locator('#access-status'))
      .toHaveText(status === 'expired' ? 'Activation expired' : 'Device blocked');
    await expect(page.locator('#access-locked')).toBeVisible();
    // The MAC and key stay on screen: they are what the customer needs to renew.
    await expect(page.locator('#access-key')).toHaveText('123 456');

    // Neither the bar, nor the Settings key, nor the guide key leads anywhere else.
    await enterTab(page, 'live');
    await expect(page.locator('#view-access')).toBeVisible();
    await expect(page.locator('#view-channels')).toBeHidden();
    await key(page, 406);
    await expect(page.locator('#view-settings')).toBeHidden();
    await key(page, 403);
    await expect(page.locator('#view-epg')).toBeHidden();
    await expect(page.locator('#view-access')).toBeVisible();

    // Back cannot leave the screen either; it offers to exit the app.
    await key(page, 27);
    await expect(page.locator('#view-access')).toBeVisible();
    await expect(page.locator('.toast.visible')).toContainText('again');
  });
}

test('renewing the activation unlocks the app without a restart', async ({ page }) => {
  const panel = await scriptedPanel(page, 'expired');
  await boot(page);
  await expect(page.locator('#access-locked')).toBeVisible();

  panel.status = 'active';
  await page.locator('[data-access-action="refresh"]').click();

  await expect(page.locator('#access-status')).toHaveText('Activated');
  await expect(page.locator('#access-locked')).toHaveCount(0);
  await enterTab(page, 'live');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);
});

test('the lock survives a restart with the panel unreachable', async ({ page }) => {
  await scriptedPanel(page, 'expired');
  await boot(page);
  await expect(page.locator('#access-locked')).toBeVisible();

  await page.route('**/api/device/v1/**', route => route.abort());
  await page.reload();

  await expect(page.locator('#view-access')).toBeVisible();
  await expect(page.locator('#access-status')).toHaveText('Activation expired');
  await expect(page.locator('#view-channels')).toBeHidden();
});

test('a device blocked while in use is locked at the next check', async ({ page }) => {
  await page.clock.install();
  const panel = await scriptedPanel(page);
  await boot(page);
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.locator('.channel-main .channel-item').first().click();
  await expect(page.locator('#view-player')).toBeVisible();

  panel.status = 'blocked';
  await page.clock.fastForward('05:01');

  await expect(page.locator('#view-access')).toBeVisible();
  await expect(page.locator('#view-player')).toBeHidden();
  await expect(page.locator('#access-status')).toHaveText('Device blocked');
});

test('reports presence to the panel, with what is playing', async ({ page }) => {
  await page.clock.install();
  const panel = await scriptedPanel(page);
  await boot(page);
  await expect(page.locator('#view-channels')).toBeVisible();

  // Right after the first activation check: online, nothing playing.
  await expect.poll(() => panel.heartbeats.length).toBeGreaterThan(0);
  expect(panel.heartbeats[0].signed).toBe(true);
  expect(panel.heartbeats[0].body).toMatchObject({ watching_type: '', watching_title: '' });

  await page.locator('.channel-main .channel-item').first().click();
  await expect(page.locator('#view-player')).toBeVisible();
  const before = panel.heartbeats.length;
  await page.clock.fastForward('01:01');

  await expect.poll(() => panel.heartbeats.length).toBeGreaterThan(before);
  expect(panel.heartbeats[panel.heartbeats.length - 1].body)
    .toMatchObject({ watching_type: 'live', watching_title: 'Channel One' });
});

test('an active device is never locked out of its own screens', async ({ page }) => {
  await scriptedPanel(page);
  await boot(page);

  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSettings(page);
  await expect(page.locator('#view-settings')).toBeVisible();
});
