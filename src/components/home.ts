import type { Action } from '../types';
import { CONFIG } from '../config';
import { SpatialNav } from '../navigation/spatial-nav';
import { ActivationService } from '../services/xsol/activation-service';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { getLocale, t, type TextMessageKey } from '../i18n';
import { formatClock } from '../utils/time';
import {
  ACCESS_ICON,
  ARROW_RIGHT_ICON,
  FILM_ICON,
  PLAY_ICON,
  SERIES_ICON,
  SETTINGS_ICON,
  TV_PLAY_ICON,
} from './icons';

export type HomeSection = 'live' | 'movies' | 'series' | 'access' | 'settings';

export interface HomeChannel {
  index: number;
  name: string;
  group: string;
  logo: string;
}

export interface HomeData {
  lastWatched: HomeChannel | null;
  featured: HomeChannel[];
  hasXtream: boolean;
}

interface HomeHandlers {
  getData: () => HomeData;
  /** IPTV account expiry in unix seconds, null for "never", undefined when unknown. */
  loadUserExpiry: () => Promise<number | null | undefined>;
  onResume: (index: number) => void;
  onPlayChannel: (index: number) => void;
  onAllChannels: () => void;
  onSection: (section: HomeSection) => void;
  onRevealTabBar: () => boolean;
  /** Tune the channel playing in the card; false when the card has no preview running. */
  onTuneChannel: (delta: 1 | -1) => boolean;
  onBack: () => void;
}

const CLOCK_REFRESH_MS = 20 * 1000;

const SECTION_CARDS: ReadonlyArray<{ id: HomeSection; titleKey: TextMessageKey; icon: string }> = [
  { id: 'live', titleKey: 'home.card.live', icon: TV_PLAY_ICON },
  { id: 'movies', titleKey: 'nav.movies', icon: FILM_ICON },
  { id: 'series', titleKey: 'nav.series', icon: SERIES_ICON },
  { id: 'access', titleKey: 'nav.access', icon: ACCESS_ICON },
  { id: 'settings', titleKey: 'nav.settings', icon: SETTINGS_ICON },
];

function localized(date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    return date.toLocaleDateString(getLocale(), options);
  } catch {
    return date.toLocaleDateString();
  }
}

function greetingKey(hour: number): TextMessageKey {
  if (hour < 12) return 'home.greeting.morning';
  if (hour < 18) return 'home.greeting.afternoon';
  return 'home.greeting.evening';
}

// The panel sends either "YYYY-MM-DD HH:MM:SS" or an ISO timestamp.
function panelDate(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value.indexOf('T') === -1 ? value.replace(' ', 'T') : value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function shortDate(date: Date): string {
  return localized(date, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/**
 * The home screen: greeting, the last channel watched, the five sections, a few
 * channels to jump straight into, and the account's two dates.
 */
export class Home {
  private nav: SpatialNav;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private opened = false;
  private userExpiry: number | null | undefined = undefined;
  private requestId = 0;

  constructor(
    private container: HTMLElement,
    private handlers: HomeHandlers,
  ) {
    this.nav = new SpatialNav(container);
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control);
      this.activate(control);
    });
    // A channel logo that fails to load leaves the initial underneath it showing.
    this.container.addEventListener('error', (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && target.classList.contains('home-channel-logo')) {
        target.style.display = 'none';
      }
    }, true);
  }

  open(): void {
    if (!this.opened) {
      this.opened = true;
      this.unsubscribe = ActivationService.subscribe(() => this.render());
      this.timer = setInterval(() => this.render(), CLOCK_REFRESH_MS);
    }
    this.render();
    this.focusInitial();
    void this.loadAsyncData();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.requestId++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-read the data behind the screen (a playlist finished loading, the list changed). */
  refresh(): void {
    if (!this.opened) return;
    this.render();
    void this.loadAsyncData();
  }

  handleAction(action: Action): void {
    if (action === 'back') {
      this.handlers.onBack();
    } else if (action === 'select' && this.nav.focused) {
      this.activate(this.nav.focused);
    } else if (action === 'up') {
      if (!this.nav.move('up')) this.handlers.onRevealTabBar();
    } else if (action === 'down' || action === 'left' || action === 'right') {
      this.nav.move(action);
    } else if (action === 'channel_up' || action === 'channel_down') {
      if (this.handlers.onTuneChannel(action === 'channel_up' ? 1 : -1)) return;
      this.step(action === 'channel_up' ? -1 : 1);
    }
  }

  // With no preview to tune, CH+/CH- walk the controls in reading order instead.
  private step(delta: number): void {
    const controls = Array.from(this.container.querySelectorAll<HTMLElement>('[data-focusable]'));
    const at = this.nav.focused ? controls.indexOf(this.nav.focused) : -1;
    if (at < 0) { this.focusInitial(); return; }
    const next = controls[Math.max(0, Math.min(controls.length - 1, at + delta))];
    if (next !== this.nav.focused) this.nav.focus(next);
  }

  private async loadAsyncData(): Promise<void> {
    const request = ++this.requestId;
    const expiry = await this.handlers.loadUserExpiry().catch((): undefined => undefined);
    if (request !== this.requestId || !this.opened) return;
    this.userExpiry = expiry;
    this.render();
  }

  private activate(control: HTMLElement): void {
    const action = control.dataset.homeAction ?? '';
    const index = parseInt(control.dataset.channelIndex ?? '', 10);
    if (action === 'resume' && index >= 0) this.handlers.onResume(index);
    else if (action === 'channel' && index >= 0) this.handlers.onPlayChannel(index);
    else if (action === 'all') this.handlers.onAllChannels();
    else if (action === 'section') this.handlers.onSection(control.dataset.section as HomeSection);
  }

  private focusInitial(): void {
    const first = this.container.querySelector<HTMLElement>('[data-home-action="resume"]')
      ?? this.container.querySelector<HTMLElement>('[data-home-action="section"]');
    if (first) this.nav.focus(first);
  }

  private focusKey(): string {
    return this.nav.focused?.dataset.key ?? '';
  }

  // Movies and Series only exist behind an Xtream account; say so instead of
  // opening an empty catalogue.
  private sectionNote(id: HomeSection, data: HomeData): string {
    return (id === 'movies' || id === 'series') && !data.hasXtream ? t('home.needsAccount') : '';
  }

  private avatar(channel: HomeChannel): Safe {
    const initial = (channel.name.trim().charAt(0) || '?').toUpperCase();
    return html`
      <span class="home-channel-avatar">
        <span class="home-channel-initial">${initial}</span>
        ${channel.logo
          ? html`<img class="home-channel-logo" alt="" src="${channel.logo}">`
          : ''}
      </span>`;
  }

  private activationDate(): string {
    const snapshot = ActivationService.snapshot;
    if (snapshot.lifetime) return t('home.noExpiry');
    const date = panelDate(snapshot.expiryDate);
    return date ? shortDate(date) : '—';
  }

  private userExpiryDate(): string {
    if (this.userExpiry === undefined) return '—';
    if (this.userExpiry === null) return t('home.noExpiry');
    return shortDate(new Date(this.userExpiry * 1000));
  }

  private render(): void {
    if (!this.opened) return;
    const data = this.handlers.getData();
    const now = new Date();
    const focusedKey = this.focusKey();
    const last = data.lastWatched;
    const longDate = localized(now, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    morph(this.container, html`
      <div class="home-view">
        <div class="home-hero" data-key="hero">
          <div class="home-welcome" data-key="welcome">
            <div class="home-eyebrow home-eyebrow--accent">
              <span class="home-eyebrow-dot"></span>
              <span>${t('home.welcome')}</span>
              <span class="home-eyebrow-line"></span>
            </div>
            <h1 class="home-greeting" id="home-greeting">${t(greetingKey(now.getHours()))}</h1>
            <div class="home-date">
              <span class="home-date-long">${longDate.charAt(0).toUpperCase() + longDate.slice(1)}</span>
              <span class="home-date-dot"></span>
              <span class="home-date-time">${formatClock(now.getHours(), now.getMinutes())}</span>
            </div>
          </div>
          <section class="home-last" data-key="last">
            <div class="home-last-video" data-key="last-video" aria-hidden="true"></div>
            <div class="home-eyebrow home-last-eyebrow">
              <span class="home-eyebrow-dot"></span>
              <span>${t('home.lastWatched')}</span>
              <span class="home-eyebrow-line"></span>
            </div>
            <div class="home-last-body">
              ${last ? html`
                <div class="home-last-group" data-key="last-group">${last.group}</div>
                <div class="home-last-name" id="home-last-name" data-key="last-name">${last.name}</div>
                ${last.group ? html`<div class="home-last-tag" data-key="last-tag">${last.group}</div>` : ''}
              ` : html`
                <div class="home-last-name home-last-name--empty" id="home-last-name"
                     data-key="last-name">${t('home.nothingWatched')}</div>
              `}
              <div class="home-last-progress" data-key="last-progress"><div></div></div>
              <div class="home-last-actions" data-key="last-actions">
                ${last ? html`
                  <button class="home-button home-button--primary" data-focusable data-key="resume"
                          data-home-action="resume" data-channel-index="${last.index}">
                    <span class="home-button-icon">${raw(PLAY_ICON)}</span>
                    <span>${t('home.resume')}</span>
                  </button>` : ''}
                <button class="home-button home-button--secondary" data-focusable data-key="all"
                        data-home-action="all">
                  <span>${t('home.allChannels')}</span>
                  <span class="home-button-icon">${raw(ARROW_RIGHT_ICON)}</span>
                </button>
              </div>
            </div>
          </section>
        </div>

        <div class="home-block" data-key="sections">
          <div class="home-block-header">
            <h2>${t('home.sections')}</h2>
          </div>
          <div class="home-cards" data-nav-container>
            ${SECTION_CARDS.map((card) => {
              const note = this.sectionNote(card.id, data);
              return html`
                <button class="home-card" data-focusable data-key="section:${card.id}"
                        data-home-action="section" data-section="${card.id}">
                  <span class="home-card-icon">${raw(card.icon)}</span>
                  <span class="home-card-text">
                    <span class="home-card-title">${t(card.titleKey)}</span>
                    <span class="home-card-note" data-note-for="${card.id}">${note}</span>
                  </span>
                </button>`;
            })}
          </div>
        </div>

        ${data.featured.length ? html`
          <div class="home-block" data-key="on-air">
            <div class="home-block-header">
              <h2>${t('home.onAir')}</h2>
              <span class="home-block-meta">${t('home.featured', { count: data.featured.length })}</span>
            </div>
            <div class="home-channels" data-nav-container>
              ${data.featured.map(channel => html`
                <button class="home-channel" data-focusable data-key="channel:${channel.index}"
                        data-home-action="channel" data-channel-index="${channel.index}">
                  ${this.avatar(channel)}
                  <span class="home-channel-text">
                    <span class="home-channel-name">${channel.name}</span>
                    <span class="home-channel-group">${channel.group}</span>
                  </span>
                </button>`)}
            </div>
          </div>` : ''}

        <footer class="home-footer" data-key="footer">
          <div class="home-footer-dates">
            <span class="home-footer-label">${t('home.activation')}</span>
            <span class="home-footer-value" id="home-activation">${this.activationDate()}</span>
            <span class="home-footer-dot"></span>
            <span class="home-footer-label">${t('home.userExpiry')}</span>
            <span class="home-footer-value home-footer-value--accent" id="home-user-expiry">${this.userExpiryDate()}</span>
          </div>
          <span class="home-footer-version">${CONFIG.APP_NAME} - V ${CONFIG.VERSION}</span>
        </footer>
      </div>
    `);

    // morph rewrites the class attribute, which drops the focus ring SpatialNav put there.
    if (focusedKey) {
      const again = this.container.querySelector<HTMLElement>(`[data-key="${focusedKey}"][data-focusable]`);
      if (again) this.nav.focus(again);
      else this.focusInitial();
    }
  }
}
