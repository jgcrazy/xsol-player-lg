// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry, WatchlistEntry, WatchlistKind } from '../types';

const { catalogMock, storageMock, watchlistState, toastMock } = vi.hoisted(() => {
  const watchlistState = { entries: [] as WatchlistEntry[] };
  return {
    catalogMock: {
      loadSeriesCategories: vi.fn(), loadSeries: vi.fn(), loadSeriesInfo: vi.fn(), loadAllSeries: vi.fn(),
    },
    watchlistState,
    storageMock: {
      getResumeList: vi.fn(() => [] as unknown[]),
      getHiddenCategories: vi.fn(() => [] as string[]),
      getResume: vi.fn(() => null),
      getWatchlist: vi.fn(() => watchlistState.entries),
      isWatchlisted: vi.fn((_accountId: string, _kind: WatchlistKind, itemId: string) =>
        watchlistState.entries.some((entry) => entry.itemId === itemId)),
      toggleWatchlist: vi.fn((entry: WatchlistEntry) => {
        const index = watchlistState.entries.findIndex((item) => item.itemId === entry.itemId);
        if (index >= 0) {
          watchlistState.entries.splice(index, 1);
          return false;
        }
        watchlistState.entries.unshift(entry);
        return true;
      }),
    },
    toastMock: { showToast: vi.fn() },
  };
});
vi.mock('../services/xtream-catalog', () => catalogMock);
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));

import { Series } from './series';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const series = (id: string, name: string, categoryId = '1') => ({
  accountId: 'x1', seriesId: id, name, poster: '', rating: '', categoryId,
});

let container: HTMLElement;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // The background whole-catalog request never answers unless a test says so.
  catalogMock.loadAllSeries.mockReset().mockImplementation(() => new Promise(() => {}));
  // clearAllMocks clears calls but not implementations; re-establish defaults so a
  // prior test's mockReturnValue override doesn't leak (order-safety).
  storageMock.getResumeList.mockReturnValue([]);
  storageMock.getHiddenCategories.mockReturnValue([]);
  storageMock.getResume.mockReturnValue(null);
  watchlistState.entries = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function openWith(cats = [{ id: '1', name: 'Cat A' }], items = [series('s1', 'Series One')]) {
  catalogMock.loadSeriesCategories.mockResolvedValue(cats);
  catalogMock.loadSeries.mockResolvedValue(items);
  const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
  const view = new Series(container, handlers);
  await view.open(account);
  return { view, handlers };
}

describe('Series browse', () => {
  const names = () => Array.from(container.querySelectorAll('.catalog-grid .catalog-tile-name')).map((n) => n.textContent);
  const row = (id: string) => container.querySelector<HTMLElement>(`.catalog-cat[data-category-id="${id}"]`)!;
  const hover = (selector: string) => container.querySelector(selector)!
    .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

  it('lists the categories at the side and the active one as a poster grid', async () => {
    await openWith([{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }], [series('s1', 'Series One')]);
    expect(Array.from(container.querySelectorAll('.catalog-cat-name')).map((n) => n.textContent))
      .toEqual(['Continue Watching', 'Favorites', 'Cat A', 'Cat B']);
    expect(row('1').classList.contains('is-active')).toBe(true);
    expect(names()).toEqual(['Series One']);
    expect(container.querySelector('.catalog-feature-title')?.textContent).toBe('Series One');
    expect(container.querySelector<HTMLInputElement>('.catalog-search-input')?.placeholder)
      .toBe('Search series or categories…');
  });

  it('follows the focused poster with the featured card', async () => {
    const s1 = { ...series('s1', 'Series One'), poster: 'http://host/a1.jpg', rating: '8.44', year: 2019 };
    const s2 = { ...series('s2', 'Series Two'), poster: 'http://host/a2.jpg' };
    await openWith([{ id: '1', name: 'Cat A' }], [s1, s2]);
    expect(container.querySelector('.catalog-feature-rating')?.textContent).toBe('8.4');
    expect(container.querySelector('.catalog-feature-year')?.textContent).toBe('2019');

    hover('.catalog-tile[data-item-id="s2"]');

    expect(container.querySelector('.catalog-feature-title')?.textContent).toBe('Series Two');
    expect(container.querySelector<HTMLImageElement>('.catalog-feature-poster img')?.src).toContain('a2.jpg');
  });

  it('opens on Continue watching with the episodes in progress, and resumes one directly', async () => {
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1 — Episode One', poster: '', ext: 'mkv', position: 300, duration: 1500, updatedAt: 1 },
      { accountId: 'x1', kind: 'vod', itemId: '9', name: 'A movie', poster: '', ext: 'mp4', position: 1, duration: 2, updatedAt: 2 },
    ]);
    const { view, handlers } = await openWith();
    expect(row('~continue').classList.contains('is-active')).toBe(true);
    expect(names()).toEqual(['Series One — S1E1 — Episode One']);

    view.handleAction('select');

    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e1', accountId: 'x1', kind: 'episode', resumeSecs: 300,
      url: 'http://host:8080/series/u/p/e1.mkv',
    }));
    // Watch on the card does the same; an episode cannot be favorited as a series.
    handlers.onPlayVod.mockClear();
    hover('[data-catalog-action="watch"]');
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e1', resumeSecs: 300 }));
    hover('[data-catalog-action="favorite"]');
    view.handleAction('select');
    expect(storageMock.toggleWatchlist).not.toHaveBeenCalled();
  });

  it('lists Favorites from stored series snapshots and opens one', async () => {
    watchlistState.entries = [{
      accountId: 'x1', kind: 'series', itemId: 's9', name: 'Saved Series', poster: '',
      rating: '8', categoryId: '7', addedAt: 2,
    }];
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    expect(row('~favorites').querySelector('.catalog-cat-count')?.textContent).toBe('1');

    hover('.catalog-cat[data-category-id="~favorites"]');
    view.handleAction('select');
    expect(names()).toEqual(['Saved Series']);
    hover('.catalog-tile[data-item-id="s9"]');
    view.handleAction('select');
    await flush();
    expect(container.querySelector('.series-detail')?.textContent).toContain('Saved Series');
  });

  it('favorites the featured series from the card', async () => {
    const { view } = await openWith();
    hover('[data-catalog-action="favorite"]');
    view.handleAction('select');
    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'x1', kind: 'series', itemId: 's1', name: 'Series One',
    }));
    expect(container.querySelector('[data-catalog-action="favorite"]')?.textContent?.trim()).toBe('Favorited');
  });

  it('selecting another category loads and shows it', async () => {
    const { view } = await openWith([{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }]);
    catalogMock.loadSeries.mockResolvedValue([series('s2', 'Series B', '2')]);
    hover('.catalog-cat[data-category-id="2"]');
    view.handleAction('select');
    await flush();
    expect(names()).toEqual(['Series B']);
    expect(container.querySelector('.catalog-head-name')?.textContent).toBe('Cat B');
  });

  it('opens a series detail on select and from Watch, and backs out to browse', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view, handlers } = await openWith();
    view.handleAction('select');
    await flush();
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Series One');
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();

    // A series has episodes to choose from, so Watch leads to them.
    hover('[data-catalog-action="watch"]');
    view.handleAction('select');
    await flush();
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(handlers.onPlayVod).not.toHaveBeenCalled();
  });

  it('leaves from the browse top level', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('back');
    expect(handlers.onBack).toHaveBeenCalled();
  });

  it('counts Continue watching again after walking detail and back', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    expect(row('~continue').querySelector('.catalog-cat-count')?.textContent).toBe('0');
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1', poster: '', ext: 'mp4', position: 300, duration: 1500, updatedAt: 1 },
    ]);
    view.handleAction('select');
    await flush();
    view.refreshPlaybackState(); // the player hands control back to the detail screen
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();

    view.refreshPlaybackState();
    expect(row('~continue').querySelector('.catalog-cat-count')?.textContent).toBe('1');
  });
});

const SERIES_INFO = {
  plot: 'Series plot.',
  cast: 'Actor 1, Actor 2',
  director: 'Director 1',
  genre: 'Drama',
  releaseDate: '2021-02-03',
  episodeRunTimeMins: 45,
  poster: 'http://host/series.jpg',
  rating: '8.4',
  imdbId: '1234567',
  tmdbId: '7654',
  year: 2021,
  seasons: [1, 2],
  episodesBySeason: {
    1: [{ id: 'e1', title: 'Episode One', season: 1, episode: 1, containerExtension: 'mp4', durationSecs: 1500, plot: 'Ep plot.', poster: '' }],
    2: [{ id: 'e2', title: 'Episode Two', season: 2, episode: 1, containerExtension: 'mkv', durationSecs: 1600, plot: '', poster: '' }],
  },
};

async function openDetail(view: Series) {
  const tile = container.querySelector('.catalog-tile[data-item-id="s1"]') as HTMLElement;
  tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  view.handleAction('select');
  await Promise.resolve(); await Promise.resolve(); // info-less render, then the loaded render
}

describe('Series detail', () => {
  it('renders a bounded episode window for a 50,000-item season', async () => {
    const episodes = Array.from({ length: 50_000 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({
      seasons: [1],
      episodesBySeason: { 1: episodes },
    });
    const { view } = await openWith();
    await openDetail(view);

    expect(container.querySelectorAll('.episode-row').length).toBeLessThan(20);
    expect(container.querySelector<HTMLElement>('.series-episodes-spacer')?.style.height)
      .toBe('6900000px');

    const detail = container.querySelector<HTMLElement>('.series-detail')!;
    detail.scrollTop = 100 * 138;
    detail.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const episode = container.querySelector<HTMLElement>(
      '[data-episode-index="100"] .episode-row',
    )!;
    episode.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

    view.refreshPlaybackState();

    expect(container.querySelector<HTMLElement>('.focused')?.dataset.key).toBe('ep:e100');
  });

  it('adds and removes the series from Watchlist without losing button focus', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view } = await openWith();
    await openDetail(view);

    const button = container.querySelector('[data-action="watchlist"]') as HTMLElement;
    button.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'x1', kind: 'series', itemId: 's1', name: 'Series One',
    }));
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Remove from Watchlist');
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Added to Watchlist');

    view.handleAction('select');
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Add to Watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Watchlist');
  });

  it('renders a season selector and the first season\'s episodes, and plays from the start', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view, handlers } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.detail-meta')?.textContent)
      .toContain('2021  ·  45 min  ·  Drama  ·  8.4');
    expect(container.querySelector('.detail-plot')?.textContent).toBe('Series plot.');
    expect(container.querySelectorAll('.detail-cast')[0]?.textContent)
      .toContain('Cast Actor 1, Actor 2');
    expect(container.querySelectorAll('.detail-cast')[1]?.textContent)
      .toContain('Director Director 1');
    expect(container.querySelector<HTMLImageElement>('.series-detail-poster img')?.src)
      .toBe('http://host/series.jpg');
    expect(container.querySelector('.series-season-btn[data-season="1"]')?.textContent).toContain('Season 1');
    expect(container.querySelector('.series-season-btn[data-season="2"]')).not.toBeNull();
    expect(container.querySelector('.episode-row[data-episode-id="e1"]')?.textContent).toContain('Episode One');
    expect(container.textContent).toContain('Ep plot.');

    const row = container.querySelector('.episode-row[data-episode-id="e1"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e1', accountId: 'x1', kind: 'episode', resumeSecs: 0,
      url: 'http://host:8080/series/u/p/e1.mp4',
      title: expect.stringContaining('S1E1'),
      watchlistOwner: { kind: 'series', itemId: 's1' },
      episodeQueue: [
        expect.objectContaining({
          itemId: 'e2',
          url: 'http://host:8080/series/u/p/e2.mkv',
          title: expect.stringContaining('S2E1'),
          watchlistOwner: { kind: 'series', itemId: 's1' },
        }),
      ],
    }));
  });

  it('renders the normalized year when no release date is available', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({
      ...SERIES_INFO,
      releaseDate: '',
      year: 2022,
    });
    const { view } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.detail-meta')?.textContent)
      .toContain('2022  ·  45 min  ·  Drama  ·  8.4');
  });

  it('switches season and plays that season\'s episode with its own container extension', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view, handlers } = await openWith();
    await openDetail(view);

    const season2 = container.querySelector('.series-season-btn[data-season="2"]') as HTMLElement;
    season2.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(container.querySelector('.episode-row[data-episode-id="e2"]')).not.toBeNull();
    expect(container.querySelector('.episode-row[data-episode-id="e1"]')).toBeNull();

    const row = container.querySelector('.episode-row[data-episode-id="e2"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e2', kind: 'episode', url: 'http://host:8080/series/u/p/e2.mkv',
    }));
  });

  it('walks the season row with Left and Right, one season at a time', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({
      ...SERIES_INFO,
      seasons: [1, 2, 3],
      episodesBySeason: { ...SERIES_INFO.episodesBySeason, 3: [] },
    });
    const { view } = await openWith();
    await openDetail(view);
    const season = () => container.querySelector<HTMLElement>('.focused')?.dataset.season;
    container.querySelector('[data-season="1"]')!.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

    view.handleAction('right');
    expect(season()).toBe('2');
    view.handleAction('right');
    expect(season()).toBe('3');
    view.handleAction('right'); // the last season is the end of the row
    expect(season()).toBe('3');
    view.handleAction('left');
    view.handleAction('left');
    expect(season()).toBe('1');
    view.handleAction('left');
    expect(season()).toBe('1');

    // OK on a season still selects it.
    view.handleAction('right');
    view.handleAction('select');
    expect(container.querySelector('.series-season-btn.active')?.getAttribute('data-season')).toBe('2');
  });

  it('marks an episode with a resume point and passes its saved position', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    storageMock.getResume.mockImplementation((_a: string, _k: string, id: string) =>
      id === 'e1' ? { accountId: 'x1', kind: 'episode', itemId: 'e1', name: '', poster: '', position: 450, duration: 1500, updatedAt: 1 } : null);
    const { view, handlers } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.episode-row[data-episode-id="e1"] .episode-resume')).not.toBeNull();
    const row = container.querySelector('.episode-row[data-episode-id="e1"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e1', resumeSecs: 450 }));
  });

  it('restores the remaining episode queue from Continue Watching', async () => {
    const next = {
      url: 'http://host:8080/series/u/p/e2.mkv', title: 'Series One — S2E1 — Episode Two',
      poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode', subtitles: [],
    };
    storageMock.getResumeList.mockReturnValue([
      {
        accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1',
        poster: '', ext: 'mp4', position: 450, duration: 1500, updatedAt: 1,
        episodeQueue: [next],
        watchlistOwner: { kind: 'series', itemId: 's1' },
      },
    ]);
    const { view, handlers } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="resume:e1"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      episodeQueue: [next],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
  });

  it('shows an empty state when the series has no seasons', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('No episodes available');
  });

  it('shows a failed state instead of a perpetual Loading when info is null', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(null);
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Unable to load episodes.');
    expect(container.textContent).not.toContain('Loading…');
  });
});

describe('Series deep-link (openItem)', () => {
  it('opens a series detail directly and Back returns to Search via the callback', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const onDetailBack = vi.fn();
    const view = new Series(container, handlers);
    await view.openItem(account, series('s9', 'Deep Series', '9'), onDetailBack);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Deep Series');
    expect(container.querySelector('.catalog-browse')).toBeNull();
    view.handleAction('back');
    expect(onDetailBack).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).not.toHaveBeenCalled();
  });
});
