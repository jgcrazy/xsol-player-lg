import type { Action, PlaylistEntry, ResumeEntry, ResumeKind, VodPlayback } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { t, tp } from '../i18n';
import { VirtualGrid } from '../utils/virtual-grid';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { createLogger } from '../utils/logger';
import {
  CHEVRON_LEFT_ICON, FILTER_ICON, INFO_ICON, PLAY_ICON, SEARCH_ICON, STAR_ICON, favoriteIcon,
} from './icons';

const log = createLogger('Catalog');

// Five posters across the 1384px main column, as in the design.
const CATALOG_GRID_COLUMN_STRIDE = 276;
const CATALOG_GRID_ROW_STRIDE = 460;
const CATALOG_GRID_OVERSCAN_ROWS = 2;
const CATALOG_GRID_VIEWPORT_WIDTH = 1384;
const CATALOG_GRID_VIEWPORT_HEIGHT = 500;
const CATEGORY_STRIDE = 42;
const CATEGORY_VIEWPORT = 780;
const GRID_SNAP_DELAY_MS = 95;
const SEARCH_DEBOUNCE_MS = 250;
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Sidebar entries that are not provider categories. */
export const CONTINUE_CATEGORY_ID = '~continue';
export const FAVORITES_CATEGORY_ID = '~favorites';

export type CatalogSort = 'recent' | 'az' | 'rating' | 'year';
const SORT_ORDER: CatalogSort[] = ['recent', 'az', 'rating', 'year'];

export interface CatalogItemMeta {
  rating: string;
  /** 0 when the provider did not say. */
  year: number;
  /** Epoch ms the provider added the title, 0 when unknown. */
  addedAt: number;
}

export interface CatalogHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayVod: (req: Omit<VodPlayback, 'onBack'>) => void;
}

type Mode = 'browse' | 'detail';
type Direction = 'up' | 'down' | 'left' | 'right';
interface SideCategory { id: string; name: string; count: number | null }

function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function ratingText(rating: string): string {
  const value = parseFloat(rating);
  return value > 0 ? (Math.round(value * 10) / 10).toFixed(1) : '';
}

// Shared machinery for the Xtream catalog sections (Movies, Series): one browse
// screen - a side column (back, search, categories), a featured card for the
// focused title and the poster grid of the active category - plus a detail
// screen, driven by one SpatialNav. Back walks detail -> browse -> home.
// Subclasses supply the catalog loaders, item accessors, and the detail
// rendering / playback specifics.
export abstract class CatalogView<C extends { id: string; name: string }, I> {
  protected nav: SpatialNav;
  protected account: PlaylistEntry | null = null;
  protected mode: Mode = 'browse';
  protected categories: C[] = [];
  protected resume: ResumeEntry[] = [];
  protected itemsByCategory: Record<string, I[]> = {};
  protected deepLinkBack: (() => void) | null = null;
  private allItems: I[] | null = null;
  private counts: Record<string, number> = {};
  private activeCategoryId = '';
  private query = '';
  private sortMode: CatalogSort = 'recent';
  private gridList: I[] = [];
  private sideCache: SideCategory[] | null = null;
  private featured: I | null = null;
  private loadingCategory = false;
  private loaded = false;
  private gridFocusIndex = 0;
  private readonly gridVirtualizer = new VirtualGrid({
    columnStride: CATALOG_GRID_COLUMN_STRIDE,
    rowStride: CATALOG_GRID_ROW_STRIDE,
    overscanRows: CATALOG_GRID_OVERSCAN_ROWS,
    fallbackViewportWidth: CATALOG_GRID_VIEWPORT_WIDTH,
    fallbackViewportHeight: CATALOG_GRID_VIEWPORT_HEIGHT,
  });
  private gridScrollFrame: number | null = null;
  private readonly categoryVirtualizer = new VirtualList({
    itemSize: CATEGORY_STRIDE,
    overscan: 6,
    fallbackViewportSize: CATEGORY_VIEWPORT,
  });
  private categoryScrollFrame: number | null = null;
  protected readonly scrollGuard = new VirtualScrollGuard();
  private gridSnapTimer: ReturnType<typeof setTimeout> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private requestController: AbortController | null = null;

  constructor(protected container: HTMLElement, protected handlers: CatalogHandlers) {
    this.nav = new SpatialNav(container, (el) => this.onFocusChanged(el));
    this.container.addEventListener('mouseleave', () => this.nav.clearHighlight());
    this.container.addEventListener('input', (event: Event) => {
      const target = event.target as HTMLElement;
      if (!(target instanceof HTMLInputElement) || !target.classList.contains('catalog-search-input')) return;
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      const value = target.value;
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        this.setQuery(value);
      }, SEARCH_DEBOUNCE_MS);
    });
    // The global key handler leaves typing to the field; Enter there means "done".
    this.container.addEventListener('keydown', (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== 'Enter' || !(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains('catalog-search-input')) return;
      event.preventDefault();
      event.stopPropagation();
      target.blur();
      if (this.searchTimer !== null) {
        clearTimeout(this.searchTimer);
        this.searchTimer = null;
      }
      this.setQuery(target.value);
      this.moveFromSearch('right');
    });
    this.container.addEventListener('scroll', (event: Event) => {
      const target = event.target as HTMLElement;
      if (this.handleExtraScroll(target)) return;
      if (this.mode !== 'browse') return;
      if (target.classList.contains('catalog-cats')) {
        const offset = this.scrollGuard.readUserOffset(target, 'vertical');
        if (offset === null) return;
        this.categoryVirtualizer.setScrollOffset(offset);
        if (this.categoryScrollFrame === null) {
          this.categoryScrollFrame = requestAnimationFrame(() => {
            this.categoryScrollFrame = null;
            if (this.mode === 'browse') this.renderBrowse(false);
          });
        }
        return;
      }
      if (!target.classList.contains('catalog-grid')) return;
      const scrollTop = this.scrollGuard.readUserOffset(target, 'vertical');
      if (scrollTop === null) return;
      this.gridVirtualizer.setScrollOffset(scrollTop);
      this.scheduleGridSnap(target);
      if (this.gridScrollFrame !== null) return;
      this.gridScrollFrame = requestAnimationFrame(() => {
        this.gridScrollFrame = null;
        if (this.mode === 'browse') this.renderBrowse(false);
      });
    }, true);
  }

  // --- subclass configuration ---
  protected abstract readonly kicker: string;             // section name, e.g. 'Movies'
  protected abstract readonly resumeKind: ResumeKind;     // which resume entries this section owns
  protected abstract readonly emptyMessage: string;       // no catalog on the account
  protected abstract readonly gridEmptyMessage: string;   // empty category grid
  protected abstract readonly searchPlaceholder: string;
  protected abstract loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<C[]>;
  protected abstract loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]>;
  // The whole catalog in one request: feeds the category counts and the search.
  protected abstract loadAllItems(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<I[]>;
  protected abstract itemId(item: I): string;
  protected abstract itemName(item: I): string;
  protected abstract itemPoster(item: I): string;
  protected abstract itemCategoryId(item: I): string;
  protected abstract itemMeta(item: I): CatalogItemMeta;
  protected abstract openDetail(item: I, fromFavorites?: boolean): Promise<void>;
  protected abstract renderDetail(restoreFocus?: boolean): void;
  protected abstract clearDetail(): void;                 // drop detail state on deep-link back
  // Section-specific selects on the detail screen. Returns true if handled.
  protected abstract selectExtra(el: HTMLElement): boolean;
  protected moveExtraFocus(_action: Action): boolean { return false; }
  protected handleExtraScroll(_target: HTMLElement): boolean { return false; }
  protected onRequestSessionReset(): void {}
  // What "Continue watching" and "Favorites" list, newest first.
  protected abstract continueItems(): I[];
  protected abstract favoriteItems(): I[];
  protected abstract isFavorite(item: I): boolean;
  /** Returns true when the item is now a favorite. */
  protected abstract toggleFavorite(item: I): boolean;
  // "Watch" on the featured card.
  protected abstract playFeatured(item: I): void;
  // OK on a poster; the detail screen unless a section says otherwise.
  protected openTile(item: I, fromFavorites: boolean): void {
    void this.openDetail(item, fromFavorites);
  }

  setAccount(account: PlaylistEntry): void {
    if (this.account?.id !== account.id) {
      this.requestController?.abort();
      this.onRequestSessionReset();
    }
    this.account = account;
  }

  protected get requestSignal(): AbortSignal | null {
    return this.requestController?.signal ?? null;
  }

  protected requestFailed(context: string, err: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    log.error(
      `${context} failed`,
      'event=xtream.view.load.failed',
      `operation=${context.toLowerCase().replace(/\s+/g, '_')}`,
      err,
    );
    return true;
  }

  private beginRequests(): AbortSignal {
    this.requestController?.abort();
    this.onRequestSessionReset();
    this.requestController = new AbortController();
    return this.requestController.signal;
  }

  // Back from the player: positions and favorites may have changed meanwhile.
  refreshPlaybackState(): void {
    if (this.mode === 'detail') {
      this.renderDetail();
      return;
    }
    if (!this.account || !this.loaded) return;
    this.refreshResume();
    if (!this.sideCategories().some((category) => category.id === this.activeCategoryId)) {
      this.activeCategoryId = this.defaultCategoryId();
    }
    this.rebuildGrid();
    this.renderBrowse();
  }

  deactivate(): void {
    this.requestController?.abort();
    this.requestController = null;
    this.onRequestSessionReset();
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  async open(account: PlaylistEntry): Promise<void> {
    const signal = this.beginRequests();
    this.account = account;
    this.deepLinkBack = null;
    this.mode = 'browse';
    this.categories = [];
    this.itemsByCategory = {};
    this.allItems = null;
    this.counts = {};
    this.query = '';
    this.gridList = [];
    this.featured = null;
    this.loaded = false;
    this.loadingCategory = false;
    this.gridFocusIndex = 0;
    this.categoryVirtualizer.setScrollOffset(0);
    this.gridVirtualizer.setScrollOffset(0);
    this.refreshResume();
    this.renderLoading();
    try {
      const categories = await this.loadCategories(account, signal);
      if (signal.aborted || this.account?.id !== account.id) return;
      this.categories = categories;
      this.activeCategoryId = this.defaultCategoryId();
      await this.ensureCategoryLoaded(this.activeCategoryId, account, signal);
      if (signal.aborted || this.account?.id !== account.id) return;
    } catch (err) {
      if (signal.aborted) return;
      log.error(
        'Catalog browse load failed',
        'event=xtream.view.load.failed',
        'operation=browse',
        err,
      );
      if (this.account?.id !== account.id) return;
      this.activeCategoryId = this.defaultCategoryId();
    }
    this.loaded = true;
    this.rebuildGrid();
    this.renderBrowse();
    this.focusInitial();
    void this.loadWholeCatalog(account, signal);
  }

  // Never awaited by open(): the screen works on the active category alone, and
  // the counts and the cross-category search arrive when this does.
  private async loadWholeCatalog(account: PlaylistEntry, signal: AbortSignal): Promise<void> {
    if (!this.categories.length) return;
    let all: I[];
    try {
      all = await this.loadAllItems(account, signal);
    } catch (err) {
      if (signal.aborted) return;
      log.warn(
        'Whole catalog load failed',
        'event=xtream.view.load.failed',
        'operation=all_items',
        err,
      );
      return;
    }
    if (signal.aborted || this.account?.id !== account.id) return;
    this.allItems = all;
    const counts: Record<string, number> = {};
    for (let i = 0; i < all.length; i++) {
      const id = this.itemCategoryId(all[i]);
      counts[id] = (counts[id] || 0) + 1;
    }
    this.counts = counts;
    this.sideCache = null;
    if (this.mode !== 'browse') return;
    if (this.query) this.rebuildGrid();
    this.renderBrowse(false);
  }

  private async ensureCategoryLoaded(id: string, account: PlaylistEntry, signal: AbortSignal): Promise<void> {
    if (!id || id === CONTINUE_CATEGORY_ID || id === FAVORITES_CATEGORY_ID) return;
    if (this.itemsByCategory[id]) return;
    this.itemsByCategory[id] = await this.loadItems(account, id, signal);
  }

  private refreshResume(): void {
    this.resume = StorageService.getResumeList(this.account!.id).filter((e) => e.kind === this.resumeKind);
  }

  private defaultCategoryId(): string {
    if (this.continueItems().length) return CONTINUE_CATEGORY_ID;
    if (this.categories.length) return this.categories[0].id;
    return FAVORITES_CATEGORY_ID;
  }

  // Deep-link entry (from Search): open this item's detail directly. Back returns
  // to the caller via onDetailBack (no browse is loaded underneath).
  async openItem(account: PlaylistEntry, item: I, onDetailBack: () => void): Promise<void> {
    this.beginRequests();
    this.account = account;
    this.deepLinkBack = onDetailBack;
    await this.openDetail(item);
  }

  handleAction(action: Action): void {
    if (this.moveExtraFocus(action)) return;
    if (this.mode === 'browse') {
      const active = document.activeElement;
      const typing = active instanceof HTMLInputElement && this.container.contains(active);
      if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
        // The field keeps DOM focus while the D-pad moves on; let go of it first.
        if (typing) (active as HTMLInputElement).blur();
        this.moveBrowse(action);
        return;
      }
      if (action === 'back' && typing) {
        (active as HTMLInputElement).blur();
        return;
      }
    }
    switch (action) {
      case 'up':
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
        return;
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.onBack();
        return;
      default:
        return;
    }
  }

  private onBack(): void {
    if (this.mode === 'detail') {
      if (this.deepLinkBack) { const back = this.deepLinkBack; this.deepLinkBack = null; this.clearDetail(); back(); return; }
      this.clearDetail();
      this.mode = 'browse';
      this.rebuildGrid();
      this.renderBrowse();
      if (!this.focusGrid()) this.focusInitial();
      return;
    }
    if (this.query) {
      this.clearQuery();
      return;
    }
    this.handlers.onBack();
  }

  private onSelect(): void {
    const el = this.nav.focused;
    if (!el || !this.account) return;
    if (this.mode === 'detail') {
      this.selectExtra(el);
      return;
    }
    const action = el.dataset.catalogAction;
    if (action === 'home') { this.handlers.onBack(); return; }
    if (action === 'search') { (el as HTMLInputElement).focus(); return; }
    if (action === 'category') { void this.selectCategory(el.dataset.categoryId ?? ''); return; }
    if (action === 'sort') { this.cycleSort(); return; }
    if (action === 'watch') { if (this.featured) this.playFeatured(this.featured); return; }
    if (action === 'details') { if (this.featured) this.openTile(this.featured, this.showingFavorites()); return; }
    if (action === 'favorite') { this.toggleFeaturedFavorite(); return; }
    if (el.dataset.itemId !== undefined) {
      const item = this.findItem(el.dataset.itemId);
      if (item) this.openTile(item, this.showingFavorites());
    }
  }

  private showingFavorites(): boolean {
    return !this.query && this.activeCategoryId === FAVORITES_CATEGORY_ID;
  }

  private toggleFeaturedFavorite(): void {
    const item = this.featured;
    if (!item) return;
    this.toggleFavorite(item);
    this.sideCache = null;
    // Un-favoriting inside Favorites removes the tile it was showing.
    if (this.showingFavorites()) this.rebuildGrid(this.itemId(item));
    this.renderBrowse();
    if (!this.nav.focused || !this.container.contains(this.nav.focused)) this.focusFeature('favorite');
  }

  private cycleSort(): void {
    this.sortMode = SORT_ORDER[(SORT_ORDER.indexOf(this.sortMode) + 1) % SORT_ORDER.length];
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.rebuildGrid();
    this.renderBrowse();
  }

  private async selectCategory(id: string): Promise<void> {
    const account = this.account;
    const signal = this.requestSignal;
    if (!account || !signal || signal.aborted || !id) return;
    this.activeCategoryId = id;
    this.query = '';
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    const input = this.container.querySelector<HTMLInputElement>('.catalog-search-input');
    if (input) input.value = '';
    const needsLoad = id !== CONTINUE_CATEGORY_ID && id !== FAVORITES_CATEGORY_ID && !this.itemsByCategory[id];
    this.loadingCategory = needsLoad;
    this.rebuildGrid();
    this.renderBrowse();
    this.focusCategory(id);
    if (!needsLoad) return;
    try {
      await this.ensureCategoryLoaded(id, account, signal);
    } catch (err) {
      if (signal.aborted) return;
      log.error(
        'Catalog category load failed',
        'event=xtream.view.load.failed',
        'operation=category',
        err,
      );
      this.itemsByCategory[id] = [];
    }
    if (signal.aborted || this.account?.id !== account.id || this.activeCategoryId !== id) return;
    this.loadingCategory = false;
    if (this.mode !== 'browse') return;
    this.rebuildGrid();
    this.renderBrowse();
  }

  private setQuery(value: string): void {
    const next = value.trim();
    if (next === this.query || this.mode !== 'browse') return;
    this.query = next;
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.categoryVirtualizer.setScrollOffset(0);
    this.rebuildGrid();
    this.renderBrowse(false);
  }

  private clearQuery(): void {
    const input = this.container.querySelector<HTMLInputElement>('.catalog-search-input');
    if (input) input.value = '';
    this.query = '';
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.categoryVirtualizer.setScrollOffset(0);
    this.rebuildGrid();
    this.renderBrowse();
  }

  // --- data shown ---

  // Rebuilt only when something it shows changes: every focus move and scroll
  // frame reads it, and a provider can send thousands of categories.
  private sideCategories(): SideCategory[] {
    if (!this.sideCache) this.sideCache = this.buildSideCategories();
    return this.sideCache;
  }

  private buildSideCategories(): SideCategory[] {
    const list: SideCategory[] = [];
    // Always offered, even while empty, so they are where the user expects them.
    list.push({
      id: CONTINUE_CATEGORY_ID, name: t('catalog.continueWatching'), count: this.continueItems().length,
    });
    list.push({ id: FAVORITES_CATEGORY_ID, name: t('catalog.favorites'), count: this.favoriteItems().length });
    for (let i = 0; i < this.categories.length; i++) {
      const category = this.categories[i];
      const loaded = this.itemsByCategory[category.id];
      const counted = this.counts[category.id];
      list.push({
        id: category.id,
        name: category.name,
        count: counted !== undefined ? counted : (loaded ? loaded.length : (this.allItems ? 0 : null)),
      });
    }
    if (!this.query) return list;
    const needle = fold(this.query);
    return list.filter((category) => fold(category.name).indexOf(needle) !== -1);
  }

  private activeCategoryName(): string {
    if (this.query) return t('catalog.searchResults');
    if (this.activeCategoryId === CONTINUE_CATEGORY_ID) return t('catalog.continueWatching');
    if (this.activeCategoryId === FAVORITES_CATEGORY_ID) return t('catalog.favorites');
    const category = this.categories.filter((c) => c.id === this.activeCategoryId)[0];
    return category ? category.name : this.kicker;
  }

  // The list behind the grid: the search across every category, or the active
  // category in the chosen order. `dropId` keeps focus sensible after a removal.
  private rebuildGrid(dropId = ''): void {
    this.sideCache = null;
    let list: I[];
    let sortable = true;
    if (this.query) {
      const needle = fold(this.query);
      list = this.searchPool().filter((item) => fold(this.itemName(item)).indexOf(needle) !== -1);
    } else if (this.activeCategoryId === CONTINUE_CATEGORY_ID) {
      list = this.continueItems();
      sortable = false; // most recently watched first, always
    } else if (this.activeCategoryId === FAVORITES_CATEGORY_ID) {
      list = this.favoriteItems();
    } else {
      list = this.itemsByCategory[this.activeCategoryId] ?? [];
    }
    this.gridList = sortable ? this.sorted(list) : list.slice();
    if (dropId) this.gridFocusIndex = Math.min(this.gridFocusIndex, this.gridList.length - 1);
    this.gridFocusIndex = Math.max(0, Math.min(this.gridFocusIndex, this.gridList.length - 1));
    this.featured = this.gridList[this.gridFocusIndex] ?? null;
  }

  private searchPool(): I[] {
    if (this.allItems) return this.allItems;
    // Until the whole catalog is in, search what has been opened so far.
    const seen: Record<string, true> = {};
    const pool: I[] = [];
    Object.keys(this.itemsByCategory).forEach((id) => {
      this.itemsByCategory[id].forEach((item) => {
        const key = this.itemId(item);
        if (seen[key]) return;
        seen[key] = true;
        pool.push(item);
      });
    });
    return pool;
  }

  private sorted(list: I[]): I[] {
    const mode = this.sortMode;
    const rows = list.map((item, index) => ({ item, index, meta: this.itemMeta(item) }));
    // Without a date from the provider, "recent" keeps the provider's own order.
    if (mode === 'recent' && !rows.some((row) => row.meta.addedAt > 0)) return list.slice();
    rows.sort((a, b) => {
      let diff = 0;
      if (mode === 'recent') diff = b.meta.addedAt - a.meta.addedAt;
      else if (mode === 'rating') diff = (parseFloat(b.meta.rating) || 0) - (parseFloat(a.meta.rating) || 0);
      else if (mode === 'year') diff = b.meta.year - a.meta.year;
      else {
        const left = fold(this.itemName(a.item));
        const right = fold(this.itemName(b.item));
        diff = left < right ? -1 : left > right ? 1 : 0;
      }
      return diff || a.index - b.index;
    });
    return rows.map((row) => row.item);
  }

  private newThisWeek(): number {
    const since = Date.now() - NEW_WINDOW_MS;
    let count = 0;
    for (let i = 0; i < this.gridList.length; i++) {
      if (this.itemMeta(this.gridList[i]).addedAt >= since) count++;
    }
    return count;
  }

  protected findItem(id: string): I | null {
    for (let i = 0; i < this.gridList.length; i++) {
      if (this.itemId(this.gridList[i]) === id) return this.gridList[i];
    }
    return null;
  }

  // --- focus ---

  // The featured card follows the focused poster.
  private onFocusChanged(el: HTMLElement | null): void {
    if (this.mode !== 'browse') return;
    const search = this.container.querySelector<HTMLElement>('.catalog-search');
    if (search) search.classList.toggle('has-focus', el?.dataset.catalogAction === 'search');
    if (!el) return;
    const cell = el.closest<HTMLElement>('[data-grid-index]');
    if (!cell || cell.dataset.gridIndex === undefined) return;
    this.gridFocusIndex = parseInt(cell.dataset.gridIndex, 10);
    const item = this.gridList[this.gridFocusIndex] ?? null;
    if (item === this.featured) return;
    this.featured = item;
    const slot = this.container.querySelector<HTMLElement>('.catalog-feature-slot');
    if (slot) morph(slot, this.featureCard());
  }

  private zoneOf(el: HTMLElement | null): 'home' | 'search' | 'category' | 'feature' | 'sort' | 'grid' | null {
    if (!el) return null;
    const action = el.dataset.catalogAction;
    if (action === 'home' || action === 'search' || action === 'category' || action === 'sort') return action;
    if (action === 'watch' || action === 'details' || action === 'favorite') return 'feature';
    return el.closest('[data-grid-index]') ? 'grid' : null;
  }

  private focusBy(selector: string): boolean {
    const el = this.container.querySelector<HTMLElement>(selector);
    if (!el) return false;
    this.nav.focus(el);
    return true;
  }

  private focusFeature(action = 'watch'): boolean {
    return this.focusBy(`[data-catalog-action="${action}"]`) || this.focusBy('[data-catalog-action="watch"]');
  }

  private focusGrid(): boolean {
    if (!this.gridList.length) return false;
    const view = this.container.querySelector<HTMLElement>('.catalog-grid');
    const scrolled = this.gridVirtualizer.ensureVisible(
      this.gridFocusIndex,
      this.gridViewportWidth(),
      view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT,
    );
    if (scrolled || !this.container.querySelector(`[data-grid-index="${this.gridFocusIndex}"]`)) {
      this.renderBrowse(false);
    }
    return this.focusBy(`[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`);
  }

  private focusCategory(id: string): boolean {
    const list = this.sideCategories();
    let index = -1;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) index = i;
    if (index === -1) index = list.length ? 0 : -1;
    if (index === -1) return false;
    return this.focusCategoryIndex(index);
  }

  private focusCategoryIndex(index: number): boolean {
    const view = this.container.querySelector<HTMLElement>('.catalog-cats');
    const scrolled = this.categoryVirtualizer.ensureVisible(index, view?.clientHeight || CATEGORY_VIEWPORT);
    if (scrolled || !this.container.querySelector(`[data-category-index="${index}"]`)) {
      this.renderBrowse(false);
    }
    return this.focusBy(`[data-category-index="${index}"] [data-focusable]`);
  }

  private focusSide(): void {
    if (!this.focusCategory(this.activeCategoryId)) this.focusBy('[data-catalog-action="home"]');
  }

  private focusInitial(): void {
    if (this.focusGrid()) return;
    if (this.focusCategory(this.activeCategoryId)) return;
    this.focusBy('[data-catalog-action="home"]');
  }

  private moveFromSearch(direction: Direction): void {
    if (direction === 'up') { this.focusBy('[data-catalog-action="home"]'); return; }
    if (direction === 'down') {
      if (!this.focusCategoryIndex(0)) this.focusGrid();
      return;
    }
    if (direction === 'right') {
      if (!this.focusGrid()) this.focusFeature();
    }
  }

  // Explicit routes between the zones: the lists are virtualized, so geometry
  // alone cannot see the row that is not rendered yet.
  private moveBrowse(direction: Direction): void {
    const zone = this.zoneOf(this.nav.focused);
    if (zone === null) { this.focusInitial(); return; }
    if (zone === 'home') {
      if (direction === 'up') this.handlers.onRevealTabBar();
      else if (direction === 'down') this.focusBy('[data-catalog-action="search"]');
      else if (direction === 'right') { if (!this.focusFeature()) this.focusGrid(); }
      return;
    }
    if (zone === 'search') { this.moveFromSearch(direction); return; }
    if (zone === 'category') {
      const cell = this.nav.focused!.closest<HTMLElement>('[data-category-index]');
      const index = parseInt(cell?.dataset.categoryIndex ?? '0', 10);
      const total = this.sideCategories().length;
      if (direction === 'up') {
        if (index === 0) this.focusBy('[data-catalog-action="search"]');
        else this.focusCategoryIndex(index - 1);
      } else if (direction === 'down') {
        if (index < total - 1) this.focusCategoryIndex(index + 1);
      } else if (direction === 'right') {
        if (!this.focusGrid()) this.focusFeature();
      }
      return;
    }
    if (zone === 'feature') {
      if (direction === 'up') this.handlers.onRevealTabBar();
      else if (direction === 'down') { if (!this.focusGrid()) this.focusBy('[data-catalog-action="sort"]'); }
      else {
        const order = ['watch', 'details', 'favorite'];
        const step = order.indexOf(this.nav.focused!.dataset.catalogAction ?? '') + (direction === 'left' ? -1 : 1);
        if (step >= 0 && step < order.length) this.focusFeature(order[step]);
        else if (direction === 'left') this.focusSide();
        else this.focusBy('[data-catalog-action="sort"]');
      }
      return;
    }
    if (zone === 'sort') {
      if (direction === 'up' || direction === 'left') { if (!this.focusFeature()) this.handlers.onRevealTabBar(); }
      else if (direction === 'down') this.focusGrid();
      return;
    }
    this.moveGridFocus(direction);
  }

  private moveGridFocus(direction: Direction): void {
    const width = this.gridViewportWidth();
    const total = this.gridList.length;
    let next = this.gridVirtualizer.getAdjacentIndex(this.gridFocusIndex, direction, total, width);
    if (direction === 'down' && next === this.gridFocusIndex) {
      // A short last row has no poster straight below: take its last one.
      const columns = this.gridVirtualizer.getColumnCount(width);
      if (Math.floor(this.gridFocusIndex / columns) < Math.floor((total - 1) / columns)) next = total - 1;
    }
    if (next === this.gridFocusIndex || next < 0) {
      if (direction === 'left') {
        this.focusSide();
      } else if (direction === 'up') {
        const columns = this.gridVirtualizer.getColumnCount(width);
        const lastColumn = this.gridFocusIndex % columns === columns - 1;
        if (lastColumn && this.focusBy('[data-catalog-action="sort"]')) return;
        if (!this.focusFeature()) this.handlers.onRevealTabBar();
      }
      return;
    }
    this.gridFocusIndex = next;
    const view = this.container.querySelector<HTMLElement>('.catalog-grid');
    const viewportHeight = view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    // renderBrowse() re-reads the live scroll position before it measures, so
    // do the same here or the comparison below runs against a stale offset.
    const offsetBefore = this.gridVirtualizer.scrollOffset;
    if (view) this.gridVirtualizer.setScrollOffset(view.scrollTop);
    const scrolled = this.gridVirtualizer.ensureVisible(next, width, viewportHeight);
    if (!scrolled && this.gridVirtualizer.scrollOffset === offsetBefore && this.gridScrollFrame === null) {
      if (this.focusBy(`[data-grid-index="${next}"] [data-focusable]`)) return;
    }
    this.renderBrowse(false);
    this.focusBy(`[data-grid-index="${next}"] [data-focusable]`);
  }

  private gridViewportWidth(): number {
    return this.container.querySelector<HTMLElement>('.catalog-grid-track')?.clientWidth
      || CATALOG_GRID_VIEWPORT_WIDTH;
  }

  // --- rendering ---

  protected posterCell(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  private ratingBadge(rating: string): Safe | '' {
    const text = ratingText(rating);
    return text ? html`<span class="catalog-badge"><span class="catalog-star">${raw(STAR_ICON)}</span>${text}</span>` : '';
  }

  private tile(item: I): Safe {
    const id = this.itemId(item);
    const meta = this.itemMeta(item);
    const name = this.itemName(item);
    return html`
      <div class="catalog-tile" data-focusable data-key="i:${id}" data-item-id="${id}">
        <div class="catalog-tile-year">${meta.year > 0 ? String(meta.year) : ' '}</div>
        <div class="catalog-poster-wrap">
          <div class="catalog-poster-initial">${name.charAt(0)}</div>
          ${this.posterCell(name, this.itemPoster(item))}
          ${this.ratingBadge(meta.rating)}
          <span class="catalog-tile-play">${raw(PLAY_ICON)}</span>
        </div>
        <div class="catalog-tile-name">${name}</div>
      </div>
    `;
  }

  private featureCard(): Safe {
    const item = this.featured;
    if (!item) {
      return html`
        <section class="catalog-feature catalog-feature-empty" data-key="feature">
          <div class="catalog-feature-eyebrow"><span class="catalog-dot"></span>${this.kicker}</div>
        </section>`;
    }
    const meta = this.itemMeta(item);
    const rating = ratingText(meta.rating);
    const favorite = this.isFavorite(item);
    const name = this.itemName(item);
    return html`
      <section class="catalog-feature" data-key="feature">
        <div class="catalog-feature-head">
          <div class="catalog-feature-eyebrow">
            <span class="catalog-dot"></span><span>${t('catalog.featured')}</span><span class="catalog-rule"></span>
          </div>
          <h1 class="catalog-feature-title">${name}</h1>
          <div class="catalog-feature-meta">
            ${rating ? html`<span class="catalog-feature-rating"><span class="catalog-star">${raw(STAR_ICON)}</span>${rating}</span>` : ''}
            ${rating && meta.year > 0 ? html`<span class="catalog-feature-sep">·</span>` : ''}
            ${meta.year > 0 ? html`<span class="catalog-feature-year">${String(meta.year)}</span>` : ''}
          </div>
        </div>
        <div class="catalog-feature-actions" data-nav-container>
          <button class="catalog-pill catalog-pill-primary" data-focusable data-key="watch" data-catalog-action="watch">
            <span class="catalog-pill-icon">${raw(PLAY_ICON)}</span><span>${t('catalog.watch')}</span>
          </button>
          <button class="catalog-pill" data-focusable data-key="details" data-catalog-action="details">
            <span class="catalog-pill-icon">${raw(INFO_ICON)}</span><span>${t('catalog.details')}</span>
          </button>
          <button class="catalog-pill ${favorite ? 'is-favorite' : ''}" data-focusable data-key="favorite"
                  data-catalog-action="favorite">
            <span class="catalog-pill-icon">${raw(favoriteIcon(favorite))}</span>
            <span>${t(favorite ? 'catalog.favorited' : 'catalog.favorite')}</span>
          </button>
        </div>
        <div class="catalog-feature-poster" data-key="feature-poster:${this.itemId(item)}">
          <div class="catalog-poster-initial">${name.charAt(0)}</div>
          ${this.posterCell(name, this.itemPoster(item))}
          ${this.ratingBadge(meta.rating)}
        </div>
      </section>`;
  }

  private renderLoading(): void {
    morph(this.container, html`
      <div class="catalog-view catalog-loading" data-nav-container>
        <p class="catalog-hint">${t('common.loading')}</p>
      </div>
    `);
  }

  protected renderBrowse(restoreFocus = true): void {
    this.mode = 'browse';
    const focusedKey = this.nav.focused?.dataset.key ?? '';
    const side = this.sideCategories();
    const hasContent = this.categories.length > 0
      || this.continueItems().length > 0 || this.favoriteItems().length > 0;
    if (!hasContent) {
      morph(this.container, html`
        <div class="catalog-view catalog-browse" data-nav-container>
          <p class="catalog-hint catalog-empty">${this.emptyMessage}</p>
        </div>
      `);
      this.nav.clearDetachedFocus();
      return;
    }

    const cats = this.container.querySelector<HTMLElement>('.catalog-cats');
    const catRange = this.categoryVirtualizer.getRange(side.length, cats?.clientHeight || CATEGORY_VIEWPORT);

    const view = this.container.querySelector<HTMLElement>('.catalog-grid');
    const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
    const width = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const height = view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    const items = this.gridList;
    const range = this.gridVirtualizer.getRange(items.length, width, height);
    const fresh = this.query ? 0 : this.newThisWeek();
    const skeleton = this.loadingCategory;

    morph(this.container, html`
      <div class="catalog-view catalog-browse">
        <aside class="catalog-side">
          <button class="catalog-side-pill catalog-home" data-focusable data-key="home" data-catalog-action="home">
            <span class="catalog-home-chevron">${raw(CHEVRON_LEFT_ICON)}</span>
            <span class="catalog-home-label">${t('catalog.backHome')}</span>
            <span class="catalog-home-hint">OK</span>
          </button>
          <label class="catalog-side-pill catalog-search ${focusedKey === 'search-input' ? 'has-focus' : ''}" data-key="search">
            <span class="catalog-search-icon">${raw(SEARCH_ICON)}</span>
            <input class="catalog-search-input" data-focusable data-key="search-input" data-catalog-action="search"
                   type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
                   placeholder="${this.searchPlaceholder}">
          </label>
          <div class="catalog-cats" data-key="cats">
            <div class="catalog-cats-track" style="height:${this.categoryVirtualizer.getTotalSize(side.length)}px">
              ${side.slice(catRange.start, catRange.end).map((category, offset) => {
                const index = catRange.start + offset;
                const active = !this.query && category.id === this.activeCategoryId;
                return html`
                  <div class="catalog-cat-cell" data-key="cat-cell:${category.id}" data-category-index="${index}"
                       style="top:${this.categoryVirtualizer.getItemOffset(index)}px">
                    <button class="catalog-cat ${active ? 'is-active' : ''}" data-focusable
                            data-key="c:${category.id}" data-catalog-action="category"
                            data-category-id="${category.id}">
                      <span class="catalog-cat-dot"></span>
                      <span class="catalog-cat-name">${category.name}</span>
                      <span class="catalog-cat-count">${category.count === null ? '' : String(category.count)}</span>
                    </button>
                  </div>`;
              })}
            </div>
          </div>
        </aside>
        <div class="catalog-main">
          <div class="catalog-feature-slot" data-key="feature-slot">${this.featureCard()}</div>
          <header class="catalog-head" data-key="head">
            <h2 class="catalog-head-name">${this.activeCategoryName()}</h2>
            <span class="catalog-head-count">${skeleton ? '' : tp('catalog.titleCount', items.length)}</span>
            ${fresh > 0 ? html`
              <span class="catalog-head-divider"></span>
              <span class="catalog-head-count">${t('catalog.thisWeek')}</span>
              <span class="catalog-head-new">${t('catalog.newCount', { count: fresh })}</span>` : ''}
            <button class="catalog-sort" data-focusable data-key="sort" data-catalog-action="sort">
              <span class="catalog-sort-icon">${raw(FILTER_ICON)}</span>
              <span>${t(`catalog.sort.${this.sortMode}`)}</span>
            </button>
          </header>
          <div class="catalog-grid" data-key="grid">
            ${skeleton
              ? html`<div class="catalog-skeleton" data-key="skeleton">${
                  [0, 1, 2, 3, 4].map((n) => html`<div class="catalog-skeleton-tile" data-key="sk:${n}"></div>`)}</div>`
              : items.length === 0
                ? html`<p class="catalog-hint catalog-grid-empty" data-key="grid-empty">${
                    this.emptyGridText()}</p>`
                : html`
                  <div class="catalog-grid-track" data-key="grid-track"
                       style="height:${this.gridVirtualizer.getTotalSize(items.length, width)}px">
                    ${items.slice(range.start, range.end).map((item, offset) => {
                      const index = range.start + offset;
                      const position = this.gridVirtualizer.getItemPosition(index, range.columns);
                      return html`
                        <div class="catalog-grid-cell" data-key="grid:${this.itemId(item)}" data-grid-index="${index}"
                             style="left:${position.left}px;top:${position.top}px">
                          ${this.tile(item)}
                        </div>`;
                    })}
                  </div>`}
          </div>
        </div>
      </div>
    `);

    const catsNow = this.container.querySelector<HTMLElement>('.catalog-cats');
    if (catsNow) this.scrollGuard.syncOffset(catsNow, 'vertical', this.categoryVirtualizer.scrollOffset);
    const viewNow = this.container.querySelector<HTMLElement>('.catalog-grid');
    if (viewNow) this.scrollGuard.syncOffset(viewNow, 'vertical', this.gridVirtualizer.scrollOffset);

    // morph rewrites the class attribute, which drops the focus ring SpatialNav put there.
    const again = focusedKey
      ? this.container.querySelector<HTMLElement>(`[data-key="${focusedKey}"][data-focusable]`)
      : null;
    if (again) this.nav.focus(again);
    else if (restoreFocus) this.focusInitial();
    else this.nav.clearDetachedFocus();
  }

  private emptyGridText(): string {
    if (this.query) return t('catalog.noResults');
    if (this.activeCategoryId === FAVORITES_CATEGORY_ID) return t('catalog.noFavorites');
    if (this.activeCategoryId === CONTINUE_CATEGORY_ID) return t('catalog.noContinue');
    return this.gridEmptyMessage;
  }

  private scheduleGridSnap(view: HTMLElement): void {
    if (this.gridSnapTimer !== null) clearTimeout(this.gridSnapTimer);
    this.gridSnapTimer = setTimeout(() => {
      this.gridSnapTimer = null;
      if (this.mode !== 'browse') return;
      const width = this.gridViewportWidth();
      const viewportHeight = view.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
      const maxOffset = Math.max(
        0,
        this.gridVirtualizer.getTotalSize(this.gridList.length, width) - viewportHeight,
      );
      const snapped = Math.min(
        maxOffset,
        Math.round(this.gridVirtualizer.scrollOffset / CATALOG_GRID_ROW_STRIDE)
          * CATALOG_GRID_ROW_STRIDE,
      );
      if (snapped === this.gridVirtualizer.scrollOffset) return;
      this.gridVirtualizer.setScrollOffset(snapped);
      this.renderBrowse(false);
    }, GRID_SNAP_DELAY_MS);
  }
}
