// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry, WatchlistEntry, WatchlistKind } from '../types';

const { catalogMock, storageMock, watchlistState, toastMock } = vi.hoisted(() => {
  const watchlistState = { entries: [] as WatchlistEntry[] };
  return {
    catalogMock: {
      loadVodCategories: vi.fn(), loadVodStreams: vi.fn(), loadVodInfo: vi.fn(), loadAllVodStreams: vi.fn(),
    },
    watchlistState,
    storageMock: {
      getResumeList: vi.fn(() => [] as unknown[]),
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

import { Movies } from './movies';
import { VirtualGrid } from '../utils/virtual-grid';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const vod = (id: string, name: string, categoryId = '1') => ({
  accountId: 'x1', streamId: id, name, poster: '', rating: '', categoryId, containerExtension: 'mp4',
});

let container: HTMLElement;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // The background whole-catalog request never answers unless a test says so.
  catalogMock.loadAllVodStreams.mockReset().mockImplementation(() => new Promise(() => {}));
  catalogMock.loadVodStreams.mockReset();
  // clearAllMocks clears calls but not implementations; re-establish the default
  // return so a prior test's mockReturnValue override doesn't leak (order-safety).
  storageMock.getResumeList.mockReturnValue([]);
  storageMock.getResume.mockReturnValue(null);
  watchlistState.entries = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function openWith(cats = [{ id: '1', name: 'Cat A' }], streams = [vod('10', 'Movie One')]) {
  catalogMock.loadVodCategories.mockResolvedValue(cats);
  catalogMock.loadVodStreams.mockResolvedValue(streams);
  const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
  const view = new Movies(container, handlers);
  await view.open(account);
  return { view, handlers };
}

describe('Movies browse', () => {
  const names = () => Array.from(container.querySelectorAll('.catalog-grid .catalog-tile-name')).map((n) => n.textContent);
  const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.catalog-cat')).map((c) => ({
    id: c.dataset.categoryId ?? '',
    name: c.querySelector('.catalog-cat-name')?.textContent,
    count: c.querySelector('.catalog-cat-count')?.textContent,
    active: c.classList.contains('is-active'),
  }));
  const strip = (row: ReturnType<typeof rows>[number]) => ({ name: row.name, count: row.count, active: row.active });
  // The provider's categories, below the two the app always offers.
  const cats = () => rows().filter((row) => row.id.charAt(0) !== '~').map(strip);
  const own = (id: string) => strip(rows().filter((row) => row.id === id)[0]);
  const focused = () => container.querySelector<HTMLElement>('.focused');
  const hover = (selector: string) => container.querySelector(selector)!
    .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const featuredTitle = () => container.querySelector('.catalog-feature-title')?.textContent;

  it('lists the categories at the side and the active one as a poster grid', async () => {
    await openWith([{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }], [vod('10', 'Movie One'), vod('11', 'Movie Two')]);

    // Continue watching and Favorites are always offered first, even while empty.
    expect(rows().map((row) => row.name)).toEqual(['Continue Watching', 'Favorites', 'Cat A', 'Cat B']);
    expect(cats().map((c) => [c.name, c.active])).toEqual([['Cat A', true], ['Cat B', false]]);
    expect(container.querySelector('.catalog-head-name')?.textContent).toBe('Cat A');
    expect(container.querySelector('.catalog-head-count')?.textContent).toBe('2 titles');
    expect(names()).toEqual(['Movie One', 'Movie Two']);
    // Only the active category was fetched to draw the screen.
    expect(catalogMock.loadVodStreams).toHaveBeenCalledTimes(1);
    // Focus starts on the first poster, which is also the featured title.
    expect(focused()?.dataset.itemId).toBe('10');
    expect(featuredTitle()).toBe('Movie One');
  });

  it('follows the focused poster with the featured card: title, rating, year, poster', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [
      { ...vod('10', 'Movie One'), poster: 'http://host/p1.jpg', rating: '6.24', year: 2017 },
      { ...vod('11', 'Movie Two'), poster: 'http://host/p2.jpg' },
    ]);
    const feature = () => container.querySelector<HTMLElement>('.catalog-feature')!;
    expect(feature().querySelector('.catalog-feature-rating')?.textContent).toBe('6.2');
    expect(feature().querySelector('.catalog-feature-year')?.textContent).toBe('2017');
    expect(feature().querySelector<HTMLImageElement>('.catalog-feature-poster img')?.src).toContain('p1.jpg');

    hover('.catalog-tile[data-item-id="11"]');

    expect(featuredTitle()).toBe('Movie Two');
    expect(feature().querySelector<HTMLImageElement>('.catalog-feature-poster img')?.src).toContain('p2.jpg');
    // No rating and no year from the provider: nothing is made up.
    expect(feature().querySelector('.catalog-feature-rating')).toBeNull();
    expect(feature().querySelector('.catalog-feature-year')).toBeNull();
  });

  it('shows the year above a poster only when the provider sent one', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [{ ...vod('10', 'Movie One'), year: 2017 }, vod('11', 'Movie Two')]);
    const years = Array.from(container.querySelectorAll('.catalog-tile-year')).map((y) => y.textContent?.trim());
    expect(years).toEqual(['2017', '']);
  });

  it('opens on Continue watching when something was left unfinished', async () => {
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '77', name: 'Half Seen', poster: '', ext: 'mkv', position: 100, duration: 6000, updatedAt: 2 },
      { accountId: 'x1', kind: 'episode', itemId: '5', name: 'An episode', poster: '', ext: 'mp4', position: 1, duration: 2, updatedAt: 1 },
    ]);
    const { view, handlers } = await openWith();

    expect(own('~continue')).toEqual({ name: 'Continue Watching', count: '1', active: true });
    expect(names()).toEqual(['Half Seen']);
    // The provider category was not fetched: Continue comes from the TV itself.
    expect(catalogMock.loadVodStreams).not.toHaveBeenCalled();

    // Watch goes straight back to where it stopped.
    storageMock.getResume.mockReturnValue({ position: 100 } as never);
    hover('[data-catalog-action="watch"]');
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: '77', resumeSecs: 100, url: 'http://host:8080/movie/u/p/77.mkv',
    }));
  });

  it('lists Favorites from stored snapshots and queues the ones after the movie opened there', async () => {
    watchlistState.entries = [
      { accountId: 'x1', kind: 'vod', itemId: '42', name: 'Saved One', poster: '', rating: '', categoryId: '9', containerExtension: 'mp4', addedAt: 2 },
      { accountId: 'x1', kind: 'vod', itemId: '43', name: 'Saved Two', poster: '', rating: '', categoryId: '9', containerExtension: 'mkv', addedAt: 1 },
    ];
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith();
    expect(own('~favorites')).toEqual({ name: 'Favorites', count: '2', active: false });

    hover('.catalog-cat[data-category-id="~favorites"]');
    view.handleAction('select');
    expect(names()).toEqual(['Saved One', 'Saved Two']);

    hover('.catalog-tile[data-item-id="42"]');
    view.handleAction('select');
    await flush();
    expect(container.querySelector('.movies-detail')?.textContent).toContain('Saved One');
    hover('[data-action="play"]');
    view.handleAction('select');
    const request = handlers.onPlayVod.mock.calls[0][0];
    expect(request.watchlistQueue.map((item: { itemId: string }) => item.itemId)).toEqual(['43']);
  });

  it('selecting a category loads it once and shows it, keeping focus on the category', async () => {
    const { view } = await openWith([{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }]);
    catalogMock.loadVodStreams.mockClear();
    let release: (items: unknown[]) => void = () => {};
    catalogMock.loadVodStreams.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    hover('.catalog-cat[data-category-id="2"]');
    view.handleAction('select');
    // While it loads: the header already names it, the grid shows placeholders.
    expect(container.querySelector('.catalog-head-name')?.textContent).toBe('Cat B');
    expect(container.querySelectorAll('.catalog-skeleton-tile').length).toBeGreaterThan(0);

    release([vod('20', 'Movie B', '2')]);
    await flush();
    expect(names()).toEqual(['Movie B']);
    expect(cats().map((c) => c.active)).toEqual([false, true]);
    expect(focused()?.dataset.categoryId).toBe('2');
    expect(catalogMock.loadVodStreams).toHaveBeenCalledWith(account, '2', expect.anything());

    // Coming back to a category already seen does not ask the server again.
    catalogMock.loadVodStreams.mockClear();
    hover('.catalog-cat[data-category-id="1"]');
    view.handleAction('select');
    expect(catalogMock.loadVodStreams).not.toHaveBeenCalled();
    expect(names()).toEqual(['Movie One']);
  });

  it('counts a category once visited, and every category once the whole catalog arrives', async () => {
    let releaseAll: (items: unknown[]) => void = () => {};
    catalogMock.loadAllVodStreams.mockImplementation(() => new Promise((resolve) => { releaseAll = resolve; }));
    await openWith([{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }, { id: '3', name: 'Cat C' }]);
    expect(cats().map((c) => c.count)).toEqual(['1', '', '']);

    releaseAll([vod('10', 'Movie One'), vod('20', 'B1', '2'), vod('21', 'B2', '2')]);
    await flush();
    expect(cats().map((c) => c.count)).toEqual(['1', '2', '0']);
  });

  it('keeps working on visited categories when the whole catalog cannot be fetched', async () => {
    catalogMock.loadAllVodStreams.mockRejectedValue(new Error('too big'));
    const { view } = await openWith([{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }]);
    await flush();
    expect(cats().map((c) => c.count)).toEqual(['1', '']);
    expect(names()).toEqual(['Movie One']);
    view.handleAction('down');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
  });

  it('searches every category for movies and narrows the category list, and Back clears it', async () => {
    vi.useFakeTimers();
    try {
      catalogMock.loadAllVodStreams.mockResolvedValue([
        vod('10', 'Movie One'), vod('20', 'Ação Total', '2'), vod('30', 'Outra acao', '3'),
      ]);
      const { view, handlers } = await openWith([
        { id: '1', name: 'Cat A' }, { id: '2', name: 'Drama' }, { id: '3', name: 'Ação' },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      const input = container.querySelector<HTMLInputElement>('.catalog-search-input')!;

      input.value = 'acao';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);

      // Accents and case do not matter; results come from categories never opened.
      expect(names()).toEqual(['Ação Total', 'Outra acao']);
      expect(cats().map((c) => c.name)).toEqual(['Ação']);
      expect(container.querySelector('.catalog-head-name')?.textContent).toBe('Search results');
      expect(input.value).toBe('acao');

      view.handleAction('back');
      expect(handlers.onBack).not.toHaveBeenCalled();
      expect(input.value).toBe('');
      expect(names()).toEqual(['Movie One']);
      expect(cats()).toHaveLength(3);

      input.value = 'zzz';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
      expect(container.querySelector('.catalog-grid-empty')?.textContent).toBe('Nothing found.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cycles the order: recently added, A-Z, rating, year', async () => {
    const { view } = await openWith([{ id: '1', name: 'Cat A' }], [
      { ...vod('1', 'Bravo'), rating: '5', year: 2001, addedAt: 300 },
      { ...vod('2', 'alpha'), rating: '9', year: 1999, addedAt: 100 },
      { ...vod('3', 'Charlie'), rating: '7', year: 2020, addedAt: 200 },
    ]);
    const sort = () => container.querySelector('.catalog-sort')?.textContent?.trim();
    expect(sort()).toBe('Recently added');
    expect(names()).toEqual(['Bravo', 'Charlie', 'alpha']);

    hover('[data-catalog-action="sort"]');
    view.handleAction('select');
    expect(sort()).toBe('A–Z');
    expect(names()).toEqual(['alpha', 'Bravo', 'Charlie']);

    view.handleAction('select');
    expect(sort()).toBe('Rating');
    expect(names()).toEqual(['alpha', 'Charlie', 'Bravo']);

    view.handleAction('select');
    expect(sort()).toBe('Year');
    expect(names()).toEqual(['Charlie', 'Bravo', 'alpha']);
  });

  it('keeps the provider order under "recently added" when no date was sent', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [vod('1', 'Zulu'), vod('2', 'Alpha')]);
    expect(names()).toEqual(['Zulu', 'Alpha']);
    expect(container.querySelector('.catalog-head-new')).toBeNull();
  });

  it('says how many titles of the category arrived this week', async () => {
    const now = Date.now();
    await openWith([{ id: '1', name: 'Cat A' }], [
      { ...vod('1', 'New'), addedAt: now - 86400000 },
      { ...vod('2', 'Old'), addedAt: now - 30 * 86400000 },
    ]);
    expect(container.querySelector('.catalog-head-new')?.textContent).toBe('+1 new');
  });

  it('favorites the featured movie from the card and shows it as a category', async () => {
    const { view } = await openWith();
    hover('[data-catalog-action="favorite"]');

    view.handleAction('select');

    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', containerExtension: 'mp4',
    }));
    expect(container.querySelector('[data-catalog-action="favorite"]')?.textContent?.trim()).toBe('Favorited');
    expect(focused()?.dataset.catalogAction).toBe('favorite');
    expect(own('~favorites').count).toBe('1');

    view.handleAction('select');
    expect(container.querySelector('[data-catalog-action="favorite"]')?.textContent?.trim()).toBe('Favorite');
    expect(own('~favorites').count).toBe('0');
  });

  it('OK on a poster and Details both open the detail screen; Watch plays', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(null);
    const { view, handlers } = await openWith();

    view.handleAction('select');
    await flush();
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    // Back lands on the poster it came from.
    expect(focused()?.dataset.itemId).toBe('10');

    hover('[data-catalog-action="details"]');
    view.handleAction('select');
    await flush();
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    view.handleAction('back');

    hover('[data-catalog-action="watch"]');
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: '10', resumeSecs: 0 }));
  });

  it('routes the D-pad between the side column, the card and the grid', async () => {
    const { view, handlers } = await openWith(
      [{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }],
      [vod('10', 'M1'), vod('11', 'M2'), vod('12', 'M3'), vod('13', 'M4'), vod('14', 'M5'), vod('15', 'M6')],
    );
    const zone = () => focused()?.dataset.catalogAction ?? `item:${focused()?.dataset.itemId}`;

    view.handleAction('right');
    expect(zone()).toBe('item:11');
    view.handleAction('down');
    expect(zone()).toBe('item:15'); // the short last row takes what it has
    view.handleAction('up');
    expect(zone()).toBe('item:10');
    view.handleAction('left');
    expect(focused()?.dataset.categoryId).toBe('1'); // the active category
    view.handleAction('down');
    expect(focused()?.dataset.categoryId).toBe('2');
    for (let i = 0; i < 4; i++) view.handleAction('up');
    expect(zone()).toBe('search');
    view.handleAction('up');
    expect(zone()).toBe('home');
    view.handleAction('up');
    expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(1);

    view.handleAction('right');
    expect(zone()).toBe('watch');
    view.handleAction('right');
    expect(zone()).toBe('details');
    view.handleAction('down');
    expect(zone()).toBe('item:10');
    view.handleAction('up');
    expect(zone()).toBe('watch');
    view.handleAction('up');
    expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(2);

    // The sort button sits above the last column.
    hover('.catalog-tile[data-item-id="14"]');
    view.handleAction('up');
    expect(zone()).toBe('sort');
    view.handleAction('down');
    expect(zone()).toBe('item:14');
  });

  it('leaves through the Home pill and through Back', async () => {
    const { view, handlers } = await openWith();
    hover('[data-catalog-action="home"]');
    view.handleAction('select');
    view.handleAction('back');
    expect(handlers.onBack).toHaveBeenCalledTimes(2);
  });

  it('virtualizes 50,000 categories and a 50,000-item grid', async () => {
    const categories = Array.from({ length: 50_000 }, (_, i) => ({ id: String(i), name: `Cat ${i}` }));
    const streams = Array.from({ length: 50_000 }, (_, i) => vod(String(i), `Movie ${i}`, '0'));
    const { view } = await openWith(categories, streams);

    expect(container.querySelectorAll('.catalog-cat').length).toBeLessThan(80);
    expect(container.querySelectorAll('.catalog-tile').length).toBeLessThan(60);
    expect(container.querySelector<HTMLElement>('.catalog-cats-track')!.style.height).toBe(`${50_002 * 42}px`);

    // Walking down keeps rendering only a window, wherever it is.
    for (let i = 0; i < 40; i++) view.handleAction('down');
    expect(focused()?.dataset.itemId).toBe('200');
    expect(container.querySelectorAll('.catalog-tile').length).toBeLessThan(60);

    hover('.catalog-cat');
    for (let i = 0; i < 62; i++) view.handleAction('down');
    expect(focused()?.dataset.categoryId).toBe('60');
    expect(container.querySelectorAll('.catalog-cat').length).toBeLessThan(80);
  }, 30_000);

  it('moves focus inside the window without re-rendering the grid', async () => {
    const streams = Array.from({ length: 12 }, (_, i) => vod(String(i), `Movie ${i}`));
    const { view } = await openWith([{ id: '1', name: 'Cat A' }], streams);
    const first = container.querySelector('.catalog-grid-cell');
    const ensure = vi.spyOn(VirtualGrid.prototype, 'ensureVisible').mockReturnValue(false);
    try {
      view.handleAction('right');
      expect(focused()?.dataset.itemId).toBe('1');
      expect(container.querySelector('.catalog-grid-cell')).toBe(first);
    } finally {
      ensure.mockRestore();
    }
  });

  it('snaps free grid scrolling to the nearest row after it stops', async () => {
    vi.useFakeTimers();
    try {
      const streams = Array.from({ length: 200 }, (_, i) => vod(String(i), `Movie ${i}`));
      await openWith([{ id: '1', name: 'Cat A' }], streams);
      await vi.advanceTimersByTimeAsync(0);
      const grid = container.querySelector<HTMLElement>('.catalog-grid')!;

      grid.scrollTop = 460 * 3 + 150;
      grid.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(200);

      expect(grid.scrollTop).toBe(460 * 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('escapes names coming from the provider', async () => {
    await openWith([{ id: '1', name: '<img src=x onerror=1>' }], [vod('10', '<b>Movie</b>')]);
    expect(container.querySelector('.catalog-side img, .catalog-grid b, .catalog-feature b')).toBeNull();
    expect(featuredTitle()).toBe('<b>Movie</b>');
  });

  it('explains an empty Favorites or Continue watching instead of hiding them', async () => {
    const { view } = await openWith();
    hover('.catalog-cat[data-category-id="~favorites"]');
    view.handleAction('select');
    expect(container.querySelector('.catalog-grid-empty')?.textContent).toBe('Nothing favorited yet.');
    hover('.catalog-cat[data-category-id="~continue"]');
    view.handleAction('select');
    expect(container.querySelector('.catalog-grid-empty')?.textContent).toBe('Nothing in progress.');
  });

  it('says so when the account has no movies', async () => {
    await openWith([], []);
    expect(container.querySelector('.catalog-empty')?.textContent).toBe('No movies are available for this account.');
  });

  it('picks up a new resume point when the player hands control back', async () => {
    const { view } = await openWith();
    expect(own('~continue').count).toBe('0');

    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4', position: 5, duration: 100, updatedAt: 9 },
    ]);
    view.refreshPlaybackState();

    expect(own('~continue').count).toBe('1');
  });
});

describe('Movies detail', () => {
  it('adds and removes the movie from Watchlist without losing button focus', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    const button = container.querySelector('[data-action="watchlist"]') as HTMLElement;
    button.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One',
    }));
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Remove from Watchlist');
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Added to Watchlist');

    view.handleAction('select');
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Add to Watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Watchlist');
  });

  it('renders plot/meta and a Play button, and plays from the start', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: 'A plot.', cast: 'Actor A', director: 'Dir A', genre: 'Drama',
      releaseDate: '2020-05-01', durationSecs: 3600, poster: 'http://host:8080/p.jpg',
      imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    expect(container.querySelector('.detail-plot')?.textContent).toContain('A plot.');
    expect(container.textContent).toContain('Drama');
    expect(container.textContent).toContain('2020');

    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: '10', accountId: 'x1', kind: 'vod', resumeSecs: 0,
      url: 'http://host:8080/movie/u/p/10.mp4',
      watchlistQueue: undefined,
    }));
  });

  it('offers Resume when a resume point exists and passes its position', async () => {
    const { StorageService } = await import('../services/storage-service');
    (StorageService.getResume as ReturnType<typeof vi.fn>).mockReturnValue(
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', position: 900, duration: 3600, updatedAt: 1 },
    );
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 3600, poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    const resume = container.querySelector('[data-action="resume"]') as HTMLElement;
    expect(resume).not.toBeNull();
    resume.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ resumeSecs: 900 }));
  });

  it('refreshes the detail actions when playback creates a resume point', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 3600,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('[data-action="resume"]')).toBeNull();

    storageMock.getResume.mockReturnValue({
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '',
      ext: 'mp4', position: 20, duration: 3600, updatedAt: 1,
    });
    view.refreshPlaybackState();
    expect(container.querySelector('[data-action="resume"]')).not.toBeNull();
  });

  it('backs out of detail to the browse view', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({ plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    const { view, handlers } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('forwards searchMeta.tmdbId to onPlayVod when currentInfo has it', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: 'p', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '',
      imdbId: '1375666', tmdbId: '27205', year: 2010,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      searchMeta: { imdbId: '1375666', tmdbId: '27205', year: 2010 },
    }));
  });

  it('preserves detail focus across the info re-render instead of snapping to the first button', async () => {
    const { StorageService } = await import('../services/storage-service');
    (StorageService.getResume as ReturnType<typeof vi.fn>).mockReturnValue(
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', position: 900, duration: 3600, updatedAt: 1 },
    );
    let resolveInfo!: (v: unknown) => void;
    catalogMock.loadVodInfo.mockReturnValue(new Promise((r) => { resolveInfo = r; }));
    const { view } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); // info-less render committed; focus lands on the first button (Resume)
    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })); // move focus to Play
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('play');
    resolveInfo({ plot: 'x', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    await Promise.resolve(); await Promise.resolve(); // info re-render
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('play');
  });
});

describe('Movies deep-link (openItem)', () => {
  it('opens a movie detail directly and Back returns to Search via the callback', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({ plot: 'Deep plot.', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const onDetailBack = vi.fn();
    const view = new Movies(container, handlers);
    await view.openItem(account, vod('42', 'Deep Movie', '9'), onDetailBack);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    expect(container.textContent).toContain('Deep Movie');
    // No browse is loaded underneath; Back returns to Search via the callback.
    expect(container.querySelector('.catalog-browse')).toBeNull();
    view.handleAction('back');
    expect(onDetailBack).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).not.toHaveBeenCalled(); // did not fall through to Live
  });
});

describe('Movies account-switch race', () => {
  it('a superseded a1 open() cannot clobber a2 rails (account-switch race)', async () => {
    const a1: PlaylistEntry = { id: 'a1', name: 'A1', url: 'http://host/a', source: 'xtream', xtream: { username: 'u1', password: 'p1' } };
    const a2: PlaylistEntry = { id: 'a2', name: 'A2', url: 'http://host/a', source: 'xtream', xtream: { username: 'u2', password: 'p2' } };

    let resolveA1Cats!: (v: unknown) => void;
    let resolveA2Cats!: (v: unknown) => void;
    let resolveA2Streams!: (v: unknown) => void;

    catalogMock.loadVodCategories
      .mockReturnValueOnce(new Promise((r) => { resolveA1Cats = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolveA2Cats = r; }));
    // a1's categories guard fires before loadVodStreams is called for a1,
    // so only one stream load occurs (for a2).
    catalogMock.loadVodStreams
      .mockReturnValueOnce(new Promise((r) => { resolveA2Streams = r; }));

    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const view = new Movies(container, handlers);

    // Start both opens concurrently; neither has resolved yet.
    const p1 = view.open(a1);
    const a1Signal = catalogMock.loadVodCategories.mock.calls[0][1] as AbortSignal;
    const p2 = view.open(a2);
    expect(a1Signal.aborted).toBe(true);
    expect(catalogMock.loadVodCategories.mock.calls[1][1]).toBeInstanceOf(AbortSignal);

    // Resolve a2's categories; wait for open(a2) to resume and call loadVodStreams.
    resolveA2Cats([{ id: 'c2', name: 'Cat Bravo' }]);
    await Promise.resolve(); await Promise.resolve();
    resolveA2Streams([vod('v2', 'Bravo Movie', 'c2')]);
    await p2;

    // Resolve a1's stale categories last — first guard discards them.
    resolveA1Cats([{ id: 'c1', name: 'Cat Alpha' }]);
    await p1;

    expect(container.textContent).toContain('Bravo Movie');
    expect(container.textContent).not.toContain('Alpha Movie');
    expect(container.textContent).toContain('Cat Bravo');
    expect(container.textContent).not.toContain('Cat Alpha');
  });
});
