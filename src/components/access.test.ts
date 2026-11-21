// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { Access } from './access';
import { ActivationService, type ActivationSnapshot } from '../services/xsol/activation-service';

vi.mock('../utils/qr', () => ({
  qrDataUrl: vi.fn((text: string) => `data:qr,${text}`),
}));

function snapshot(patch: Partial<ActivationSnapshot> = {}): ActivationSnapshot {
  return {
    status: 'active', deviceId: '02:00:00:00:00:01', manageKey: '123456',
    expiryDate: '2030-01-05 00:00:00', trial: false, lifetime: false,
    hasPlaylist: false, errorCode: '', ...patch,
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
});
