import type { Action } from '../types';
import { CONFIG } from '../config';
import { SpatialNav } from '../navigation/spatial-nav';
import { StorageService } from '../services/storage-service';
import { ActivationService } from '../services/xsol/activation-service';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { localeOptions, t, tp, type TextMessageKey } from '../i18n';
import { ConfirmationPrompt } from './confirmation-prompt';
import {
  APPEARANCE_ICON, BELL_ICON, CAPTIONS_ICON, CHEVRON_LEFT_ICON, CLOCK_ICON, CLOUD_ICON, DATABASE_ICON,
  GLOBE_ICON, GUIDE_ICON, PLAYBACK_ICON, REFRESH_ICON, SOURCES_ICON, TRASH_ICON,
} from './icons';

/** The detailed option panes a card can open (the classic Settings page). */
export type PreferencePane = 'sources' | 'guide' | 'appearance' | 'playback' | 'subtitles' | 'data';

export interface PreferencesHandlers {
  onBack: () => void;
  /** Up from the top row: hand focus to the tab bar. Returns false when there is none. */
  onRevealTabBar: () => boolean;
  onOpenPane: (pane: PreferencePane) => void;
  onOpenReminders: () => void;
  /** The language changed: everything already on screen has to be redrawn. */
  onLocaleChanged: () => void;
  /** The automatic refresh was switched: timers have to be rescheduled. */
  onRefreshChanged: () => void;
  /** A history was cleared: the lists built from it are stale. */
  onHistoryCleared: () => void;
  reminderCount: () => number;
}

interface Card {
  id: string;
  icon: string;
  title: TextMessageKey;
  subtitle: () => string;
  /** null = no switch; otherwise its state. */
  on?: () => boolean;
  /** Greyed out, not selectable. */
  soon?: boolean;
  run: () => void;
}

interface Group {
  title: TextMessageKey;
  cards: Card[];
}

function formatKey(key: string): string {
  return key.length === 6 ? `${key.slice(0, 3)} ${key.slice(3)}` : key;
}

/**
 * The Settings landing screen: cards in groups, each showing its current value.
 * A card flips a switch, runs an action behind a confirmation, or opens the
 * pane that holds the detailed options.
 */
export class Preferences {
  private nav: SpatialNav;
  private prompt = new ConfirmationPrompt();
  private opened = false;

  constructor(
    private container: HTMLElement,
    private handlers: PreferencesHandlers,
  ) {
    this.nav = new SpatialNav(container);
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      if (this.prompt.visible) return;
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control);
      this.activate(control);
    });
  }

  open(): void {
    this.opened = true;
    this.render();
    const first = this.container.querySelector<HTMLElement>('.prefs-card[data-focusable]');
    if (first) this.nav.focus(first);
    // Focusing the first card scrolls it into view; the title above it belongs on screen too.
    const scroll = this.container.querySelector<HTMLElement>('.prefs-scroll');
    if (scroll) {
      scroll.scrollTop = 0;
      requestAnimationFrame(() => { scroll.scrollTop = 0; });
    }
  }

  close(): void {
    this.opened = false;
    this.prompt.hide();
  }

  /** Redraws the values after something outside this screen changed them. */
  refresh(): void {
    if (this.opened) this.render();
  }

  handleAction(action: Action): void {
    if (this.prompt.visible) {
      this.prompt.handleAction(action);
      return;
    }
    if (action === 'back') {
      this.handlers.onBack();
      return;
    }
    if (action === 'select') {
      if (this.nav.focused) this.activate(this.nav.focused);
      return;
    }
    if (action !== 'up' && action !== 'down' && action !== 'left' && action !== 'right') return;
    if (!this.nav.move(action) && action === 'up') this.handlers.onRevealTabBar();
  }

  private activate(control: HTMLElement): void {
    if (control.dataset.prefsAction === 'back') {
      this.handlers.onBack();
      return;
    }
    const id = control.dataset.cardId;
    if (!id) return;
    const groups = this.groups();
    for (let g = 0; g < groups.length; g++) {
      for (let c = 0; c < groups[g].cards.length; c++) {
        const card = groups[g].cards[c];
        if (card.id !== id) continue;
        if (!card.soon) card.run();
        return;
      }
    }
  }

  private confirm(title: string, message: string, onConfirm: () => void): void {
    this.prompt.show({
      title,
      message,
      confirmLabel: t('prefs.clear'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        this.prompt.hide();
        onConfirm();
        this.render();
      },
      onCancel: () => this.prompt.hide(),
    });
  }

  private cycleLanguage(): void {
    const order: Array<'system' | 'pt-BR' | 'en'> = ['system', 'pt-BR', 'en'];
    const current = StorageService.getLocalePreference();
    const next = order[(order.indexOf(current as 'system' | 'pt-BR' | 'en') + 1) % order.length];
    StorageService.setLocalePreference(next);
    this.handlers.onLocaleChanged();
    this.render();
  }

  private languageLabel(): string {
    const preference = StorageService.getLocalePreference();
    if (preference === 'system') return t('settings.languageSystem');
    const option = localeOptions().filter((item) => item.value === preference)[0];
    return option ? option.label : preference;
  }

  private toggleRefresh(): void {
    const on = StorageService.getPlaylistRefreshIntervalHours() > 0;
    const hours = on ? 0 : CONFIG.DEFAULT_PLAYLIST_REFRESH_INTERVAL_MS / (60 * 60 * 1000);
    StorageService.setPlaylistRefreshIntervalHours(hours);
    StorageService.setEpgRefreshIntervalHours(
      on ? 0 : CONFIG.DEFAULT_EPG_REFRESH_INTERVAL_MS / (60 * 60 * 1000),
    );
    this.handlers.onRefreshChanged();
    this.render();
  }

  private historyCard(
    id: string,
    title: TextMessageKey,
    count: number,
    unit: 'prefs.channelCount' | 'prefs.movieCount' | 'prefs.episodeCount',
    clear: () => void,
  ): Card {
    return {
      id,
      icon: TRASH_ICON,
      title,
      subtitle: () => (count > 0 ? tp(unit, count) : t('prefs.empty')),
      run: () => {
        if (count === 0) return;
        this.confirm(t(title), t('prefs.clearConfirm'), () => {
          clear();
          this.handlers.onHistoryCleared();
        });
      },
    };
  }

  private groups(): Group[] {
    const refreshOn = StorageService.getPlaylistRefreshIntervalHours() > 0;
    const subtitles = StorageService.getOnlineSubtitleConfig();
    const subtitlesReady = !!(subtitles.subdl.apiKey || subtitles.assrt.apiKey || subtitles.opensubtitles.apiKey);
    const reminders = this.handlers.reminderCount();
    return [
      {
        title: 'prefs.group.privacy',
        cards: [
          {
            id: 'language',
            icon: GLOBE_ICON,
            title: 'prefs.language',
            subtitle: () => this.languageLabel(),
            run: () => this.cycleLanguage(),
          },
          {
            id: 'subtitles',
            icon: CAPTIONS_ICON,
            title: 'prefs.subtitles',
            subtitle: () => subtitles.preferredLanguage || t('prefs.subtitlesAny'),
            run: () => this.handlers.onOpenPane('subtitles'),
          },
          {
            id: 'online-subtitles',
            icon: CAPTIONS_ICON,
            title: 'settings.onlineSubtitles',
            subtitle: () => t(subtitlesReady ? 'prefs.configured' : 'prefs.notConfigured'),
            run: () => this.handlers.onOpenPane('subtitles'),
          },
        ],
      },
      {
        title: 'prefs.group.history',
        cards: [
          this.historyCard(
            'clear-channels', 'prefs.clearChannels',
            StorageService.getRecentlyWatchedLive().length, 'prefs.channelCount',
            () => StorageService.clearRecentlyWatched(),
          ),
          this.historyCard(
            'clear-movies', 'prefs.clearMovies',
            StorageService.countResume('vod'), 'prefs.movieCount',
            () => StorageService.clearResumeKind('vod'),
          ),
          this.historyCard(
            'clear-series', 'prefs.clearSeries',
            StorageService.countResume('episode'), 'prefs.episodeCount',
            () => StorageService.clearResumeKind('episode'),
          ),
          {
            id: 'data',
            icon: DATABASE_ICON,
            title: 'settings.dataManagement',
            subtitle: () => t('prefs.dataHint'),
            run: () => this.handlers.onOpenPane('data'),
          },
        ],
      },
      {
        title: 'prefs.group.playback',
        cards: [
          {
            id: 'auto-refresh',
            icon: REFRESH_ICON,
            title: 'prefs.autoRefresh',
            subtitle: () => t(refreshOn ? 'prefs.enabled' : 'prefs.disabled'),
            on: () => refreshOn,
            run: () => this.toggleRefresh(),
          },
          {
            id: 'playback',
            icon: PLAYBACK_ICON,
            title: 'settings.playback',
            subtitle: () => t('prefs.playbackHint'),
            run: () => this.handlers.onOpenPane('playback'),
          },
          {
            id: 'cloud',
            icon: CLOUD_ICON,
            title: 'prefs.cloudSync',
            subtitle: () => t('prefs.soon'),
            soon: true,
            run: () => {},
          },
        ],
      },
      {
        title: 'prefs.group.system',
        cards: [
          {
            id: 'stream',
            icon: SOURCES_ICON,
            title: 'settings.sources',
            subtitle: () => t('prefs.streamHint'),
            run: () => this.handlers.onOpenPane('sources'),
          },
          {
            id: 'guide',
            icon: GUIDE_ICON,
            title: 'settings.guide',
            subtitle: () => t('prefs.guideHint'),
            run: () => this.handlers.onOpenPane('guide'),
          },
          {
            id: 'appearance',
            icon: APPEARANCE_ICON,
            title: 'settings.appearance',
            subtitle: () => t('prefs.appearanceHint'),
            run: () => this.handlers.onOpenPane('appearance'),
          },
          {
            id: 'reminders',
            icon: BELL_ICON,
            title: 'prefs.reminders',
            subtitle: () => (reminders > 0 ? tp('prefs.reminderCount', reminders) : t('prefs.empty')),
            run: () => this.handlers.onOpenReminders(),
          },
          {
            id: 'clock',
            icon: CLOCK_ICON,
            title: 'prefs.timezone',
            subtitle: () => t('prefs.timezoneHint'),
            run: () => this.handlers.onOpenPane('guide'),
          },
        ],
      },
    ];
  }

  private card(card: Card): Safe {
    const on = card.on ? card.on() : null;
    return html`
      <button class="prefs-card ${on ? 'is-on' : ''} ${card.soon ? 'is-soon' : ''}" data-focusable
              data-key="card:${card.id}" data-card-id="${card.id}" aria-disabled="${String(!!card.soon)}">
        <span class="prefs-card-icon">${raw(card.icon)}</span>
        <span class="prefs-card-text">
          <span class="prefs-card-title">${t(card.title)}</span>
          <span class="prefs-card-subtitle" id="prefs-value-${card.id}">${card.subtitle()}</span>
        </span>
        ${on === null ? '' : html`
          <span class="prefs-switch ${on ? 'is-on' : ''}">
            <span class="prefs-switch-dot"></span>${t(on ? 'prefs.on' : 'prefs.off')}
          </span>`}
      </button>`;
  }

  private render(): void {
    const focusedKey = this.nav.focused?.dataset.key ?? '';
    const snapshot = ActivationService.snapshot;
    morph(this.container, html`
      <div class="prefs-view">
        <div class="prefs-scroll">
          <header class="prefs-head">
            <button class="prefs-back" data-focusable data-key="prefs-back" data-prefs-action="back"
                    aria-label="${t('common.back')}">${raw(CHEVRON_LEFT_ICON)}</button>
            <div class="prefs-head-text">
              <div class="prefs-eyebrow">${t('prefs.eyebrow', { version: CONFIG.VERSION })}</div>
              <h1 class="prefs-title">${t('common.settings')}</h1>
            </div>
          </header>
          ${this.groups().map((group) => html`
            <section class="prefs-group" data-key="group:${group.title}">
              <div class="prefs-group-head">
                <span class="prefs-group-title">${t(group.title)}</span>
                <span class="prefs-group-rule"></span>
              </div>
              <div class="prefs-grid" data-nav-container>
                ${group.cards.map((card) => this.card(card))}
              </div>
            </section>`)}
        </div>
        <footer class="prefs-foot">
          <div class="prefs-foot-item">
            <span class="prefs-foot-label">${t('prefs.mac')}</span>
            <span class="prefs-foot-value" id="prefs-mac">${snapshot.deviceId || '—'}</span>
          </div>
          <div class="prefs-foot-item">
            <span class="prefs-foot-label">${t('prefs.deviceKey')}</span>
            <span class="prefs-foot-value" id="prefs-key">${
              snapshot.manageKey ? formatKey(snapshot.manageKey) : '—'}</span>
          </div>
        </footer>
      </div>
    `);
    // morph rewrites the class attribute, which drops the focus ring SpatialNav put there.
    if (focusedKey) {
      const again = this.container.querySelector<HTMLElement>(`[data-key="${focusedKey}"][data-focusable]`);
      if (again) this.nav.focus(again);
    }
  }
}
