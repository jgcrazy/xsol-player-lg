import type { Action, PlaylistEntry } from '../types';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { CONFIG } from '../config';
import {
  FILM_ICON,
  HOME_ICON,
  SEARCH_ICON,
  SERIES_ICON,
  SETTINGS_ICON,
  TV_ICON,
} from './icons';
import { AccountSwitcher } from './account-switcher';
import { getLocale, t } from '../i18n';
import { formatClock } from '../utils/time';

// Cap for the expanded inline search box.
export const SEARCH_INPUT_MAX_WIDTH = 600;

// The single source of truth for the sections: order, label, the view each maps
// to, whether it needs an Xtream account, and whether it has its own item in the
// bar. Sections without one (the guide, the Access screen) still dock the bar
// and light up the item they are reached from.
export const SECTIONS = [
  { id: 'home', labelKey: 'nav.home', view: 'home', xtreamOnly: false, inBar: true, icon: HOME_ICON },
  { id: 'live', labelKey: 'nav.live', view: 'channels', xtreamOnly: false, inBar: true, icon: TV_ICON },
  { id: 'epg', labelKey: 'nav.epg', view: 'epg', xtreamOnly: false, inBar: false, icon: '' },
  { id: 'movies', labelKey: 'nav.movies', view: 'movies', xtreamOnly: true, inBar: true, icon: FILM_ICON },
  { id: 'series', labelKey: 'nav.series', view: 'series', xtreamOnly: true, inBar: true, icon: SERIES_ICON },
  { id: 'access', labelKey: 'nav.access', view: 'access', xtreamOnly: false, inBar: false, icon: '' },
  { id: 'settings', labelKey: 'nav.settings', view: 'settings', xtreamOnly: false, inBar: true, icon: SETTINGS_ICON },
  { id: 'search', labelKey: 'nav.search', view: 'search', xtreamOnly: false, inBar: true, icon: '' },
] as const;

export type Section = typeof SECTIONS[number]['id'];
type SectionDef = typeof SECTIONS[number];

// Xtream accounts get the full set; M3U-only accounts have no VOD/series catalog,
// so Movies and Series are left out.
const FULL_SECTIONS: readonly SectionDef[] = SECTIONS.filter((s) => s.inBar);
const LITE_SECTIONS: readonly SectionDef[] = FULL_SECTIONS.filter((s) => !s.xtreamOnly);

// The bar item a section without its own item belongs under.
const PARENT: Partial<Record<Section, Section>> = { epg: 'live', access: 'home' };

function barItemFor(section: Section): Section {
  return PARENT[section] ?? section;
}

// The section a view belongs to (null for the chromeless player / loading
// views, which own no tab).
export function sectionForView(view: string): Section | null {
  // The Settings card screen and the option panes behind it are one section.
  if (view === 'prefs') return 'settings';
  return SECTIONS.find((s) => s.view === view)?.id ?? null;
}

interface TabBarHandlers {
  onSwitch: (section: Section) => void;
  onEnter: (section: Section) => void;
  // The search query changed (typed / cleared); the host shows the results view
  // over the current one only while the query is non-empty.
  onSearchQuery: (query: string) => void;
  // Enter / Down in the search box: hand focus to the results below.
  onSearchLeave: () => void;
  // The search box was closed (Back / Escape / toggle): restore the view the
  // search was opened from.
  onSearchClose: () => void;
  // A different Xtream account was chosen in the avatar dropdown.
  onSelectAccount: (accountId: string) => void;
}

const CLOCK_REFRESH_MS = 20 * 1000;

// "SEX · 20 NOV": weekday and month abbreviations come from the engine, minus
// the trailing dot some locales add.
function shortDate(now: Date): string {
  const part = (options: Intl.DateTimeFormatOptions): string => {
    try {
      return now.toLocaleDateString(getLocale(), options).replace(/\./g, '').trim();
    } catch {
      return '';
    }
  };
  const weekday = part({ weekday: 'short' });
  const month = part({ month: 'short' });
  return `${weekday} · ${now.getDate()} ${month}`.trim();
}

// Persistent, docked top section bar (hidden on the full-screen player).
// Content owns focus by default; D-pad Up moves focus onto the active item,
// Left/Right switch section live, Down/Select/Back drop focus back into the
// content. The Search item expands an inline input instead of switching.
export class TabBar {
  private el: HTMLElement | null = null;
  private handlers: TabBarHandlers;
  private sections: readonly SectionDef[] = FULL_SECTIONS;
  private hasXtream = true;
  private _shown = false;   // docked & visible on the current view
  private _focused = false; // holds input focus (ring + key capture)
  private active: Section = 'live';
  private focusIndex = 0;
  private searchExpanded = false;
  private searchBound = false;
  private switcher: AccountSwitcher | null = null;
  private accounts: PlaylistEntry[] = [];
  private selectedAccountId = '';
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor(handlers: TabBarHandlers) {
    this.handlers = handlers;
  }

  get focused(): boolean { return this._focused; }
  get shown(): boolean { return this._shown; }
  // True while the inline search box is expanded (it overlays other views but
  // keeps Search active, so the host shouldn't re-sync the active tab then).
  get searchOpen(): boolean { return this.searchExpanded; }

  refresh(): void { this.render(); }

  private get accountShown(): boolean { return this.accounts.length > 0; }
  // Focus targets = the sections, plus the account avatar when present.
  private ringLength(): number { return this.sections.length + (this.accountShown ? 1 : 0); }
  private onAccount(): boolean { return this.accountShown && this.focusIndex === this.sections.length; }
  private activeIndex(): number {
    const item = barItemFor(this.active);
    return Math.max(0, this.sections.findIndex((s) => s.id === item));
  }

  setSections(hasXtream: boolean): void {
    this.hasXtream = hasXtream;
    this.sections = hasXtream ? FULL_SECTIONS : LITE_SECTIONS;
    if (!this.sections.some((s) => s.id === barItemFor(this.active))) this.active = 'live';
    this.focusIndex = this.activeIndex();
    if (this._shown) this.render();
  }

  setAccounts(accounts: PlaylistEntry[], selectedId: string): void {
    this.accounts = accounts;
    this.selectedAccountId = selectedId;
    // If the avatar just disappeared while focused on it, park focus on the active tab.
    if (!this.accountShown && this.focusIndex >= this.sections.length) {
      this.focusIndex = this.activeIndex();
    }
    this.switcher?.setAccounts(accounts, selectedId);
    if (this._shown) this.render();
  }

  setShown(v: boolean): void {
    this._shown = v;
    if (!v) {
      this._focused = false;
      this.switcher?.closeMenu();
      if (this.searchExpanded) { this.searchExpanded = false; this.resetSearchInput(); }
    }
    document.body.classList.toggle('tabbar-docked', v);
    if (v) { this.ensureEl(); this.render(); }
    this.el?.classList.toggle('tab-bar--hidden', !v);
    this.syncClockTimer();
  }

  setActive(section: Section): void {
    if (section !== 'search' && this.searchExpanded) { this.searchExpanded = false; this.resetSearchInput(); }
    this.active = section;
    this.focusIndex = this.activeIndex();
    if (this._shown) this.render();
  }

  // The clock only needs minute precision; a slow tick while docked is enough.
  private syncClockTimer(): void {
    if (this._shown && this.clockTimer === null) {
      this.clockTimer = setInterval(() => this.renderClock(), CLOCK_REFRESH_MS);
    } else if (!this._shown && this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private renderClock(): void {
    const time = this.el?.querySelector<HTMLElement>('.tab-bar-time');
    const date = this.el?.querySelector<HTMLElement>('.tab-bar-date');
    if (!time || !date) return;
    const now = new Date();
    time.textContent = formatClock(now.getHours(), now.getMinutes());
    date.textContent = shortDate(now);
  }

  // Collapse the inline box's DOM back to width 0 when search is left via a route
  // other than collapseSearch() (switching section, hiding the bar), so the next
  // expand animates from 0 again instead of popping open.
  private resetSearchInput(): void {
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) { input.style.width = ''; input.value = ''; input.blur(); }
  }

  // Move input focus onto the bar (D-pad Up from a view's top row).
  focus(): void {
    if (!this._shown) return;
    this._focused = true;
    this.focusIndex = this.activeIndex();
    this.render();
    if (this.active === 'search' && this.searchExpanded) {
      this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.focus();
    }
  }

  private dropFocus(): void {
    this._focused = false;
    this.render();
  }

  // Give up input focus from outside (e.g. the host navigated into content via
  // the pointer, which doesn't route through the bar). Without this, a stale
  // `_focused` makes handleKey route later input into the bar and swallow it.
  blur(): void {
    if (this._focused) this.dropFocus();
  }

  init(): void {
    // Enter a tab (or expand search) by hit-testing the item under the pointer.
    document.addEventListener('click', (e: MouseEvent) => {
      if (!this._shown) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const item = hit?.closest<HTMLElement>('.tab-bar-item');
      if (!item || !item.dataset.section) return;
      const section = item.dataset.section as Section;
      if (section === 'search') {
        // Toggle: a second click on the magnifier slides the box back in.
        if (this.searchExpanded) this.collapseSearch();
        else this.expandSearch();
        return;
      }
      this.active = section;
      this.focusIndex = this.activeIndex();
      this.dropFocus();
      this.handlers.onEnter(section);
    });
  }

  handleAction(action: Action): void {
    if (!this._focused) return;
    if (this.switcher?.menuOpen) {
      this.switcher.handleAction(action);
      return;
    }
    if (this.searchExpanded) {
      if (action === 'back') this.collapseSearch();
      return;
    }
    switch (action) {
      case 'left':
        this.focusIndex = (this.focusIndex - 1 + this.ringLength()) % this.ringLength();
        this.afterMove();
        break;
      case 'right':
        this.focusIndex = (this.focusIndex + 1) % this.ringLength();
        this.afterMove();
        break;
      case 'select':
      case 'down':
        if (this.onAccount()) {
          this.switcher?.openMenu();
          this.render();
        } else if (this.sections[this.focusIndex].id === 'search') {
          this.expandSearch();
        } else {
          this.dropFocus();
          this.handlers.onEnter(this.active);
        }
        break;
      case 'back':
        this.dropFocus();
        this.handlers.onEnter(this.active);
        break;
      case 'up':
        break; // topmost — stay on the bar
      default:
        break;
    }
  }

  // Moving onto a section switches it live; moving onto the avatar only re-renders.
  private afterMove(): void {
    if (this.onAccount()) this.render();
    else this.commitSwitch();
  }

  private commitSwitch(): void {
    this.active = this.sections[this.focusIndex].id;
    this.render();
    this.handlers.onSwitch(this.active);
  }

  // Expand the inline search box: slide it out from the magnifier toward
  // Settings and focus it. The host keeps the current view; results only appear
  // (over it) once a query is typed.
  private expandSearch(): void {
    this.active = 'search';
    this.focusIndex = this.sections.findIndex((s) => s.id === 'search');
    this.searchExpanded = true;
    this._focused = true;
    this.render();
    this.handlers.onEnter('search'); // host remembers the current view + preps results
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) {
      input.value = '';
      this.setSearchWidth(input);
      input.focus();
    }
  }

  private collapseSearch(): void {
    this.searchExpanded = false;
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) { input.value = ''; input.style.width = ''; input.blur(); }
    this._focused = true;
    this.render();
    this.handlers.onSearchClose();
  }

  // Slide the input out from the magnifier toward the Settings tab.
  private setSearchWidth(input: HTMLInputElement): void {
    const icon = this.el?.querySelector<HTMLElement>('.tab-bar-search .search-icon');
    const settings = this.el?.querySelector<HTMLElement>('.tab-bar-item[data-section="settings"]');
    if (!icon) return;
    const iconLeft = icon.getBoundingClientRect().left;
    const settingsRight = settings ? settings.getBoundingClientRect().right : (this.el!.getBoundingClientRect().left + 96);
    const gap = Math.max(160, Math.round(iconLeft - settingsRight - 24));
    input.style.width = `${Math.min(SEARCH_INPUT_MAX_WIDTH, gap)}px`;
  }

  private searchPlaceholder(): string {
    return this.hasXtream
      ? t('search.all')
      : t('search.channels');
  }

  private ensureEl(): void {
    if (this.el) return;
    this.el = document.createElement('div');
    this.el.className = 'tab-bar';
    // Self-activates on click (its own handler is the "OK" action); mark so the
    // global click handler skips this subtree (covers the account switcher slot).
    this.el.setAttribute('data-self-activate', '');
    document.body.appendChild(this.el);
  }

  private render(): void {
    if (!this.el) return;
    const searchIdx = this.sections.findIndex((s) => s.id === 'search');
    const iconFocused = this._focused && this.focusIndex === searchIdx && !this.searchExpanded;
    const activeItem = barItemFor(this.active);
    const now = new Date();
    morph(this.el, html`
      <div class="tab-bar-inner" data-nav-container>
        <div class="tab-bar-brand" data-key="brand">
          <span class="tab-bar-logo" aria-hidden="true">${CONFIG.APP_NAME.charAt(0)}</span>
          <span class="tab-bar-title">${CONFIG.APP_NAME}</span>
        </div>
        <div class="tab-bar-items" data-key="items">
          ${this.sections.filter((s) => s.id !== 'search').map((s) => {
            const i = this.sections.findIndex((x) => x.id === s.id);
            const focusedCls = this._focused && i === this.focusIndex ? 'focused' : '';
            const activeCls = s.id === activeItem ? 'active' : '';
            return html`
            <button class="tab-bar-item ${focusedCls} ${activeCls}"
                    data-key="${s.id}" data-section="${s.id}" aria-label="${t(s.labelKey)}"><span
                    class="tab-bar-icon" aria-hidden="true">${raw(s.icon)}</span><span
                    class="tab-bar-label">${t(s.labelKey)}</span></button>
          `;
          })}
        </div>
        <div class="tab-bar-search ${this.searchExpanded ? 'expanded' : ''}" data-key="search-slot" data-morph-preserve></div>
        <div class="tab-bar-account" data-key="account-slot" data-morph-preserve></div>
        <div class="tab-bar-clock" data-key="clock">
          <span class="tab-bar-time">${formatClock(now.getHours(), now.getMinutes())}</span>
          <span class="tab-bar-date">${shortDate(now)}</span>
        </div>
      </div>
    `);
    this.mountSearch(iconFocused);
    this.mountAccount();
  }

  // The search slot's children are owned here (preserved from morph): build the
  // input + magnifier once, then keep the placeholder and icon state in sync.
  private mountSearch(iconFocused: boolean): void {
    const wrap = this.el?.querySelector<HTMLElement>('.tab-bar-search');
    if (!wrap) return;
    if (!wrap.querySelector('.search-icon')) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tab-bar-search-input';
      input.setAttribute('aria-label', t('common.search'));
      const btn = document.createElement('button');
      btn.className = 'tab-bar-item search-icon';
      btn.dataset.key = 'search';
      btn.dataset.section = 'search';
      btn.setAttribute('aria-label', t('common.search'));
      btn.innerHTML = SEARCH_ICON; // trusted constant
      wrap.appendChild(input);
      wrap.appendChild(btn);
      if (!this.searchBound) { this.bindSearchInput(input); this.searchBound = true; }
    }
    const input = wrap.querySelector<HTMLInputElement>('.tab-bar-search-input')!;
    input.placeholder = this.searchPlaceholder();
    const btn = wrap.querySelector<HTMLElement>('.search-icon')!;
    btn.classList.toggle('focused', iconFocused);
    btn.classList.toggle('active', this.active === 'search');
  }

  private bindSearchInput(input: HTMLInputElement): void {
    input.addEventListener('input', () => {
      this.handlers.onSearchQuery(input.value);
    });
    // The global key handler ignores INPUT keydowns, so the box owns Enter/Down
    // (blur + hand off to the results) and Escape (collapse + clear).
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        this._focused = false;
        input.blur(); // release DOM focus so d-pad/OK reach the results view
        this.handlers.onSearchLeave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.collapseSearch();
      }
    });
  }

  // The account slot's DOM is owned by the AccountSwitcher (preserved across
  // morph). Create it once, then keep its accounts + focus state in sync.
  private mountAccount(): void {
    const slot = this.el?.querySelector<HTMLElement>('.tab-bar-account');
    if (!slot) return;
    if (!this.switcher) {
      this.switcher = new AccountSwitcher(slot, { onSelect: (id) => this.handlers.onSelectAccount(id) });
      this.switcher.init();
    }
    this.switcher.setAccounts(this.accounts, this.selectedAccountId);
    this.switcher.setFocused(this._focused && this.onAccount());
  }
}
