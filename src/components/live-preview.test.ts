// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LivePreview } from './live-preview';
import { EpgService } from '../services/epg-service';
import { PlaylistService } from '../services/playlist-service';
import { StorageService } from '../services/storage-service';
import { CONFIG } from '../config';
import type { LivePlaybackSnapshot, Programme } from '../types';
import { setDisplayTz } from '../utils/time';
import type { ChannelList } from './channel-list';
import type { Player } from './player';

vi.mock('../services/epg-service', () => {
  const service = {
    findChannelId: vi.fn(() => 'ch1'),
    getNowPlaying: vi.fn(),
    getUpcoming: vi.fn(),
    // The day list is served from the same fixtures the header uses: the programme
    // on air followed by what comes after it, clipped to the requested day.
    getProgrammesIntersectingRange: vi.fn((_id: string, from: number, to: number) => {
      const current = service.getNowPlaying() as Programme | null | undefined;
      const later = (service.getUpcoming() as Programme[] | undefined) ?? [];
      return (current ? [current, ...later] : later)
        .filter(item => item.start.getTime() < to && item.stop.getTime() > from);
    }),
  };
  return { EpgService: service };
});

const now = new Date('2026-09-15T20:36:00Z');
function program(start: number, stop: number, title = 'Program 1'): Programme {
  return {
    start: new Date(now.getTime() + start * 60000),
    stop: new Date(now.getTime() + stop * 60000),
    title, description: '', category: '', icon: '',
  };
}
function state(): LivePlaybackSnapshot {
  return {
    channel: {
      id: 'ch1', name: 'Channel 1', url: 'http://host/ch1', logo: '',
      group: '', extras: null, playlistIds: ['p1'],
      catchup: '', catchupSource: '', catchupDays: 0,
    },
    status: 'playing', muted: false,
  };
}

interface LivePreviewInternals {
  readonly focused: boolean;
  readonly slot: HTMLElement | null;
  applyState(state: LivePlaybackSnapshot | null): void;
  focus(control?: 'favorite' | 'mute' | 'fullscreen'): boolean;
  blur(): void;
  fitPrograms(): void;
}

describe('LivePreview', () => {
  let root: HTMLElement;
  let preview: LivePreview;
  let view: LivePreviewInternals;
  let favorite: boolean;
  let playerPlay: ReturnType<typeof vi.fn>;
  let liveSnapshot: ReturnType<typeof vi.fn>;
  let livePreviewMode: boolean;
  let actions: {
    isFavorite: ReturnType<typeof vi.fn>;
    onFavorite: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
    onMute: ReturnType<typeof vi.fn>;
    onExpand: ReturnType<typeof vi.fn>;
    onPlayFullscreen: ReturnType<typeof vi.fn>;
    onFocus: ReturnType<typeof vi.fn>;
    onBlur: ReturnType<typeof vi.fn>;
    onReturn: ReturnType<typeof vi.fn>;
    onHighlightEntryPoint: ReturnType<typeof vi.fn>;
    onSetPlaying: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    setDisplayTz('feed', 0);
    vi.mocked(EpgService.findChannelId).mockReturnValue('ch1');
    vi.mocked(EpgService.getNowPlaying).mockReturnValue(program(-36, 24));
    vi.mocked(EpgService.getUpcoming).mockReturnValue([
      program(24, 74, 'Program 2'), program(74, 114, 'Program 3'), program(114, 174, 'Program 4'),
      program(174, 234, 'Program 5'),
    ]);
    root = document.createElement('aside');
    document.body.appendChild(root);
    favorite = false;
    actions = {
      isFavorite: vi.fn(() => favorite),
      onFavorite: vi.fn(() => { favorite = !favorite; }),
      onClose: vi.fn(), onMute: vi.fn(), onExpand: vi.fn(), onFocus: vi.fn(),
      onPlayFullscreen: vi.fn(), onBlur: vi.fn(), onReturn: vi.fn(),
      onHighlightEntryPoint: vi.fn(), onSetPlaying: vi.fn(),
    };
    playerPlay = vi.fn();
    liveSnapshot = vi.fn(() => null);
    livePreviewMode = false;
    const player = {
      getVideoElement: vi.fn(() => null),
      getLivePlaybackSnapshot: liveSnapshot,
      getCurrentIndex: vi.fn(() => 1),
      isInLivePreview: vi.fn(() => livePreviewMode),
      enterLivePreview: vi.fn(() => { livePreviewMode = true; }),
      exitLivePreview: vi.fn(() => { livePreviewMode = false; }),
      play: playerPlay,
      stop: actions.onClose,
      showOSD: vi.fn(),
      togglePreviewMute: actions.onMute,
    } as unknown as Player;
    const channelList = {
      isEditing: false,
      setPreviewFocused: vi.fn((focused: boolean) => {
        if (!focused) actions.onBlur();
      }),
      restoreFocus: actions.onReturn,
      highlightEntryPoint: actions.onHighlightEntryPoint,
      render: vi.fn(),
      handleBack: vi.fn(() => false),
      setPlaying: actions.onSetPlaying,
    } as unknown as ChannelList;
    preview = new LivePreview(root, {
      channelView: document.createElement('div'),
      player,
      channelList,
      getCurrentView: () => 'channels',
      showChannels: vi.fn(),
      showPlayer: actions.onExpand,
      playFullscreen: actions.onPlayFullscreen,
      blurTabBar: actions.onFocus,
      expansionBlocked: () => false,
      isFavorite: actions.isFavorite,
      toggleFavorite: actions.onFavorite,
    });
    view = preview as unknown as LivePreviewInternals;
  });

  afterEach(() => {
    view.applyState(null);
    PlaylistService.reset();
    StorageService.setLivePreview(false);
    root.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
    setDisplayTz('device', null);
  });

  it('shows current program, bounded progress, the day list and favorite state', () => {
    view.applyState(state());
    expect(root.querySelector('.live-preview-channel')?.textContent).toBe('Channel 1');
    expect(root.querySelector('.live-preview-clock')?.textContent).toBe('20:36');
    expect(root.querySelector('.live-preview-clock')?.getAttribute('datetime')).toBe('20:36');
    expect(root.querySelector('.live-preview-slot .live-preview-badge')?.textContent).toContain('LIVE');
    expect(root.querySelector('.live-preview-slot .live-badge')).not.toBeNull();
    expect(root.querySelector('.live-preview-slot .live-badge-dot')).not.toBeNull();
    expect(root.querySelector('.live-preview-title')?.textContent).toBe('Program 1');
    expect(root.querySelector('.live-preview-time-range')?.textContent).toBe('20:00–21:00');
    expect(root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('60');
    expect(root.querySelector('.live-preview-remaining')?.textContent).toContain('24');
    // The programme on air plus the four that follow it; the last one starts
    // today and ends after midnight, so it still belongs to the day.
    expect(root.querySelectorAll('.live-preview-program')).toHaveLength(5);
    const onAir = root.querySelector('.live-preview-program.is-current');
    expect(onAir?.querySelector('time')?.textContent).toBe('20:00–21:00');
    expect(root.querySelectorAll('.live-preview-program.is-current')).toHaveLength(1);
    expect(root.querySelectorAll('.live-preview-program.is-upcoming')).toHaveLength(4);
    const dayStart = Date.UTC(2026, 8, 15);
    expect(EpgService.getProgrammesIntersectingRange)
      .toHaveBeenCalledWith('ch1', dayStart, dayStart + 24 * 60 * 60 * 1000);
    expect(root.querySelectorAll('button')).toHaveLength(3);
    expect(root.querySelector('[data-preview-action="favorite"]')?.getAttribute('aria-pressed'))
      .toBe('false');
    expect(root.querySelector('[data-preview-action="mute"]')?.getAttribute('aria-label'))
      .toBe('Mute');
    expect(root.querySelector('.live-preview-legend')).toBeNull();
  });

  it('renders the 24-hour clock with minute precision', () => {
    view.applyState(state());
    vi.setSystemTime(new Date('2026-09-15T21:04:59Z'));
    view.applyState(state());

    expect(root.querySelector('.live-preview-clock')?.textContent).toBe('21:04');
  });

  it('preserves slot and focus through EPG changes without recreating video', () => {
    view.applyState(state());
    const slot = view.slot;
    view.focus('fullscreen');
    const focused = root.querySelector('.focused');
    vi.setSystemTime(new Date(now.getTime() + 60000));
    vi.mocked(EpgService.getNowPlaying).mockReturnValue(program(-1, 59, 'Program 5'));
    view.applyState(state());
    expect(view.slot).toBe(slot);
    expect(root.querySelector('.focused')).toBe(focused);
    expect(root.querySelector('.live-preview-title')?.textContent).toBe('Program 5');
    expect(root.querySelector('video')).toBeNull();
  });

  it('retunes the same stable channel when its refreshed URL changed', () => {
    const oldChannel = {
      ...state().channel,
      url: 'http://host/ch1?token=old',
    };
    const replacement = {
      ...oldChannel,
      url: 'http://host/ch1?token=new',
    };
    PlaylistService.channels = [replacement];
    StorageService.setLivePreview(true);
    liveSnapshot.mockReturnValue({ ...state(), channel: oldChannel });

    preview.selectChannel(0, undefined, null, 'expand-current');

    expect(playerPlay).toHaveBeenCalledWith(0, undefined, null);
  });

  it('expands when the channel already playing in preview is selected again', () => {
    const current = state();
    PlaylistService.channels = [current.channel];
    StorageService.setLivePreview(true);
    liveSnapshot.mockReturnValue(current);
    view.applyState(current);

    preview.selectChannel(0, undefined, null, 'expand-current');

    expect(actions.onExpand).toHaveBeenCalledOnce();
    expect(playerPlay).not.toHaveBeenCalled();
  });

  it('routes numeric-style fullscreen selection around live preview', () => {
    StorageService.setLivePreview(true);

    preview.selectChannel(1, undefined, { group: 'builtin:all' }, 'fullscreen');

    expect(actions.onPlayFullscreen).toHaveBeenCalledWith(
      1,
      undefined,
      { group: 'builtin:all' },
    );
    expect(playerPlay).not.toHaveBeenCalled();
    expect(actions.onExpand).not.toHaveBeenCalled();
  });

  it('focuses the current playing channel when returning from full screen', () => {
    StorageService.setLivePreview(true);
    liveSnapshot.mockReturnValue(state());
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(0);
        return 1;
      });

    expect(preview.returnFromFullscreen(true)).toBe(true);

    expect(actions.onSetPlaying).toHaveBeenCalledWith(1);
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(actions.onHighlightEntryPoint).toHaveBeenCalledOnce();
    expect(actions.onReturn).not.toHaveBeenCalled();
  });

  it('keeps controls and slot during buffering and errors', () => {
    view.applyState(state());
    view.focus();
    const slot = view.slot;
    view.applyState({ ...state(), status: 'buffering' });
    expect(view.slot).toBe(slot);
    expect(view.focused).toBe(true);
    expect(root.querySelector('.live-preview-message')?.textContent).toContain('Connecting');
    view.applyState({ ...state(), status: 'error' });
    expect(view.slot).toBe(slot);
    expect(root.querySelectorAll('button')).toHaveLength(3);
  });

  it('routes mute/fullscreen separately, with one activation per click', () => {
    view.applyState(state());
    root.querySelector<HTMLButtonElement>('[data-preview-action="mute"]')!.click();
    expect(actions.onMute).toHaveBeenCalledTimes(1);
    expect(actions.onExpand).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('[data-preview-action="fullscreen"]')!.click();
    expect(actions.onExpand).toHaveBeenCalledTimes(1);
    view.slot!.click();
    expect(actions.onExpand).toHaveBeenCalledTimes(2);
    expect(root.hasAttribute('data-self-activate')).toBe(true);
  });

  it('closes the preview with Back from focused controls', () => {
    view.applyState(state());
    view.focus('mute');
    preview.handleAction('back');
    expect(actions.onClose).toHaveBeenCalledOnce();
    expect(actions.onReturn).not.toHaveBeenCalled();
  });

  it('toggles the current channel favorite by pointer, OK and the green key', () => {
    view.applyState(state());
    const button = root.querySelector<HTMLButtonElement>('[data-preview-action="favorite"]')!;
    expect(button.querySelector('.favorite-glyph.unset')).not.toBeNull();
    button.click();
    expect(actions.onFavorite).toHaveBeenCalledWith(state().channel);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('.favorite-glyph.set')).not.toBeNull();

    preview.handleAction('select');
    expect(actions.onFavorite).toHaveBeenCalledTimes(2);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    preview.handleAction('green');
    expect(actions.onFavorite).toHaveBeenCalledTimes(3);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps D-pad focus between favorite, video controls and the originating list', () => {
    view.applyState(state());
    expect(view.focus()).toBe(true);
    preview.handleAction('up');
    expect(root.querySelector('.focused')?.getAttribute('data-preview-action')).toBe('favorite');
    preview.handleAction('down');
    expect(root.querySelector('.focused')?.getAttribute('data-preview-action')).toBe('fullscreen');
    preview.handleAction('left');
    preview.handleAction('select');
    expect(actions.onMute).toHaveBeenCalledOnce();
    preview.handleAction('up');
    expect(root.querySelector('.focused')?.getAttribute('data-preview-action')).toBe('favorite');
    preview.handleAction('left');
    expect(view.focused).toBe(false);
    expect(actions.onReturn).toHaveBeenCalledOnce();
    expect(preview.handleAction('select')).toBe(false);
  });

  it('clears pointer focus when the pointer leaves a preview control', () => {
    view.applyState(state());
    const favorite = root.querySelector<HTMLElement>('[data-preview-action="favorite"]')!;
    favorite.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(favorite.classList.contains('focused')).toBe(true);
    expect(root.querySelector('.live-preview-legend')).toBeNull();
    favorite.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    expect(view.focused).toBe(false);
    expect(favorite.classList.contains('focused')).toBe(false);
    expect(actions.onBlur).toHaveBeenCalledOnce();
    expect(actions.onReturn).not.toHaveBeenCalled();
  });

  it('updates the mute icon and contextual hint even after losing focus', () => {
    view.applyState({ ...state(), muted: true });
    view.focus();
    expect(root.querySelector('.live-preview-legend')?.textContent).toContain('Unmute');
    expect(root.querySelector('[data-preview-action="mute"]')?.getAttribute('aria-label'))
      .toBe('Unmute');
    expect(root.querySelector('.live-preview-slot > .live-preview-legend')).not.toBeNull();
    view.blur();
    expect(root.querySelector('[aria-pressed="true"]')).not.toBeNull();
    expect(root.querySelector('.live-preview-legend')).toBeNull();
  });

  it('keeps the day list through control focus and mute rerenders', () => {
    vi.mocked(EpgService.getUpcoming).mockReturnValue([
      program(24, 74, 'Program 2'),
      program(240, 300, 'Program 3'),
    ]);
    view.applyState(state());
    expect(root.querySelectorAll('.live-preview-program')).toHaveLength(2);
    expect(root.querySelector('.live-preview-program.is-current')).not.toBeNull();

    view.focus('mute');
    view.applyState({ ...state(), muted: true });

    expect(root.querySelector('.live-preview-slot > .live-preview-legend')).not.toBeNull();
    expect(root.querySelectorAll('.live-preview-program')).toHaveLength(2);
    expect(root.querySelector('.live-preview-program.is-current')).not.toBeNull();
  });

  it('says there is no guide when all EPG is absent', () => {
    vi.mocked(EpgService.findChannelId).mockReturnValue(null);
    view.applyState(state());
    expect(root.querySelector('.live-preview-title')).toBeNull();
    expect(root.querySelector('.live-preview-upcoming')).toBeNull();
    expect(root.querySelector('.live-preview-empty')?.textContent).toBe('No guide for this channel');
    expect(root.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('handles partial EPG and invalid durations without invented programs', () => {
    vi.mocked(EpgService.getNowPlaying).mockReturnValue(program(1, 1));
    vi.mocked(EpgService.getUpcoming).mockReturnValue([program(24, 24), program(25, 50)]);
    view.applyState(state());
    expect(root.querySelector('[role="progressbar"]')).toBeNull();
    expect(root.querySelectorAll('.live-preview-program')).toHaveLength(1);
  });

  it('gives overlapping EPG entries distinct morph keys', () => {
    vi.mocked(EpgService.getUpcoming).mockReturnValue([
      program(24, 50, 'Program 2'),
      program(24, 74, 'Program 3'),
    ]);
    view.applyState(state());
    const keys = Array.from(root.querySelectorAll('.live-preview-program'))
      .map(row => row.getAttribute('data-key'));
    expect(new Set(keys).size).toBe(3);
  });

  it('brings the programme on air to the top once and leaves a manual scroll alone', () => {
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, top, right: 100, bottom: top + height, left: 0, width: 100, height,
      toJSON: () => ({}),
    });
    view.applyState(state());
    const list = root.querySelector<HTMLElement>('.live-preview-upcoming')!;
    const onAir = root.querySelector<HTMLElement>('.live-preview-program.is-current')!;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(100, 300));
    vi.spyOn(onAir, 'getBoundingClientRect').mockReturnValue(rect(400, 60));

    preview.refreshLayout();
    expect(list.scrollTop).toBe(300);

    // The panel re-renders every second; a scroll back through the day must survive it.
    list.scrollTop = 50;
    view.applyState(state());
    preview.refreshLayout();
    expect(list.scrollTop).toBe(50);
  });

  it('marks what already aired, what is on air and what is still to come', () => {
    vi.mocked(EpgService.getProgrammesIntersectingRange).mockReturnValueOnce([
      program(-200, -140, 'Program 0'),
      program(-36, 24, 'Program 1'),
      program(24, 74, 'Program 2'),
    ]);
    view.applyState(state());
    const rows = Array.from(root.querySelectorAll('.live-preview-program'));
    expect(rows.map(row => row.className.replace('live-preview-program ', '')))
      .toEqual(['is-past', 'is-current', 'is-upcoming']);
    expect(rows.map(row => row.querySelector('span')?.textContent))
      .toEqual(['Program 0', 'Program 1', 'Program 2']);
    expect(root.querySelector('.live-preview-day-title')?.textContent).toBe("Today's guide");
  });

  it('leaves out programmes that belong to another day', () => {
    vi.mocked(EpgService.getUpcoming).mockReturnValue([
      program(240, 300, 'Program 2'),
      program(1680, 1740, 'Program 3'),
    ]);
    view.applyState(state());
    const titles = Array.from(root.querySelectorAll('.live-preview-program span'))
      .map(element => element.textContent);
    expect(titles).toEqual(['Program 1']);
  });

  it('escapes all channel and programme text', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const value = state();
    value.channel.name = malicious;
    vi.mocked(EpgService.getNowPlaying).mockReturnValue(program(-10, 10, malicious));
    vi.mocked(EpgService.getUpcoming).mockReturnValue([program(10, 60, malicious)]);
    view.applyState(value);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.live-preview-channel')?.textContent).toBe(malicious);
    expect(root.querySelector('.live-preview-title')?.textContent).toBe(malicious);
  });

  it('schedules lightweight refresh and cancels it when stopped or suspended', () => {
    const refresh = vi.spyOn(preview, 'refresh').mockImplementation(() => {});
    view.applyState(state());
    view.applyState(state());
    vi.advanceTimersByTime(CONFIG.PLAYER.LIVE_PREVIEW_REFRESH_MS);
    expect(refresh).toHaveBeenCalledOnce();
    view.applyState(state());
    preview.suspend();
    vi.advanceTimersByTime(CONFIG.PLAYER.LIVE_PREVIEW_REFRESH_MS);
    expect(refresh).toHaveBeenCalledOnce();
    view.applyState(null);
    expect(root.classList.contains('hidden')).toBe(true);
    expect(view.focus()).toBe(false);
  });
});
