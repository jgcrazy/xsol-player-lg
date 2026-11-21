import {
  test,
  expect,
  routePlaylist,
  seedPlaylist,
  type Page,
} from './helpers';

// What the app asks of the bundled service at startup. The service has two
// jobs left, both for program reminders: reporting Developer Mode, and raising
// the interactive alert there. It no longer hosts anything on the LAN.

interface StartupProbe {
  methods: string[];
  loadingAtDevModeQuery: boolean[];
  activities: Array<{ name: string; method: string; replace: boolean }>;
}

async function installStartupHarness(page: Page, devMode: boolean): Promise<void> {
  await page.addInitScript((isDevMode) => {
    type Cb = (resp: unknown) => void;
    type LunaParameters = {
      activity?: { name?: string; callback?: { method?: string } };
      replace?: boolean;
    };
    const probe: StartupProbe = { methods: [], loadingAtDevModeQuery: [], activities: [] };
    const pendingDevMode: Cb[] = [];
    const win = window as unknown as {
      __startupProbe__?: StartupProbe;
      __releaseDevMode__?: () => void;
      PalmServiceBridge?: unknown;
    };
    win.__startupProbe__ = probe;
    win.__releaseDevMode__ = () => {
      for (const callback of pendingDevMode.splice(0)) callback({ devmode: isDevMode });
    };
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private cancelled = false;

      private respond(response: unknown): void {
        setTimeout(() => {
          if (!this.cancelled) this.onservicecallback?.(JSON.stringify(response));
        }, 0);
      }

      call(uri: string, payload: string): void {
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const parameters = JSON.parse(payload) as LunaParameters;
        probe.methods.push(method);
        if (method === 'getDevMode') {
          const loading = document.querySelector<HTMLElement>('#view-loading');
          probe.loadingAtDevModeQuery.push(loading !== null && !loading.classList.contains('hidden'));
          pendingDevMode.push((response) => this.respond(response));
        } else if (method === 'create') {
          const activity = parameters.activity;
          probe.activities.push({
            name: activity?.name ?? '',
            method: activity?.callback?.method ?? '',
            replace: parameters.replace === true,
          });
          this.respond({ returnValue: true });
        } else {
          this.respond({ returnValue: false, errorText: `unmocked method: ${method}` });
        }
      }

      cancel(): void {
        this.cancelled = true;
      }
    }
    win.PalmServiceBridge = FakePalmServiceBridge;
  }, devMode);
}

async function releaseDevMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __releaseDevMode__: () => void }).__releaseDevMode__();
  });
}

async function startupProbe(page: Page): Promise<StartupProbe> {
  return page.evaluate(() =>
    (window as unknown as { __startupProbe__: StartupProbe }).__startupProbe__);
}

async function seedReminder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      channelKey: '8a9c7c8b',
      channelName: 'Alpha',
      title: 'Bravo',
      startMs: now + 60000,
      stopMs: now + 120000,
    }]));
  });
}

test('channels render before the service is asked anything', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await installStartupHarness(page, false);

  await page.goto('/');

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);
  // The probe is off the critical path: by the time it goes out, loading is over.
  await expect.poll(async () => (await startupProbe(page)).loadingAtDevModeQuery).toEqual([false]);
});

test('the app never starts, stops or subscribes to a LAN service', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await installStartupHarness(page, false);
  const lanRequests: string[] = [];
  page.on('request', (request) => {
    if (/^http:\/\/127\.0\.0\.1[:/]/.test(request.url())) lanRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect.poll(async () => (await startupProbe(page)).methods).toContain('getDevMode');
  await releaseDevMode(page);
  // Backgrounding and returning used to stop and restart the LAN server.
  await page.evaluate(() => {
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });

  const methods = (await startupProbe(page)).methods;
  for (const method of ['start', 'stop', 'heartbeat', 'serviceEvents']) {
    expect(methods).not.toContain(method);
  }
  expect(lanRequests).toEqual([]);
});

test('dev-mode query replaces the reminder fallback activity', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await seedReminder(page);
  await installStartupHarness(page, true);

  await page.goto('/');
  await expect.poll(async () => (await startupProbe(page)).activities.length).toBe(1);
  expect((await startupProbe(page)).activities[0].method)
    .toBe('luna://com.webos.notification/createToast');

  await releaseDevMode(page);
  await expect.poll(async () => (await startupProbe(page)).activities.length).toBe(2);
  const [fallback, devAlert] = (await startupProbe(page)).activities;
  expect(devAlert.name).toBe(fallback.name);
  expect(fallback.replace).toBe(true);
  expect(devAlert.replace).toBe(true);
  expect(devAlert.method).toBe('luna://com.xsol.player.service/fireReminderAlert');
});

test('a retail TV keeps the toast reminder', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await seedReminder(page);
  await installStartupHarness(page, false);

  await page.goto('/');
  await expect.poll(async () => (await startupProbe(page)).activities.length).toBe(1);
  await releaseDevMode(page);

  await expect.poll(async () => (await startupProbe(page)).activities.length).toBe(2);
  const activities = (await startupProbe(page)).activities;
  expect(activities.every(activity => activity.method === 'luna://com.webos.notification/createToast'))
    .toBe(true);
});
