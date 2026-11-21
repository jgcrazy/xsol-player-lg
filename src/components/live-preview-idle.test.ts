// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LivePreview } from './live-preview';
import { StorageService } from '../services/storage-service';
import type { LivePlaybackSnapshot } from '../types';
import type { ChannelList } from './channel-list';
import type { Player } from './player';

vi.mock('../services/epg-service', () => ({
  EpgService: {
    findChannelId: vi.fn(() => null),
    getNowPlaying: vi.fn(() => null),
    getUpcoming: vi.fn(() => []),
  },
}));

function playing(): LivePlaybackSnapshot {
  return {
    channel: {
      id: 'ch1', name: 'ch1', url: 'http://host/ch1', logo: '',
      group: '', extras: null, playlistIds: ['p1'],
      catchup: '', catchupSource: '', catchupDays: 0,
    },
    status: 'playing', muted: false,
  };
}

describe('LivePreview idle column', () => {
  let panel: HTMLElement;
  let idle: HTMLElement;
  let channelView: HTMLElement;
  let preview: LivePreview;
  let snapshot: LivePlaybackSnapshot | null;
  let currentView: 'channels' | 'player' | 'settings';

  beforeEach(() => {
    localStorage.clear();
    panel = document.createElement('aside');
    idle = document.createElement('aside');
    idle.classList.add('hidden');
    channelView = document.createElement('div');
    document.body.append(panel, idle, channelView);
    snapshot = null;
    currentView = 'channels';
    let previewMode = false;
    const player = {
      getVideoElement: () => null,
      getLivePlaybackSnapshot: () => snapshot,
      getCurrentIndex: () => 0,
      isInLivePreview: () => previewMode,
      enterLivePreview: () => { previewMode = true; },
      exitLivePreview: () => { previewMode = false; },
      play: vi.fn(),
      stop: vi.fn(),
    } as unknown as Player;
    const channelList = {
      isEditing: false,
      setPreviewFocused: vi.fn(),
      restoreFocus: vi.fn(),
      render: vi.fn(),
      setPlaying: vi.fn(),
    } as unknown as ChannelList;
    preview = new LivePreview(panel, {
      idleContainer: idle,
      channelView,
      player,
      channelList,
      getCurrentView: () => currentView,
      showChannels: vi.fn(),
      showPlayer: vi.fn(),
      playFullscreen: vi.fn(),
      blurTabBar: vi.fn(),
      expansionBlocked: () => false,
      isFavorite: () => false,
      toggleFavorite: vi.fn(),
    });
    // No playlist is loaded here; availability is covered by the main spec.
    (preview as unknown as { isChannelAvailable: () => boolean }).isChannelAvailable = () => true;
  });

  afterEach(() => {
    snapshot = null;
    preview.refresh();
    panel.remove();
    idle.remove();
    channelView.remove();
  });

  it('holds the third column while nothing is playing', () => {
    preview.refresh();

    expect(idle.classList.contains('hidden')).toBe(false);
    expect(channelView.classList.contains('has-idle-preview')).toBe(true);
    expect(channelView.classList.contains('has-live-preview')).toBe(false);
    expect(idle.querySelector('.live-preview-idle-hint')?.textContent).toBeTruthy();
    // The real panel still means "something is playing here".
    expect(preview.isShowing).toBe(false);
    expect(idle.querySelector('[data-focusable]')).toBeNull();
  });

  it('gives way to the real panel once a channel plays, and returns when it stops', () => {
    preview.refresh();
    snapshot = playing();
    preview.refresh();

    expect(idle.classList.contains('hidden')).toBe(true);
    expect(channelView.classList.contains('has-idle-preview')).toBe(false);
    expect(channelView.classList.contains('has-live-preview')).toBe(true);

    snapshot = null;
    preview.refresh();

    expect(idle.classList.contains('hidden')).toBe(false);
    expect(channelView.classList.contains('has-live-preview')).toBe(false);
  });

  it('stays out of the way when Live preview is off', () => {
    StorageService.setLivePreview(false);
    preview.refresh();

    expect(idle.classList.contains('hidden')).toBe(true);
    expect(channelView.classList.contains('has-idle-preview')).toBe(false);
  });

  it('only belongs to the channel list view', () => {
    currentView = 'settings';
    preview.refresh();

    expect(idle.classList.contains('hidden')).toBe(true);
  });

  it('steps aside while the list editor is open', () => {
    preview.refresh();
    preview.setManagingList(true);
    expect(idle.classList.contains('hidden')).toBe(true);
    expect(channelView.classList.contains('has-idle-preview')).toBe(false);

    preview.setManagingList(false);
    expect(idle.classList.contains('hidden')).toBe(false);
  });
});
