// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { Access } from './access';
import { ActivationService, type ActivationSnapshot } from '../services/xsol/activation-service';
import { LoginService } from '../services/xsol/login-service';
import { StorageService } from '../services/storage-service';

vi.mock('../utils/qr', () => ({
  qrDataUrl: vi.fn((text: string) => `data:qr,${text}`),
}));

function snapshot(patch: Partial<ActivationSnapshot> = {}): ActivationSnapshot {
  return {
    status: 'active', deviceId: '02:00:00:00:00:01', manageKey: '123456',
    expiryDate: '2030-01-05 00:00:00', trial: false, lifetime: false,
    hasPlaylist: false, playlistName: '', errorCode: '', enforced: true, ...patch,
  };
}

describe('Access', () => {
  let root: HTMLElement;
  let access: Access;
  let current: ActivationSnapshot;
  let refresh: ReturnType<typeof vi.fn>;
  let onPlaylistChanged: ReturnType<typeof vi.fn>;
  let onBack: ReturnType<typeof vi.fn>;
  let onRevealTabBar: ReturnType<typeof vi.fn>;

  const text = (selector: string): string => root.querySelector(selector)?.textContent?.trim() ?? '';
  const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

  beforeEach(() => {
    vi.useFakeTimers();
    StorageService.setPlaylists([]);
    // jsdom has no layout; SpatialNav scrolls the focused control into view.
    Element.prototype.scrollIntoView = vi.fn();
    root = document.createElement('div');
    document.body.appendChild(root);
    current = snapshot();
    refresh = vi.fn(async () => false);
    vi.spyOn(ActivationService, 'snapshot', 'get').mockImplementation(() => current);
    vi.spyOn(ActivationService, 'refresh').mockImplementation(refresh as () => Promise<boolean>);
    onPlaylistChanged = vi.fn();
    onBack = vi.fn();
    onRevealTabBar = vi.fn(() => true);
    access = new Access(root, { onPlaylistChanged, onBack, onRevealTabBar });
  });

  afterEach(() => {
    access.close();
    root.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows the MAC, the grouped key and the portal QR code', async () => {
    access.open();
    await settle();

    expect(text('#access-mac')).toBe('02:00:00:00:00:01');
    expect(text('#access-key')).toBe('123 456');
    expect(root.querySelector('.access-qr')?.getAttribute('src'))
      .toBe(`data:qr,${CONFIG.XSOL.PORTAL_URL}/?device_id=02%3A00%3A00%3A00%3A00%3A01`);
    expect(text('.access-portal-url')).toBe(CONFIG.XSOL.PORTAL_URL.replace(/^https?:\/\//, ''));
  });

  it('shows placeholders, not stale codes, before the panel answers', async () => {
    current = snapshot({ status: 'connecting', deviceId: '', manageKey: '' });
    access.open();
    await settle();

    expect(text('#access-mac')).toBe('—');
    expect(text('#access-key')).toBe('—');
    expect(root.querySelector('img.access-qr')).toBeNull();
    expect(text('#access-status')).toBe('Connecting…');
  });

  it.each([
    [snapshot({ trial: true }), 'Activated', /^Trial until /],
    [snapshot(), 'Activated', /^Valid until /],
    [snapshot({ lifetime: true }), 'Activated', /^No expiry date$/],
    [snapshot({ status: 'expired' }), 'Activation expired', /^$/],
    [snapshot({ status: 'blocked' }), 'Device blocked', /^$/],
    [snapshot({ status: 'offline' }), 'No connection to the server', /^$/],
    [snapshot({ status: 'refused', errorCode: 'device_already_registered' }),
      'Could not register this device', /already registered/],
    [snapshot({ status: 'refused', errorCode: 'credential_revoked' }),
      'Could not register this device', /^Code: credential_revoked$/],
  ])('describes the state %#', async (state, status, detail) => {
    current = state;
    access.open();
    await settle();

    expect(text('#access-status')).toBe(status);
    expect(text('#access-status-detail')).toMatch(detail);
  });

  it('escapes whatever the panel sends', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    current = snapshot({ status: 'refused', deviceId: hostile, manageKey: hostile, errorCode: hostile });
    access.open();
    await settle();

    expect(root.querySelectorAll('img:not(.access-qr)')).toHaveLength(0);
    expect(text('#access-mac')).toBe(hostile);
    expect(text('#access-status-detail')).toContain(hostile);
  });

  it('polls the panel while open and stops when closed', async () => {
    access.open();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CONFIG.XSOL.ACTIVATION_POLL_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    access.close();
    await vi.advanceTimersByTimeAsync(CONFIG.XSOL.ACTIVATION_POLL_INTERVAL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('hands over once the panel delivers a playlist, and stops polling', async () => {
    refresh.mockResolvedValueOnce(true);
    access.open();
    await settle();

    expect(onPlaylistChanged).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CONFIG.XSOL.ACTIVATION_POLL_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not report a playlist that arrives after the view was left', async () => {
    let release: (changed: boolean) => void = () => {};
    refresh.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    access.open();
    access.close();
    release(true);
    await settle();

    expect(onPlaylistChanged).not.toHaveBeenCalled();
  });

  it('starts on Back, and D-pad moves to Refresh, which checks again', async () => {
    access.open();
    await settle();
    expect(root.querySelector('.focused')?.getAttribute('data-access-action')).toBe('back');

    root.querySelector<HTMLElement>('[data-access-action="refresh"]')!.click();
    await settle();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.focused')?.getAttribute('data-access-action')).toBe('refresh');
  });

  it('routes Back and OK on the back button to the host', async () => {
    access.open();
    await settle();

    access.handleAction('select');
    access.handleAction('back');

    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('hands Up from the top row to the tab bar', async () => {
    access.open();
    await settle();

    access.handleAction('up');

    expect(onRevealTabBar).toHaveBeenCalledOnce();
  });

  it('re-renders when the activation state changes underneath it', async () => {
    let notify: (value: ActivationSnapshot) => void = () => {};
    vi.spyOn(ActivationService, 'subscribe').mockImplementation((listener) => {
      notify = listener;
      return () => {};
    });
    access.open();
    await settle();

    current = snapshot({ status: 'blocked' });
    notify(current);

    expect(text('#access-status')).toBe('Device blocked');
  });
  it('explains the lock while the device is expired or blocked, and Back offers to leave the app', async () => {
    current = snapshot({ status: 'expired' });
    vi.spyOn(ActivationService, 'locked', 'get').mockReturnValue(true);
    access.open();
    await settle();

    expect(text('#access-locked')).toMatch(/renew/i);
    // Signing in stays available: a new account or code can bring the device back.
    expect(root.querySelector('[data-access-action="login-open"]')).not.toBeNull();
  });

  it('shows no lock notice on an active device', async () => {
    access.open();
    await settle();

    expect(root.querySelector('#access-locked')).toBeNull();
  });

  it('says so when no access is configured', async () => {
    access.open();
    await settle();
    expect(text('#access-playlist')).toBe('None linked yet');
    expect(root.querySelector('.access-row')).toBeNull();

    // The panel holds one it has not disclosed yet.
    current = snapshot({ hasPlaylist: true, playlistName: '' });
    access.open();
    await settle();
    expect(text('#access-playlist')).toBe('Linked');
  });

  describe('the configured accesses', () => {
    const names = (): string[] => Array.from(root.querySelectorAll('.access-row-name')).map(n => n.textContent ?? '');
    const press = (action: string, id: string): void => {
      root.querySelector<HTMLElement>(`[data-access-action="${action}"][data-id="${id}"]`)!.click();
    };

    beforeEach(() => {
      StorageService.setPlaylists([
        { id: 'p1', name: 'N1', url: 'http://host/a' },
        { id: 'xsol-web-7', name: 'N2', url: 'http://host/b', enabled: false },
      ]);
    });

    it('lists every access, even a single one, as something to select', async () => {
      access.open();
      await settle();
      expect(names()).toEqual(['N1', 'N2']);
      expect(root.querySelectorAll('.access-row.is-in-use .access-row-name')).toHaveLength(1);
      expect(text('.access-row.is-in-use .access-row-state')).toBe('In use');

      StorageService.setPlaylists([{ id: 'p1', name: 'N1', url: 'http://host/a' }]);
      access.open();
      await settle();
      expect(root.querySelectorAll('[data-access-action="use"][data-focusable]')).toHaveLength(1);
    });

    it('selecting one makes it the only access in use and reloads', async () => {
      access.open();
      await settle();

      press('use', 'xsol-web-7');

      const stored = StorageService.getPlaylists();
      expect(stored.map(item => [item.id, item.enabled !== false])).toEqual([['p1', false], ['xsol-web-7', true]]);
      expect(text('.access-row.is-in-use .access-row-name')).toBe('N2');
      expect(onPlaylistChanged).toHaveBeenCalledOnce();
    });

    it('marks only one access as in use, settling a leftover of several on at once', async () => {
      StorageService.setPlaylists([
        { id: 'xsol-web-1', name: 'N1', url: 'http://host/a' },
        { id: 'xsol-web-2', name: 'N2', url: 'http://host/b' },
      ]);
      access.open();
      await settle();

      expect(Array.from(root.querySelectorAll('.access-row.is-in-use .access-row-name')).map(n => n.textContent))
        .toEqual(['N1']);
      // The channels were loaded from both: they have to be reloaded from the one kept.
      expect(onPlaylistChanged).toHaveBeenCalledOnce();
    });

    it('puts the list just signed in with into use', async () => {
      vi.spyOn(LoginService, 'signIn').mockResolvedValue({ status: 'done' });
      refresh.mockImplementation(async () => {
        const stored = StorageService.getPlaylists();
        if (stored.some(item => item.id === 'xsol-web-9')) return false;
        StorageService.setPlaylists([...stored, { id: 'xsol-web-9', name: 'N3', url: 'http://host/c', enabled: false }]);
        return true;
      });
      access.open();
      await settle();
      onPlaylistChanged.mockClear();
      // The portal list that arrived on its own did not take over.
      expect(text('.access-row.is-in-use .access-row-name')).toBe('N1');
      StorageService.setPlaylists(StorageService.getPlaylists().filter(item => item.id !== 'xsol-web-9'));

      root.querySelector<HTMLElement>('[data-access-action="login-open"]')!.click();
      root.querySelector<HTMLInputElement>('[data-access-field="target"]')!.value = '12345';
      root.querySelector<HTMLElement>('[data-access-action="login-submit"]')!.click();
      await settle();

      expect(Array.from(root.querySelectorAll('.access-row.is-in-use .access-row-name')).map(n => n.textContent))
        .toEqual(['N3']);
      expect(onPlaylistChanged).toHaveBeenCalled();
    });

    it('does nothing but say so when the one in use is selected again', async () => {
      access.open();
      await settle();

      press('use', 'p1');

      expect(onPlaylistChanged).not.toHaveBeenCalled();
      expect(text('#access-notice')).toBe('N1 is already the access in use.');
    });

    it('asks twice before removing, and moving away withdraws the question', async () => {
      const remove = vi.spyOn(ActivationService, 'removePlaylist').mockResolvedValue(true);
      access.open();
      await settle();

      press('remove', 'p1');
      expect(text('[data-access-action="remove"][data-id="p1"]')).toBe('Confirm removal');
      expect(remove).not.toHaveBeenCalled();

      access.handleAction('down');
      expect(text('[data-access-action="remove"][data-id="p1"]')).toBe('Remove');

      press('remove', 'p1');
      access.handleAction('back');
      expect(text('[data-access-action="remove"][data-id="p1"]')).toBe('Remove');
      expect(onBack).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('removes on the second press and reloads', async () => {
      const remove = vi.spyOn(ActivationService, 'removePlaylist').mockImplementation(async (id) => {
        StorageService.setPlaylists(StorageService.getPlaylists().filter(item => item.id !== id));
        return true;
      });
      access.open();
      await settle();

      press('remove', 'xsol-web-7');
      press('remove', 'xsol-web-7');
      await settle();

      expect(remove).toHaveBeenCalledWith('xsol-web-7');
      expect(names()).toEqual(['N1']);
      expect(text('#access-notice')).toBe('Access removed.');
      expect(onPlaylistChanged).toHaveBeenCalledOnce();
    });

    it('keeps the access and explains when the panel refuses the removal', async () => {
      vi.spyOn(ActivationService, 'removePlaylist').mockResolvedValue(false);
      access.open();
      await settle();

      press('remove', 'xsol-web-7');
      press('remove', 'xsol-web-7');
      await settle();

      expect(names()).toEqual(['N1', 'N2']);
      expect(text('#access-notice')).toBe('Could not remove it. Check the connection and try again.');
      expect(onPlaylistChanged).not.toHaveBeenCalled();
    });

    it('escapes a playlist name', async () => {
      StorageService.setPlaylists([{ id: 'p1', name: '<img src=x onerror=1>', url: 'http://host/a' }]);
      access.open();
      await settle();
      expect(root.querySelector('.access-row img')).toBeNull();
      expect(names()).toEqual(['<img src=x onerror=1>']);
    });
  });

  it('spins the refresh icon for the whole of a manual check', async () => {
    access.open();
    await settle();
    const button = root.querySelector<HTMLElement>('[data-access-action="refresh"]')!;
    expect(button.classList.contains('is-refreshing')).toBe(false);

    button.click();
    await settle();
    // The panel already answered; the spin still holds long enough to be seen.
    expect(button.classList.contains('is-refreshing')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');

    await vi.advanceTimersByTimeAsync(700);
    expect(button.classList.contains('is-refreshing')).toBe(false);
  });

  describe('signing in on the TV', () => {
    const click = (action: string): void => {
      root.querySelector<HTMLElement>('[data-access-action="' + action + '"]')!.click();
    };
    const type = (field: string, value: string): void => {
      root.querySelector<HTMLInputElement>('[data-access-field="' + field + '"]')!.value = value;
    };
    const value = (field: string): string | undefined =>
      root.querySelector<HTMLInputElement>('[data-access-field="' + field + '"]')?.value;

    it('opens one form from Fill in, and Back closes it before leaving', async () => {
      access.open();
      await settle();
      expect(root.querySelector('.access-form')).toBeNull();

      click('login-open');
      expect(Array.from(root.querySelectorAll<HTMLElement>('[data-access-field]')).map(f => f.dataset.accessField))
        .toEqual(['target', 'username', 'password']);
      expect(root.querySelector<HTMLElement>('.focused')?.dataset.accessField).toBe('target');

      access.handleAction('back');
      expect(root.querySelector('.access-form')).toBeNull();
      expect(onBack).not.toHaveBeenCalled();

      access.handleAction('back');
      expect(onBack).toHaveBeenCalledOnce();
    });

    it('signs in with a server or code plus the account, then checks the panel', async () => {
      const signIn = vi.spyOn(LoginService, 'signIn').mockResolvedValue({ status: 'done' });
      access.open();
      await settle();
      click('login-open');
      type('target', '12345');
      type('username', 'u1');
      type('password', 'p1');

      click('login-submit');
      await settle();

      expect(signIn).toHaveBeenCalledWith({ target: '12345', username: 'u1', password: 'p1' });
      expect(root.querySelector('.access-form')).toBeNull();
      expect(root.querySelector('input[type="password"]')).toBeNull();
      expect(text('#access-notice')).toBe('List received. Loading channels\u2026');
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('keeps the code and moves to the username when only the account is missing', async () => {
      vi.spyOn(LoginService, 'signIn').mockResolvedValue({ status: 'needs_account', server: 'http://host' });
      access.open();
      await settle();
      click('login-open');
      type('target', '12345');

      click('login-submit');
      await settle();

      expect(value('target')).toBe('12345');
      expect(text('#access-notice')).toBe('Code accepted. Enter the username and password.');
      expect(root.querySelector<HTMLElement>('.focused')?.dataset.accessField).toBe('username');
    });

    it.each([
      [{ status: 'error', code: 'code_not_found' } as const, 'Code not found. Check it and try again.'],
      [{ status: 'error', code: 'max_devices', max: 2 } as const, 'This account has reached its limit of 2 devices.'],
      [{ status: 'error', code: 'max_devices' } as const, 'This account has reached its device limit.'],
      [{ status: 'error', code: 'invalid_credentials' } as const, 'Wrong username or password.'],
      [{ status: 'error', code: 'server_unreachable' } as const,
        'Could not reach that server. Check the address or the code.'],
      [{ status: 'error', code: 'network' } as const, 'No connection to the server'],
      [{ status: 'error', code: 'server', detail: 'x1' } as const, 'Code: x1'],
    ])('keeps the form open and explains %j', async (result, message) => {
      vi.spyOn(LoginService, 'signIn').mockResolvedValue(result);
      access.open();
      await settle();
      click('login-open');
      type('target', '12345');

      click('login-submit');
      await settle();

      expect(text('#access-notice')).toBe(message);
      expect(value('target')).toBe('12345');
    });

    it('keeps what was typed across a background check', async () => {
      access.open();
      await settle();
      click('login-open');
      type('target', 'http://host');

      await vi.advanceTimersByTimeAsync(CONFIG.XSOL.ACTIVATION_POLL_INTERVAL_MS);

      expect(value('target')).toBe('http://host');
    });

    it('ignores a second submit while one is in flight', async () => {
      let release: () => void = () => {};
      const signIn = vi.spyOn(LoginService, 'signIn').mockImplementation(
        () => new Promise((resolve) => { release = () => resolve({ status: 'done' }); }),
      );
      access.open();
      await settle();
      click('login-open');
      type('target', '12345');

      click('login-submit');
      click('login-submit');
      release();
      await settle();

      expect(signIn).toHaveBeenCalledOnce();
    });

    it('Enter in a field moves to the next control instead of submitting half a form', async () => {
      const signIn = vi.spyOn(LoginService, 'signIn').mockResolvedValue({ status: 'done' });
      access.open();
      await settle();
      click('login-open');
      const target = root.querySelector<HTMLInputElement>('[data-access-field="target"]')!;
      target.focus();

      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(document.activeElement).not.toBe(target);
      expect(signIn).not.toHaveBeenCalled();
    });
  });

});
