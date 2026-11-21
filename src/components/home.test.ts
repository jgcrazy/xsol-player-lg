// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home, type HomeData } from './home';
import { ActivationService, type ActivationSnapshot } from '../services/xsol/activation-service';

function channel(index: number, name = `ch${index + 1}`, group = 'Group 1', logo = '') {
  return { index, name, group, logo };
}

function snapshot(patch: Partial<ActivationSnapshot> = {}): ActivationSnapshot {
  return {
    status: 'active', deviceId: '02:00:00:00:00:01', manageKey: '123456',
    expiryDate: '2030-01-05 00:00:00', trial: false, lifetime: false,
    hasPlaylist: false, playlistName: '', errorCode: '', enforced: true, ...patch,
  };
}

describe('Home', () => {
  let root: HTMLElement;
  let home: Home;
  let data: HomeData;
  let userExpiry: number | null | undefined;
  let activation: ActivationSnapshot;
  let onResume: ReturnType<typeof vi.fn>;
  let onPlayChannel: ReturnType<typeof vi.fn>;
  let onAllChannels: ReturnType<typeof vi.fn>;
  let onSection: ReturnType<typeof vi.fn>;
  let onRevealTabBar: ReturnType<typeof vi.fn>;
  let onBack: ReturnType<typeof vi.fn>;

  const text = (selector: string): string => root.querySelector(selector)?.textContent?.trim() ?? '';
  const focusedKey = (): string | undefined => root.querySelector<HTMLElement>('.focused')?.dataset.key;
  const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };
  const note = (section: string): string => text(`[data-note-for="${section}"]`);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 15, 4));
    Element.prototype.scrollIntoView = vi.fn();
    root = document.createElement('div');
    document.body.appendChild(root);
    data = {
      lastWatched: channel(4, 'ch5', 'Group 2'),
      featured: [channel(4, 'ch5', 'Group 2'), channel(0), channel(1), channel(2)],
      hasXtream: true,
    };
    userExpiry = Date.UTC(2031, 2, 9) / 1000;
    activation = snapshot();
    vi.spyOn(ActivationService, 'snapshot', 'get').mockImplementation(() => activation);
    onResume = vi.fn();
    onPlayChannel = vi.fn();
    onAllChannels = vi.fn();
    onSection = vi.fn();
    onRevealTabBar = vi.fn(() => true);
    onBack = vi.fn();
    home = new Home(root, {
      getData: () => data,
      loadUserExpiry: async () => userExpiry,
      onResume, onPlayChannel, onAllChannels, onSection, onRevealTabBar, onBack,
    });
  });

  afterEach(() => {
    home.close();
    root.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    [9, 'Good morning'],
    [15, 'Good afternoon'],
    [21, 'Good evening'],
  ])('greets by the hour (%i h)', async (hour, greeting) => {
    vi.setSystemTime(new Date(2026, 8, 15, hour, 4));
    home.open();
    await settle();

    expect(text('#home-greeting')).toBe(greeting);
    expect(text('.home-date-time')).toBe(`${hour < 10 ? '0' : ''}${hour}:04`);
  });

  it('shows no counts on the section cards', async () => {
    home.open();
    await settle();

    expect(root.querySelectorAll('.home-card')).toHaveLength(5);
    for (const section of ['live', 'movies', 'series', 'access', 'settings']) {
      expect(note(section)).toBe('');
    }
    expect(root.querySelector('.home-card-watermark')).toBeNull();
  });

  it('says Movies and Series need an account when there is none', async () => {
    data.hasXtream = false;
    home.open();
    await settle();

    expect(note('movies')).toBe('Needs an Xtream account');
    expect(note('series')).toBe('Needs an Xtream account');
    expect(note('live')).toBe('');
  });

  it('offers to resume the last channel and starts there', async () => {
    home.open();
    await settle();

    expect(text('#home-last-name')).toBe('ch5');
    expect(text('.home-last-group')).toBe('Group 2');
    expect(focusedKey()).toBe('resume');

    home.handleAction('select');
    expect(onResume).toHaveBeenCalledWith(4);
  });

  it('falls back to All channels and the first card when nothing was watched', async () => {
    data.lastWatched = null;
    home.open();
    await settle();

    expect(root.querySelector('[data-home-action="resume"]')).toBeNull();
    expect(text('#home-last-name')).toBe('Pick a channel to get started');
    expect(focusedKey()).toBe('section:live');

    root.querySelector<HTMLElement>('[data-home-action="all"]')!.click();
    expect(onAllChannels).toHaveBeenCalledOnce();
  });

  it('opens a section from its card and plays a featured channel', async () => {
    home.open();
    await settle();

    root.querySelector<HTMLElement>('[data-section="access"]')!.click();
    expect(onSection).toHaveBeenCalledWith('access');

    root.querySelector<HTMLElement>('[data-key="channel:1"]')!.click();
    expect(onPlayChannel).toHaveBeenCalledWith(1);
    expect(root.querySelectorAll('.home-channel')).toHaveLength(4);
  });

  it('hides the on-air row when there is no channel to feature', async () => {
    data.featured = [];
    home.open();
    await settle();

    expect(root.querySelector('.home-channels')).toBeNull();
  });

  it('escapes channel names and groups', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    data.lastWatched = channel(0, hostile, hostile);
    data.featured = [channel(0, hostile, hostile)];
    home.open();
    await settle();

    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(text('#home-last-name')).toBe(hostile);
    expect(text('.home-channel-name')).toBe(hostile);
  });

  it('uses the channel logo over its initial, and drops a logo that fails to load', async () => {
    data.featured = [channel(0, 'ch1', 'Group 1', 'http://host/a.png'), channel(1)];
    home.open();
    await settle();

    const logo = root.querySelector<HTMLImageElement>('.home-channel-logo')!;
    expect(logo.getAttribute('src')).toBe('http://host/a.png');
    expect(root.querySelectorAll('.home-channel-logo')).toHaveLength(1);
    expect(text('.home-channel-initial')).toBe('C');

    logo.dispatchEvent(new Event('error'));
    expect(logo.style.display).toBe('none');
  });

  it('shows the activation date and the account expiry in the footer', async () => {
    home.open();
    expect(text('#home-user-expiry')).toBe('—');
    await settle();

    expect(text('#home-activation')).toMatch(/30/);
    expect(text('#home-user-expiry')).toMatch(/31/);
    expect(text('.home-footer-version')).toMatch(/V \d/);
  });

  it.each([
    [snapshot({ lifetime: true }), null, 'No expiry', 'No expiry'],
    [snapshot({ expiryDate: '' }), undefined, '—', '—'],
    [snapshot({ expiryDate: 'not a date' }), undefined, '—', '—'],
  ] as const)('handles missing dates %#', async (state, expiry, activationText, expiryText) => {
    activation = state;
    userExpiry = expiry;
    home.open();
    await settle();

    expect(text('#home-activation')).toBe(activationText);
    expect(text('#home-user-expiry')).toBe(expiryText);
  });

  it('keeps the focus where it was across the clock tick', async () => {
    home.open();
    await settle();
    root.querySelector<HTMLElement>('[data-section="series"]')!.dispatchEvent(
      new CustomEvent('nav:hover', { bubbles: true }),
    );
    home.handleAction('right');
    const before = focusedKey();
    expect(before).toBeTruthy();

    vi.setSystemTime(new Date(2026, 8, 15, 15, 5));
    await vi.advanceTimersByTimeAsync(20 * 1000);

    expect(text('.home-date-time')).toBe('15:05');
    expect(focusedKey()).toBe(before);
  });

  it('routes Back to the host and Up from the top row to the tab bar', async () => {
    home.open();
    await settle();

    home.handleAction('back');
    home.handleAction('up');

    expect(onBack).toHaveBeenCalledOnce();
    expect(onRevealTabBar).toHaveBeenCalledOnce();
  });

  it('stops ticking and ignores late data once closed', async () => {
    let release: (value: number | null | undefined) => void = () => {};
    home = new Home(root, {
      getData: () => data,
      loadUserExpiry: () => new Promise<number | null | undefined>((resolve) => { release = resolve; }),
      onResume, onPlayChannel, onAllChannels, onSection, onRevealTabBar, onBack,
    });
    home.open();
    home.close();
    release(Date.UTC(2031, 2, 9) / 1000);
    await settle();
    const rendered = root.innerHTML;

    vi.setSystemTime(new Date(2026, 8, 15, 16, 0));
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(text('#home-user-expiry')).toBe('—');
    expect(root.innerHTML).toBe(rendered);
  });
});
