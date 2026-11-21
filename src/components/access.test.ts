// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { Access } from './access';
import { ActivationService, type ActivationSnapshot } from '../services/xsol/activation-service';
import { LoginService } from '../services/xsol/login-service';

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
    expect(root.querySelector('[data-access-action="login-code"]')).not.toBeNull();
  });

  it('shows no lock notice on an active device', async () => {
    access.open();
    await settle();

    expect(root.querySelector('#access-locked')).toBeNull();
  });

  it('names the linked playlist, or says there is none', async () => {
    access.open();
    await settle();
    expect(text('#access-playlist')).toBe('None linked yet');

    current = snapshot({ hasPlaylist: true, playlistName: 'N1' });
    access.open();
    await settle();
    expect(text('#access-playlist')).toBe('N1');

    current = snapshot({ hasPlaylist: true, playlistName: '' });
    access.open();
    await settle();
    expect(text('#access-playlist')).toBe('Linked');
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

    it('offers a code or an account, and Back closes the form before leaving', async () => {
      access.open();
      await settle();
      expect(root.querySelector('.access-form')).toBeNull();

      click('login-code');
      expect(root.querySelector('[data-access-field="code"]')).not.toBeNull();
      expect(root.querySelector<HTMLElement>('.focused')?.dataset.accessField).toBe('code');

      access.handleAction('back');
      expect(root.querySelector('.access-form')).toBeNull();
      expect(onBack).not.toHaveBeenCalled();

      access.handleAction('back');
      expect(onBack).toHaveBeenCalledOnce();
    });

    it('redeems a code and then checks the panel for the playlist', async () => {
      const redeem = vi.spyOn(LoginService, 'redeemCode').mockResolvedValue({ status: 'done' });
      access.open();
      await settle();
      click('login-code');
      type('code', '12345');

      click('login-submit');
      await settle();

      expect(redeem).toHaveBeenCalledWith('12345');
      expect(root.querySelector('.access-form')).toBeNull();
      expect(text('#access-notice')).toBe('List received. Loading channels\u2026');
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('moves on to the account when the code only names the server', async () => {
      vi.spyOn(LoginService, 'redeemCode').mockResolvedValue({ status: 'needs_account', server: 'http://host' });
      const signIn = vi.spyOn(LoginService, 'signIn').mockResolvedValue({ status: 'done' });
      access.open();
      await settle();
      click('login-code');
      type('code', '12345');
      click('login-submit');
      await settle();

      // The server came from the code: it is shown, not asked for.
      expect(root.querySelector('[data-access-field="server"]')).toBeNull();
      expect(text('.access-locked-server')).toBe('http://host');
      expect(text('#access-notice')).toBe('Code accepted. Enter the username and password.');

      type('username', 'u1');
      type('password', 'p1');
      click('login-submit');
      await settle();

      expect(signIn).toHaveBeenCalledWith({ server: 'http://host', username: 'u1', password: 'p1' });
    });

    it('signs in with server, username and password', async () => {
      const signIn = vi.spyOn(LoginService, 'signIn').mockResolvedValue({ status: 'done' });
      access.open();
      await settle();
      click('login-account');
      type('server', 'http://host');
      type('username', 'u1');
      type('password', 'p1');

      click('login-submit');
      await settle();

      expect(signIn).toHaveBeenCalledWith({ server: 'http://host', username: 'u1', password: 'p1' });
      expect(root.querySelector('input[type="password"]')).toBeNull();
    });

    it.each([
      [{ status: 'error', code: 'code_not_found' } as const, 'Code not found. Check it and try again.'],
      [{ status: 'error', code: 'max_devices', max: 2 } as const, 'This account has reached its limit of 2 devices.'],
      [{ status: 'error', code: 'max_devices' } as const, 'This account has reached its device limit.'],
      [{ status: 'error', code: 'network' } as const, 'No connection to the server'],
      [{ status: 'error', code: 'server', detail: 'x1' } as const, 'Code: x1'],
    ])('keeps the form open and explains %j', async (result, message) => {
      vi.spyOn(LoginService, 'redeemCode').mockResolvedValue(result);
      access.open();
      await settle();
      click('login-code');
      type('code', '12345');

      click('login-submit');
      await settle();

      expect(text('#access-notice')).toBe(message);
      expect(root.querySelector<HTMLInputElement>('[data-access-field="code"]')?.value).toBe('12345');
    });

    it('keeps what was typed across a background check', async () => {
      access.open();
      await settle();
      click('login-account');
      type('server', 'http://host');

      await vi.advanceTimersByTimeAsync(CONFIG.XSOL.ACTIVATION_POLL_INTERVAL_MS);

      expect(root.querySelector<HTMLInputElement>('[data-access-field="server"]')?.value).toBe('http://host');
    });

    it('ignores a second submit while one is in flight', async () => {
      let release: () => void = () => {};
      const redeem = vi.spyOn(LoginService, 'redeemCode').mockImplementation(
        () => new Promise((resolve) => { release = () => resolve({ status: 'done' }); }),
      );
      access.open();
      await settle();
      click('login-code');
      type('code', '12345');

      click('login-submit');
      click('login-submit');
      release();
      await settle();

      expect(redeem).toHaveBeenCalledOnce();
    });

    it('Enter in a field moves to the next control instead of submitting half a form', async () => {
      const signIn = vi.spyOn(LoginService, 'signIn').mockResolvedValue({ status: 'done' });
      access.open();
      await settle();
      click('login-account');
      const server = root.querySelector<HTMLInputElement>('[data-access-field="server"]')!;
      server.focus();

      server.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(document.activeElement).not.toBe(server);
      expect(signIn).not.toHaveBeenCalled();
    });
  });

});
