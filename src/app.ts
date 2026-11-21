import './polyfills';
import { CONFIG } from './config';
import { KeyHandler } from './navigation/key-handler';
import { PlaylistService } from './services/playlist-service';
import { ChannelCustomizationService, groupKeyOf } from './services/channel-customization';
import { loadSeriesCategories, loadVodCategories } from './services/xtream-catalog';
import { EpgService } from './services/epg-service';
import { ChannelHealthService } from './services/channel-health';
import { StorageService } from './services/storage-service';
import {
  clearAllCachedData,
  clearCachedCatalog,
  clearCachedPlaylist,
  flushCacheWrites,
} from './services/idb-cache';
import { isLunaAvailable, lunaRequest } from './services/luna';
import { ChannelList } from './components/channel-list';
import { Player } from './components/player';
import { LivePreview } from './components/live-preview';
import { EpgGrid } from './components/epg-grid';
import { Settings, type SaveAction } from './components/settings';
import { Sidebar } from './components/sidebar';
import { PlayerMenu } from './components/player-menu';
import { TabBar, type LegendItem, type Section, sectionForView } from './components/tab-bar';
import { Movies } from './components/movies';
import { Series } from './components/series';
import { Search } from './components/search';
import { Preferences, type PreferencePane } from './components/preferences';
import { PinPrompt } from './components/pin-prompt';
import { ParentalService } from './services/parental';
import { isAdultName } from './utils/adult-content';
import { Access } from './components/access';
import { Home, type HomeChannel, type HomeData, type HomeSection } from './components/home';
import { RecentlyWatchedService } from './services/recently-watched';
import { createXtreamClient } from './services/xtream-client';
import {
  ActivationService, settleSingleAccess,
} from './services/xsol/activation-service';
import { PlayerPresentation } from './components/player-presentation';
import { PanelClient, type WatchingInfo } from './services/xsol/panel-client';
import { showToast } from './components/toast';
import { showNumberEntry, hideNumberEntry } from './components/number-entry';
import { ReminderService } from './services/reminder-service';
import { ReminderPrompt } from './components/reminder-prompt';
import { ReminderManager } from './components/reminder-manager';
import { setDisplayTz, setTimeFormat } from './utils/time';
import { initTheme, applyTheme, applyOverlayStyle, applyTextSize } from './services/theme-service';
import { applyAnimationMode } from './services/motion-service';
import { channelKey } from './utils/channel';
import { isSourceEnabled } from './utils/playlist';
import { truncate } from './utils/text';
import { $, show, hide } from './utils/dom';
import { createLogger, installGlobalErrorHandlers, logEnvironment } from './utils/logger';
import type {
  Action,
  NumberEvent,
  CatchupInfo,
  Channel,
  ChannelScope,
  EpgSource,
  PlaylistEntry,
} from './types';
import { getLocale, initLocale, resolveLocale, setLocale, t, tp } from './i18n';

const log = createLogger('App');

type ViewName = 'channels' | 'player' | 'epg' | 'settings' | 'reminders'
  | 'loading' | 'movies' | 'series' | 'search' | 'access' | 'home' | 'prefs';

class App {
  private views!: Record<ViewName, HTMLElement>;
  private viewStack: ViewName[] = ['channels'];
  private backPressTime = 0;
  private viewBeforeSearch: ViewName | null = null;
  private channelList!: ChannelList;
  private player!: Player;
  private livePreview!: LivePreview;
  private epgGrid!: EpgGrid;
  private settings!: Settings;
  private access!: Access;
  private home!: Home;
  private returnToAccess = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private homePresentation: PlayerPresentation | null = null;
  private homePreviewActive = false;
  private legendSignature = '';
  private homePreviewMuted = false;
  private sidebar!: Sidebar;
  private menu!: PlayerMenu;
  private reminderPrompt = new ReminderPrompt();
  private pinPrompt = new PinPrompt();
  private reminderManager!: ReminderManager;
  private reminderManagerOrigin: 'settings' | 'epg' = 'settings';
  private tabBar!: TabBar;
  private search!: Search;
  private preferences!: Preferences;
  // The option panes were opened from a card: Back and Save lead to the cards again.
  private panesFromCards = false;
  private movies!: Movies;
  private series!: Series;
  private remindersInitialized = false;
  private playlistRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private playlistRefreshIntervalMs: number | null | undefined;
  private playlistRefreshPromise: Promise<void> | null = null;
  private epgRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private epgRefreshIntervalMs: number | null | undefined;
  private epgChannelReloadTimer: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    const done = log.time('init');
    log.info('Initializing app');
    await StorageService.init();
    StorageService.setWriteFailureHandler(() => showToast(t('app.saveFailed')));
    initLocale(StorageService.getLocalePreference());
    applyAnimationMode(StorageService.getAnimationMode());
    const initialLoadingText = $('#loading-text');
    if (initialLoadingText) initialLoadingText.textContent = t('common.loading');
    initTheme();
    setTimeFormat(StorageService.getTimeFormat());
    this.views = {
      channels: $('#view-channels')!,
      player: $('#view-player')!,
      epg: $('#view-epg')!,
      settings: $('#view-settings')!,
      prefs: $('#view-prefs')!,
      access: $('#view-access')!,
      home: $('#view-home')!,
      reminders: $('#view-reminders')!,
      movies: $('#view-movies')!,
      series: $('#view-series')!,
      search: $('#view-search')!,
      loading: $('#view-loading')!,
    };

    this.channelList = new ChannelList(
      $('#channel-browser')!,
      {
        onChannelSelect: (idx, catchup, scope, mode) =>
          this.livePreview.selectChannel(idx, catchup, scope, mode),
        onChannelsChanged: () => {
          this.player.syncCurrentIndex();
          this.scheduleEpgReload();
        },
        onEpgMappingChanged: () => this.scheduleEpgReload(),
        onEpgOffsetChanged: () => {
          void this.search.refreshPrograms();
        },
        onEnterPreview: () => this.livePreview?.focusControls() ?? false,
        onListFocus: () => this.livePreview?.leaveControls(false),
        getPreviewHintState: () => this.livePreview?.hintState() ?? 'off',
        onEnterManagement: () => {
          this.livePreview?.close();
          this.livePreview?.setManagingList(true);
        },
        onLeaveManagement: () => this.livePreview?.setManagingList(false),
      },
    );
    this.player = new Player(this.views.player, () => {
      this.channelList.render();
      this.showView('channels');
    }, (idx, catchupStart) => {
      this.channelList.setPlaying(idx, catchupStart);
      if (this.livePreview?.isShowing) this.channelList.render(false);
    },
    () => !this.sidebar.visible && !this.menu.visible,
    () => {
      this.sidebar.refresh();
    }, () => {
      this.livePreview?.refresh();
      // A reconnect swaps in a fresh, unstyled <video>; put it back in the card.
      if (this.homePreviewActive) this.homePresentation?.refresh();
    },
    () => this.livePreview?.canResumePlayback() ?? true);
    this.epgGrid = new EpgGrid(
      this.views.epg,
      (idx, catchup, scope) => this.playChannel(idx, catchup, scope),
      () => this.tabBar.focus(),
      () => this.openReminderManager('epg'),
    );
    this.reminderManager = new ReminderManager(this.views.reminders, () => {
      if (this.reminderManagerOrigin === 'epg') {
        this.showView('epg');
        this.epgGrid.focusReminderEntry();
      } else {
        this.showView('settings');
        this.settings.focusReminderEntry();
      }
    });
    this.settings = new Settings(
      this.views.settings,
      (action) => this.onSettingsSaved(action),
      () => this.player.syncCurrentIndex(),
      () => this.openReminderManager('settings'),
    );

    this.preferences = new Preferences(this.views.prefs, {
      onBack: () => this.leaveToStart(),
      onRevealTabBar: () => {
        if (!this.tabBar.shown) return false;
        this.tabBar.focus();
        return true;
      },
      onOpenPane: (pane) => this.openSettingsPane(pane),
      onOpenReminders: () => this.openReminderManager('settings'),
      onLocaleChanged: () => {
        const locale = resolveLocale(StorageService.getLocalePreference());
        if (locale === getLocale()) return;
        setLocale(locale);
        this.tabBar.refresh();
        ReminderService.reschedulePending();
      },
      parentalEnabled: () => ParentalService.enabled,
      onToggleParental: () => this.toggleParental(),
      onTimeFormatChanged: () => {
        setTimeFormat(StorageService.getTimeFormat());
        this.tabBar.refresh();
        this.channelList.render();
      },
      onRefreshChanged: () => {
        this.scheduleEpgRefresh();
        this.schedulePlaylistRefresh();
      },
      onHistoryCleared: () => {
        this.channelList.render();
      },
      reminderCount: () => ReminderService.listManageable().length,
      liveCategories: () => {
        const seen: Record<string, true> = {};
        const rows: Array<{ key: string; label: string; hidden: boolean }> = [];
        for (const channel of PlaylistService.allChannels) {
          const key = groupKeyOf(channel);
          if (seen[key]) continue;
          seen[key] = true;
          rows.push({
            key,
            label: ChannelCustomizationService.groupLabel(key),
            hidden: ChannelCustomizationService.isGroupHidden(key),
          });
        }
        return rows;
      },
      toggleLiveCategory: (key) => { ChannelCustomizationService.toggleGroupHidden(key); },
      catalogCategories: async (kind) => {
        const account = this.activeXtreamAccount();
        if (!account) return null;
        const categories = kind === 'vod'
          ? await loadVodCategories(account)
          : await loadSeriesCategories(account);
        return categories.map((category) => category.name);
      },
      onCategoriesChanged: (kind) => {
        if (kind === 'live') {
          PlaylistService.applyCustomization();
          this.player.syncCurrentIndex();
          this.channelList.render();
          this.sidebar.refresh();
        }
        // Movies and Series read the hidden list each time they are opened.
        this.search.invalidateCatalog();
      },
    });

    this.access = new Access(this.views.access, {
      // Stay on Access through the reload: the user is watching it for the result.
      onPlaylistChanged: () => {
        // ...unless this is the first list arriving on a fresh install: setup is
        // done, so the app opens on its start screen like any later launch.
        this.returnToAccess = PlaylistService.channels.length > 0;
        void this.onSettingsSaved('reload');
      },
      // A locked device has nowhere to go back to: Back offers to exit instead.
      onBack: () => (ActivationService.locked ? this.confirmExit() : this.leaveToStart()),
      onRevealTabBar: () => {
        if (!this.tabBar.shown) return false;
        this.tabBar.focus();
        return true;
      },
    });

    this.home = new Home(this.views.home, {
      getData: () => this.homeData(),
      loadUserExpiry: () => this.homeUserExpiry(),
      onResume: (index) => this.resumeFromHome(index),
      onPlayChannel: (index) => this.playChannel(index),
      onAllChannels: () => this.enterSection('live'),
      onSection: (section: HomeSection) => this.enterSection(section),
      onRevealTabBar: () => {
        if (!this.tabBar.shown) return false;
        this.tabBar.focus();
        return true;
      },
      onTuneChannel: (delta) => this.tuneHomePreview(delta),
      onBack: () => this.confirmExit(),
    });

    this.player.init($('#video-player') as HTMLVideoElement);
    this.livePreview = new LivePreview($('#live-preview')!, {
      idleContainer: $('#live-preview-idle'),
      channelView: this.views.channels,
      player: this.player,
      channelList: this.channelList,
      getCurrentView: () => this.viewStack[this.viewStack.length - 1],
      showChannels: preserveFocus => this.showView('channels', preserveFocus),
      showPlayer: () => this.showView('player'),
      playFullscreen: (index, catchup, scope) => this.playChannel(index, catchup, scope),
      blurTabBar: () => this.tabBar.blur(),
      expansionBlocked: () => this.reminderPrompt.visible,
      isFavorite: channel => StorageService.getFavorites().includes(channelKey(channel)),
      toggleFavorite: channel => this.toggleChannelFavorite(channel),
    });
    this.homePresentation = new PlayerPresentation(
      () => this.player.getVideoElement(),
      () => this.views.home.querySelector<HTMLElement>('.home-last-video'),
    );
    window.addEventListener('resize', () => {
      this.livePreview.refreshLayout();
      if (this.homePreviewActive) this.homePresentation?.refresh();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.livePreview.suspend();
      } else {
        this.livePreview.refresh();
        this.livePreview.refreshLayout();
      }
    });

    this.sidebar = new Sidebar(
      this.views.player,
      () => this.player.getCurrentIndex(),
      (idx, catchup, scope) => this.playChannel(idx, catchup, scope),
      () => this.player.getCurrentCatchupStart(),
    );
    this.menu = new PlayerMenu(
      this.views.player,
      () => this.player.getCurrentChannel(),
      (action) => this.onMenuAction(action),
      () => this.player.getAudioTracks(),
      (index) => this.player.selectAudioTrack(index),
      () => this.player.getSubtitleTracks(),
      (index) => this.player.selectSubtitleTrack(index),
      () => this.player.subtitleOffsetState(),
      () => this.player.openSubtitleOffset(),
    );

    this.movies = new Movies(this.views.movies, {
      onRevealTabBar: () => this.tabBar.focus(),
      // The side column's "Home" pill and the remote's Back both lead out.
      onBack: () => this.leaveToStart(),
      onPlayVod: (req) => {
        this.showView('player');
        this.player.playVod({
          ...req,
          onBack: () => {
            this.showView('movies');
            this.movies.refreshPlaybackState();
          },
        });
      },
    });
    this.series = new Series(this.views.series, {
      onRevealTabBar: () => this.tabBar.focus(),
      // The side column's "Home" pill and the remote's Back both lead out.
      onBack: () => this.leaveToStart(),
      onPlayVod: (req) => {
        this.showView('player');
        this.player.playVod({
          ...req,
          onBack: () => {
            this.showView('series');
            this.series.refreshPlaybackState();
          },
        });
      },
    });
    this.search = new Search(this.views.search, {
      onRevealTabBar: () => this.tabBar.focus(),
      onBack: () => this.goLive(),
      onPlayChannel: (idx, catchup) => { this.tabBar.blur(); this.playChannel(idx, catchup); },
      onOpenMovie: (account, vod) => {
        this.tabBar.blur();
        this.showView('movies');
        this.movies.openItem(account, vod, () => this.showView('search'))
          .catch((err) => log.error(
            'Open movie failed',
            'event=xtream.view.open.failed',
            'operation=movie_detail',
            err,
          ));
      },
      onOpenSeries: (account, series) => {
        this.tabBar.blur();
        this.showView('series');
        this.series.openItem(account, series, () => this.showView('search'))
          .catch((err) => log.error(
            'Open series failed',
            'event=xtream.view.open.failed',
            'operation=series_detail',
            err,
          ));
      },
    });
    this.tabBar = new TabBar({
      // Moving along the bar previews each section; a guarded one stays shut
      // until it is actually entered and the PIN is given.
      onSwitch: (section) => { if (!this.isGuarded(section)) this.switchSection(section); },
      onEnter: (section) => this.enterSection(section),
      onSearchQuery: (query) => this.handleSearchQuery(query),
      onSearchLeave: () => this.search.focusFirstResult(),
      onSearchClose: () => this.handleSearchClose(),
    });
    this.tabBar.init();

    KeyHandler.init();
    KeyHandler.setHandler((action, event) => {
      this.handleKey(action, event);
      this.syncLegend();
    });
    KeyHandler.setChannelCount(() => PlaylistService.channels.length);

    this.initSidebarTrigger();

    done();
    this.bindBackgroundFlush();
    this.bindReminderLifecycle();
    this.bindActivationGuard();
    // Register a retail-safe callback immediately. If Developer Mode is
    // detected below, the same named activities are replaced with alerts.
    ReminderService.reschedulePending();
    await this.loadData();
    // Cold launch from a "Watch now" alert: channels are loaded now, so tune.
    this.handleLaunchParams(this.coldLaunchParams());
    // Asking the bundled service spawns its process, which can stall Luna on a
    // cold TV. Keep it off the critical path so cached channels render first.
    void this.initReminderMode();
  }

  // Backgrounding is the last reliable moment to persist: webOS may discard the
  // suspended app without another event. Coming back is also when a dev-mode
  // probe that timed out on a cold TV gets its second chance.
  private bindBackgroundFlush(): void {
    let lastVisibility = document.visibilityState;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === lastVisibility) return;
      lastVisibility = document.visibilityState;
      if (document.visibilityState === 'hidden') {
        void this.flushUserData('background');
      } else if (document.visibilityState === 'visible' && !this.remindersInitialized) {
        void this.initReminderMode();
      }
    });
  }

  private async flushUserData(reason: 'background' | 'exit'): Promise<boolean> {
    try {
      await Promise.all([StorageService.flush(), flushCacheWrites()]);
      log.info(
        'User data flush completed',
        'event=persistence.user.flush.completed',
        'operation=flush',
        `reason=${reason}`,
      );
      return true;
    } catch (err) {
      log.error(
        'User data flush failed',
        'event=persistence.user.flush.failed',
        'operation=flush',
        `reason=${reason}`,
        err,
      );
      return false;
    }
  }

  private async exitApp(): Promise<void> {
    if (!await this.flushUserData('exit')) {
      this.backPressTime = 0;
      showToast(t('app.saveFailed'));
      return;
    }
    window.close();
  }

  // The bundled service only answers two things now: whether the TV is in
  // Developer Mode, and the reminder alert it raises there.
  private async initReminderMode(): Promise<void> {
    const initialized = await this.queryDevMode();
    ReminderService.reschedulePending();
    this.remindersInitialized = initialized;
  }

  /**
   * Ask the bundled service whether Developer Mode is on. In dev mode reminders
   * fire an interactive system alert instead of the passive toast + in-app
   * prompt. Guarded: with no Luna bus (desktop/e2e) dev-mode stays false and we
   * keep the retail in-app path.
   */
  private async queryDevMode(): Promise<boolean> {
    ReminderService.setDevMode(false);
    if (!isLunaAvailable()) {
      log.debug('Luna unavailable — dev-mode alert disabled, using in-app prompt');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (initialized: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(initialized);
        }
      };
      const timer = setTimeout(() => finish(false), 3000);
      try {
        lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
          method: 'getDevMode',
          parameters: {},
          onSuccess: (resp: unknown) => {
            clearTimeout(timer);
            const lateSuccess = settled;
            if (document.visibilityState === 'hidden') {
              finish(false);
              return;
            }
            const dev = !!(resp && typeof resp === 'object' && (resp as { devmode?: unknown }).devmode);
            ReminderService.setDevMode(dev);
            log.info('getDevMode:', dev);
            finish(true);
            if (lateSuccess) {
              this.remindersInitialized = true;
              ReminderService.reschedulePending();
            }
          },
          onFailure: (err: unknown) => {
            clearTimeout(timer);
            log.warn('getDevMode onFailure:', JSON.stringify(err));
            finish(false);
          },
        });
      } catch (e) {
        clearTimeout(timer);
        log.warn('getDevMode threw:', e);
        finish(false);
      }
    });
  }

  /**
   * Push the saved display-timezone mode + the EPG's source offset into the
   * time formatter. Display only; safe to re-run any time. Prefers the offset
   * from the freshly-loaded feed, persists it, and falls back to the last-known
   * value — so feed mode renders correctly before the EPG has reloaded. The
   * formatter degrades 'feed' to 'device' while the offset is still unknown.
   */
  private applyDisplayTz(): void {
    const offset = EpgService.tzOffsetMinutes ?? StorageService.getEpgTzOffset();
    if (EpgService.tzOffsetMinutes != null) StorageService.setEpgTzOffset(EpgService.tzOffsetMinutes);
    setDisplayTz(StorageService.getTzMode(), offset);
  }

  private epgSources(): EpgSource[] {
    if (!StorageService.getPlaylists().some(isSourceEnabled)) return [];
    const manual = StorageService.getManualEpgSources()
      .map(source => ({ ...source, kind: 'manual' as const }));
    const discovered = PlaylistService.epgSources;
    const sources: EpgSource[] = [...manual, ...discovered];
    const offsets = StorageService.getEpgOffsets();
    return sources.map(source => ({ ...source, offsetMinutes: offsets[source.url] ?? 0 }));
  }

  /**
   * The guide covers the eligible channels, so a visibility edit and a
   * mapping edit both have to re-derive it. Narrowing the selection is served
   * from the cache; only a selection that grew refetches.
   */
  private scheduleEpgReload(): void {
    if (this.epgChannelReloadTimer !== null) clearTimeout(this.epgChannelReloadTimer);
    this.epgChannelReloadTimer = setTimeout(() => {
      this.epgChannelReloadTimer = null;
      const sources = this.epgSources();
      if (!sources.length) return;
      void EpgService.load(
        sources,
        PlaylistService.getEpgEligibleChannels(),
        () => this.refreshEpgDependentViews(),
      )
        .then(() => {
          this.refreshEpgDependentViews();
        })
        .catch(err => log.error('EPG reload after a channel change failed:', err));
    }, CONFIG.EPG.CHANNEL_CHANGE_RELOAD_DELAY);
  }

  private stopEpgRefresh(): void {
    if (this.epgChannelReloadTimer !== null) {
      clearTimeout(this.epgChannelReloadTimer);
      this.epgChannelReloadTimer = null;
    }
    this.epgRefreshIntervalMs = undefined;
    if (this.epgRefreshTimer !== null) {
      clearTimeout(this.epgRefreshTimer);
      this.epgRefreshTimer = null;
    }
  }

  private scheduleEpgRefresh(force = false, delayOverride?: number): void {
    const intervalMs = StorageService.getEpgRefreshIntervalMs();
    const shouldRun = intervalMs !== null && this.epgSources().length > 0;
    if (!force
      && this.epgRefreshIntervalMs === intervalMs
      && ((shouldRun && this.epgRefreshTimer !== null)
        || (!shouldRun && this.epgRefreshTimer === null))) {
      return;
    }
    if (this.epgRefreshTimer !== null) {
      clearTimeout(this.epgRefreshTimer);
      this.epgRefreshTimer = null;
    }
    this.epgRefreshIntervalMs = intervalMs;
    if (!shouldRun || intervalMs === null) return;
    const delayMs = delayOverride ?? EpgService.getNextRefreshDelayMs(intervalMs);
    this.epgRefreshTimer = setTimeout(() => {
      this.epgRefreshTimer = null;
      EpgService.refresh(() => this.refreshEpgDependentViews())
        .then((complete) => {
          this.refreshEpgDependentViews();
          this.scheduleEpgRefresh(
            true,
            complete ? undefined : StorageService.getEpgRefreshIntervalMs() ?? undefined,
          );
        }, (err) => {
          log.error('EPG refresh failed:', err);
          this.scheduleEpgRefresh(true, StorageService.getEpgRefreshIntervalMs() ?? undefined);
        });
    }, delayMs);
  }

  private stopPlaylistRefresh(): void {
    if (this.playlistRefreshTimer !== null) {
      clearTimeout(this.playlistRefreshTimer);
      this.playlistRefreshTimer = null;
    }
    this.playlistRefreshIntervalMs = undefined;
  }

  private schedulePlaylistRefresh(force = false, delayOverride?: number): void {
    const intervalMs = StorageService.getPlaylistRefreshIntervalMs();
    const shouldRun = intervalMs !== null
      && StorageService.getPlaylists().some(isSourceEnabled);
    if (!force
      && this.playlistRefreshIntervalMs === intervalMs
      && ((shouldRun && this.playlistRefreshTimer !== null)
        || (!shouldRun && this.playlistRefreshTimer === null))) {
      return;
    }
    if (this.playlistRefreshTimer !== null) {
      clearTimeout(this.playlistRefreshTimer);
      this.playlistRefreshTimer = null;
    }
    this.playlistRefreshIntervalMs = intervalMs;
    if (!shouldRun || intervalMs === null) return;
    const delayMs = delayOverride ?? PlaylistService.getNextRefreshDelayMs(intervalMs);
    this.playlistRefreshTimer = setTimeout(() => {
      this.playlistRefreshTimer = null;
      void this.queuePlaylistRefresh();
    }, delayMs);
  }

  private queuePlaylistRefresh(): Promise<void> {
    if (this.playlistRefreshPromise) return this.playlistRefreshPromise;
    const onSettled = () => {
      this.playlistRefreshPromise = null;
      this.schedulePlaylistRefresh(
        true,
        StorageService.getPlaylistRefreshIntervalMs() ?? undefined,
      );
    };
    this.playlistRefreshPromise = this.refreshPlaylistInBackground()
      .then(() => {
        onSettled();
      }, (err) => {
        onSettled();
        throw err;
      });
    return this.playlistRefreshPromise;
  }

  private async refreshPlaylistInBackground(): Promise<void> {
    try {
      if (!StorageService.getPlaylists().some(isSourceEnabled)) return;
      await PlaylistService.refresh(undefined, { preserveOnFailure: true });
      this.player.syncCurrentIndex();
      await ChannelHealthService.initialize();

      const epgSources = this.epgSources();
      if (epgSources.length) {
        await EpgService.load(
          epgSources,
          PlaylistService.getEpgEligibleChannels(),
          () => this.refreshEpgDependentViews(),
        );
        await EpgService.refresh(() => this.refreshEpgDependentViews());
        this.refreshEpgDependentViews();
      } else {
        EpgService.reset();
        this.refreshEpgDependentViews();
      }
      this.scheduleEpgRefresh(true);

      const playlists = StorageService.getPlaylists();
      const xtreamAccounts = playlists
        .filter((playlist) =>
          playlist.source === 'xtream' && playlist.xtream && isSourceEnabled(playlist));
      this.tabBar.setSections(xtreamAccounts.length > 0);
      this.channelList.render();
      this.sidebar.refresh();
      this.livePreview?.refresh();
    } catch (err) {
      log.error('Automatic playlist refresh failed:', err);
    }
  }

  private async loadData(forceEpgRefresh = false): Promise<void> {
    const done = log.time('loadData');
    show(this.views.loading);
    this.stopEpgRefresh();
    this.stopPlaylistRefresh();
    if (this.playlistRefreshPromise) await this.playlistRefreshPromise;

    this.applyDisplayTz();
    this.epgGrid.resetDay(); // re-pick today; a tz change invalidates the remembered day index

    try {
      // Only the access in use is loaded: never two accounts' channels at once.
      settleSingleAccess();
      const playlists = StorageService.getPlaylists();
      log.info('Configured playlists:', playlists.length);
      if (!playlists.length) {
        log.info('No playlists configured — opening settings');
        // Clear in-memory state so the channel list does not show stale
        // channels if the user navigates back from settings (e.g. with BACK).
        PlaylistService.reset();
        EpgService.reset();
        // No account at all: drop Movies/Series (Xtream-only) so the docked tab
        // bar shows Live/Settings/Search only.
        this.tabBar.setSections(false);
        this.channelList.render();
        // First run: the Access screen carries the MAC, key and portal QR code the
        // customer needs, and picks the playlist up as soon as the portal has one.
        this.returnToAccess = false;
        this.showView('access');
        this.access.open();
        return;
      }

      const loadingText = $('#loading-text');
      if (loadingText) loadingText.textContent = t('app.loadingChannels');
      let lastProgressAt = 0;
      await PlaylistService.load(progress => {
        if (!loadingText) return;
        const now = Date.now();
        if (now - lastProgressAt < 250) return;
        lastProgressAt = now;
        loadingText.textContent = t('app.loadingChannelsProgress', {
          processed: progress.channelsProcessed,
          kept: progress.channelsKept,
        });
      });
      this.player.syncCurrentIndex();
      await ChannelHealthService.initialize();
      log.info('Channels loaded:', PlaylistService.channels.length,
        '| groups:', PlaylistService.groups.length,
        '| epgSources:', PlaylistService.epgSources);
      const epgSources = this.epgSources();
      if (epgSources.length) log.info('Using EPG sources:', epgSources);
      else {
        log.warn('No EPG sources configured');
        EpgService.reset();
      }
      const epgChannels = PlaylistService.getEpgEligibleChannels();
      if (epgSources.length) {
        await EpgService.restoreCached(epgSources, epgChannels);
      }

      const hasXtream = StorageService.getPlaylists()
        .some((p) => p.source === 'xtream' && isSourceEnabled(p));
      // With parental control on, a list that just loaded is screened too.
      if (ParentalService.enabled) void this.hideAdultCategories();
      this.tabBar.setSections(hasXtream);

      this.channelList.render();
      if (this.returnToAccess) {
        this.returnToAccess = false;
        this.showView('access');
        this.access.open();
      } else if (StorageService.getStartView() === 'home') {
        this.showHome();
      } else {
        this.showView('channels');
      }

      showToast(tp('app.channelsLoaded', PlaylistService.channels.length));
      // The home footer and the Access screen both read the panel's answer.
      void ActivationService.refresh()
        .then((changed) => {
          if (changed) void this.onSettingsSaved('reload');
          this.sendHeartbeat();
        })
        .catch(err => log.warn('Activation check failed:', err));

      this.scanReminders();
      ReminderService.reschedulePending();

      if (StorageService.getAutoPlay()) {
        // The per-stream key survives customization and provider reshuffles.
        const lastCh = PlaylistService.resolveLastChannelIndex(
          StorageService.getLastChannelKey(),
          StorageService.getLastChannel(),
        );
        if (lastCh >= 0 && lastCh < PlaylistService.channels.length) {
          log.info('Auto-play resuming last channel index', lastCh);
          this.playChannel(lastCh);
        }
      }

      if (epgSources.length) {
        if (forceEpgRefresh) {
          EpgService.refresh(() => this.refreshEpgDependentViews(), true)
            .then(() => {
              this.refreshEpgDependentViews();
              this.scheduleEpgRefresh(
                true,
                StorageService.getEpgRefreshIntervalMs() ?? undefined,
              );
            }, (err) => {
              log.error('EPG load failed:', err);
              this.scheduleEpgRefresh(
                true,
                StorageService.getEpgRefreshIntervalMs() ?? undefined,
              );
            });
        } else if (StorageService.getEpgRefreshIntervalMs() === null) {
          EpgService.refresh(() => this.refreshEpgDependentViews())
            .then(() => {
              this.refreshEpgDependentViews();
            }, err => log.error('Initial EPG load failed:', err));
        } else {
          this.scheduleEpgRefresh(true);
        }
      }
      this.schedulePlaylistRefresh(true);
    } catch (err) {
      log.error('loadData failed:', err);
      this.showView('settings');
      this.settings.render();
      showToast(t('app.loadFailed'));
    } finally {
      // A failed load lands on Settings; a later load must not jump back to Access.
      this.returnToAccess = false;
      hide(this.views.loading);
      done();
    }
  }

  private showView(name: ViewName, preserveChannelFocus = false): void {
    // An expired or blocked device gets the Access screen and nothing else.
    if (ActivationService.locked && name !== 'access' && name !== 'loading') {
      this.lockToAccess();
      return;
    }
    this.livePreview?.beforeViewChange(name);
    if (name !== 'access') this.access?.close();
    if (name !== 'prefs') this.preferences?.close();
    if (name !== 'home') {
      this.home?.close();
      this.leaveHomePreview();
    }
    if (name !== 'channels' && this.channelList.isEditing) this.channelList.exitEditMode();
    // Re-assert the persisted theme on every view transition. This reverts any
    // unsaved live preview when Settings closes (Back / section switch / Cancel)
    // while keeping a just-saved theme, since save() persists before this runs.
    applyTheme(StorageService.getTheme());
    applyOverlayStyle(StorageService.getOverlayStyle());
    applyTextSize(StorageService.getTextSize());
    applyAnimationMode(StorageService.getAnimationMode());
    this.player.closeSubtitleSearch(); // never let the subtitle overlay linger across a view change
    this.player.closeSubtitleOffset(); // never let the subtitle-sync overlay linger across a view change
    this.epgGrid.dismissPrompt(); // never let the catch-up prompt linger across a view change
    this.search.dismissPrompt();
    this.settings.dismissPrompt();
    for (const [key, el] of Object.entries(this.views)) {
      if (key === 'loading') continue;
      if (key === name) show(el);
      else hide(el);
    }

    if (name === 'player') {
      if (this.viewStack[this.viewStack.length - 1] !== name) this.viewStack.push(name);
    } else if (name !== this.viewStack[this.viewStack.length - 1]) {
      this.viewStack = [name];
    }

    // The docked tab bar shows on the section views and hides on the full-screen
    // player / EPG (and the loading splash), which render edge-to-edge.
    const section = sectionForView(name);
    this.tabBar.setShown(section !== null);

    // Focus the channel entry point on entry — but not while the tab bar holds
    // focus (a live Left/Right preview updates the view beneath it without
    // stealing the focus ring). No-op on first load (render runs after).
    if (name === 'channels' && !this.tabBar.focused && !preserveChannelFocus) this.channelList.highlightEntryPoint();

    // Keep the active tab bound to the shown section view (so returning from
    // Settings, EPG, the player, etc. updates the underline). Skipped while the
    // search box is open — it overlays other views but stays "Search".
    if (section && !this.tabBar.searchOpen) this.tabBar.setActive(section);
    this.livePreview?.refresh();
    this.syncLegend();
  }

  // What the colour keys do on this screen (see handleKey); none where the bar is
  // hidden, a modal owns the keys, or the device is locked to the Access screen.
  private legendFor(view: ViewName): LegendItem[] {
    if (ActivationService.locked) return [];
    const guide: LegendItem = { key: 'red', label: t('nav.epg') };
    const settings: LegendItem = { key: 'blue', label: t('nav.settings') };
    const favorite: LegendItem = { key: 'green', label: t('legend.favorite') };
    switch (view) {
      case 'home':
      case 'search':
      case 'access':
        return [guide, settings];
      case 'channels':
        return this.channelList.isEditing
          ? []
          : [guide, favorite, { key: 'yellow', label: t('legend.edit') }, settings];
      case 'epg':
        return [
          { key: 'red', label: t('common.back') },
          { key: 'yellow', label: t('common.search') },
          settings,
        ];
      case 'movies':
      case 'series':
        return [guide, favorite, { key: 'yellow', label: t('legend.sort') }, settings];
      case 'settings':
      case 'prefs':
        return [guide, { key: 'blue', label: t('common.back') }];
      default:
        return [];
    }
  }

  private syncLegend(): void {
    const items = this.legendFor(this.viewStack[this.viewStack.length - 1]);
    const signature = items.map((item) => `${item.key}:${item.label}`).join('|');
    if (signature === this.legendSignature) return;
    this.legendSignature = signature;
    this.tabBar.setLegend(items);
  }

  // Map a tab-bar section to its view and show it (Live = the channels view).
  private switchSection(section: Section): void {
    if (section !== 'live' && this.channelList.isEditing) this.channelList.exitEditMode();
    if (section !== 'movies' && section !== 'search') this.movies.deactivate();
    if (section !== 'series' && section !== 'search') this.series.deactivate();
    if (section !== 'search') this.search.deactivate();
    if (section === 'live') {
      if (!this.livePreview.returnFromFullscreen(false)) {
        this.player.stop();
        this.showView('channels');
        this.channelList.render();
      }
      return;
    }
    this.player.stop();
    if (section === 'epg') { this.openEpg(); return; }
    if (section === 'movies') {
      this.showView('movies');
      const account = this.activeXtreamAccount();
      if (account) {
        this.movies.open(account)
          .catch((err) => log.error(
            'Movies open failed',
            'event=xtream.view.open.failed',
            'operation=movies',
            err,
          ));
      }
      return;
    }
    if (section === 'series') {
      this.showView('series');
      const seriesAccount = this.activeXtreamAccount();
      if (seriesAccount) {
        this.series.open(seriesAccount)
          .catch((err) => log.error(
            'Series open failed',
            'event=xtream.view.open.failed',
            'operation=series',
            err,
          ));
      }
      return;
    }
    if (section === 'home') {
      this.showHome();
      return;
    }
    if (section === 'access') {
      this.showView('access');
      this.access.open();
      return;
    }
    if (section === 'settings') {
      this.showPreferences();
      return;
    }
    // Search: keep the current view; the results view only covers it once a
    // query is typed (handleSearchQuery). Remember where to return to.
    if (this.viewStack[this.viewStack.length - 1] !== 'search') {
      this.viewBeforeSearch = this.viewStack[this.viewStack.length - 1];
      // The search looks only through what the screen it started on shows.
      const from = this.viewBeforeSearch;
      this.search.setScope(
        from === 'movies' ? 'movies'
          : from === 'series' ? 'series'
            : from === 'channels' || from === 'epg' || from === 'player' ? 'channels'
              : 'all',
      );
    }
    // Prep the results (loads the catalog once) into the still-hidden search view.
    this.search.open(this.activeXtreamAccount())
      .catch((err) => log.error(
        'Search open failed',
        'event=xtream.view.open.failed',
        'operation=search',
        err,
      ));
  }

  // The tab bar's search box query changed: show the results view over the
  // current one while non-empty; restore the underlying view when cleared.
  private handleSearchQuery(query: string): void {
    this.search.scheduleQuery(query);
    const hasQuery = query.trim().length > 0;
    const onSearch = this.viewStack[this.viewStack.length - 1] === 'search';
    if (hasQuery && !onSearch) this.showView('search');
    else if (!hasQuery && onSearch) this.showView(this.viewBeforeSearch ?? 'channels');
  }

  // The search box was closed: clear it and return to the view it opened from
  // (showView re-syncs the active tab, since the box is already collapsed).
  private handleSearchClose(): void {
    this.search.deactivate();
    this.search.setQuery('');
    const rv = this.viewBeforeSearch ?? 'channels';
    this.viewBeforeSearch = null;
    this.showView(rv);
  }

  // Show the guide and refresh its data in the background (shared by the EPG
  // tab and the red-key shortcut).
  private openEpg(): void {
    this.epgGrid.focusChannel(this.player.getCurrentIndex());
    this.showView('epg');
    this.epgGrid.render();
    const renderEpg = () => {
      this.refreshEpgDependentViews();
      this.epgGrid.render();
    };
    EpgService.refresh(renderEpg).then(() => {
      renderEpg();
    });
  }

  private refreshEpgDependentViews(): void {
    this.applyDisplayTz();
    this.channelList.render();
    this.livePreview.refresh();
    void this.search.refreshPrograms();
  }

  private openReminderManager(origin: 'settings' | 'epg'): void {
    this.reminderManagerOrigin = origin;
    this.showView('reminders');
    this.reminderManager.open();
  }

  // Down/Select from the bar: switch to the section and drop focus into content.
  private enterSection(section: Section): void {
    if (this.isGuarded(section)) {
      this.askPin(() => {
        this.tabBar.setActive(section);
        this.switchSection(section);
      });
      return;
    }
    this.tabBar.setActive(section);
    this.switchSection(section);
  }

  // With parental control on, Settings and Access open only with the PIN: they
  // are where hidden categories can be shown again and the access changed. An
  // expired or blocked device is sent to Access by the app itself, not through here.
  private isGuarded(section: Section): boolean {
    if (!ParentalService.enabled) return false;
    if (section !== 'settings' && section !== 'access') return false;
    const current = this.viewStack[this.viewStack.length - 1];
    // Already inside: moving between the cards and their panes asks nothing.
    if (section === 'settings' && (current === 'prefs' || current === 'settings')) return false;
    return !(section === 'access' && current === 'access');
  }

  private askPin(onUnlocked: () => void): void {
    this.pinPrompt.show({
      title: t('parental.enterPin'),
      hint: t('parental.enterPinHint'),
      length: ParentalService.PIN_LENGTH,
      onSubmit: (pin) => {
        if (!ParentalService.matches(pin)) return t('parental.wrongPin');
        this.pinPrompt.hide();
        onUnlocked();
        return undefined;
      },
      onCancel: () => this.pinPrompt.hide(),
      link: { label: t('parental.forgot'), onSelect: () => this.askDeviceKey(onUnlocked) },
    });
  }

  // The way out of a forgotten PIN: the device key, which the customer can
  // read on the portal and support can read on the panel.
  private askDeviceKey(onUnlocked: () => void): void {
    this.pinPrompt.show({
      title: t('parental.enterKey'),
      hint: t('parental.enterKeyHint'),
      length: 6,
      onSubmit: (key) => {
        const expected = StorageService.getDeviceLink().manageKey ?? '';
        if (!expected || key !== expected) return t('parental.wrongKey');
        ParentalService.disable();
        this.pinPrompt.hide();
        showToast(t('parental.disabled'));
        onUnlocked();
        return undefined;
      },
      onCancel: () => this.pinPrompt.hide(),
    });
  }

  // Playlists carry no rating, so adult content is recognized by the category
  // name. Those categories are hidden like any other: they show up as hidden
  // in Settings, where the PIN holder can bring one back. Returns how many
  // were hidden now.
  private async hideAdultCategories(): Promise<number> {
    let count = 0;
    // What was already hidden once is left alone: the PIN holder may have
    // chosen to show it again.
    const screened = StorageService.getParentalScreened();
    const fresh = (id: string): boolean => {
      if (screened.indexOf(id) !== -1) return false;
      screened.push(id);
      return true;
    };
    const seen: Record<string, true> = {};
    for (const channel of PlaylistService.allChannels) {
      const key = groupKeyOf(channel);
      if (seen[key]) continue;
      seen[key] = true;
      if (!isAdultName(ChannelCustomizationService.groupLabel(key)) && !isAdultName(key)) continue;
      if (!fresh(`live:${key}`) || ChannelCustomizationService.isGroupHidden(key)) continue;
      ChannelCustomizationService.toggleGroupHidden(key);
      count++;
    }
    if (count > 0) {
      PlaylistService.applyCustomization();
      this.player.syncCurrentIndex();
      this.channelList.render();
      this.sidebar.refresh();
    }

    const account = this.activeXtreamAccount();
    if (account) {
      const kinds: Array<'vod' | 'series'> = ['vod', 'series'];
      for (const kind of kinds) {
        try {
          const categories = kind === 'vod'
            ? await loadVodCategories(account)
            : await loadSeriesCategories(account);
          const hidden = StorageService.getHiddenCategories(kind);
          const added = categories
            .map((category) => category.name)
            .filter((name) => isAdultName(name) && fresh(`${kind}:${name}`) && hidden.indexOf(name) === -1);
          if (added.length) {
            StorageService.setHiddenCategories(kind, hidden.concat(added));
            count += added.length;
          }
        } catch (err) {
          log.warn('Adult category screening failed', 'event=parental.screen.failed', `kind=${kind}`, err);
        }
      }
    }
    StorageService.setParentalScreened(screened);
    if (count > 0) this.search.invalidateCatalog();
    return count;
  }

  private toggleParental(): void {
    const done = (message: string): void => {
      this.pinPrompt.hide();
      showToast(message);
      this.preferences.refresh();
    };
    if (ParentalService.enabled) {
      this.pinPrompt.show({
        title: t('parental.enterPin'),
        hint: t('parental.disableHint'),
        length: ParentalService.PIN_LENGTH,
        onSubmit: (pin) => {
          if (!ParentalService.matches(pin)) return t('parental.wrongPin');
          ParentalService.disable();
          done(t('parental.disabled'));
          return undefined;
        },
        onCancel: () => this.pinPrompt.hide(),
        link: { label: t('parental.forgot'), onSelect: () => this.askDeviceKey(() => this.preferences.refresh()) },
      });
      return;
    }
    const askNew = (error = ''): void => {
      this.pinPrompt.show({
        title: t('parental.newPin'),
        hint: error || t('parental.newPinHint'),
        length: ParentalService.PIN_LENGTH,
        onSubmit: (first) => {
          this.pinPrompt.show({
            title: t('parental.confirmPin'),
            hint: t('parental.confirmPinHint'),
            length: ParentalService.PIN_LENGTH,
            onSubmit: (second) => {
              if (second !== first) {
                askNew(t('parental.mismatch'));
                return undefined;
              }
              ParentalService.enable(first);
              this.pinPrompt.hide();
              void this.hideAdultCategories().then((hidden) => {
                showToast(hidden > 0
                  ? tp('parental.enabledHidden', hidden)
                  : t('parental.enabled'));
                this.preferences.refresh();
              });
              return undefined;
            },
            onCancel: () => this.pinPrompt.hide(),
          });
          return undefined;
        },
        onCancel: () => this.pinPrompt.hide(),
      });
    };
    askNew();
  }

  private goLive(): void {
    this.movies.deactivate();
    this.series.deactivate();
    this.search.deactivate();
    this.player.stop();
    this.tabBar.setActive('live');
    this.showView('channels');
    this.channelList.render();
  }

  private activeXtreamAccount(): PlaylistEntry | null {
    const accounts = StorageService.getPlaylists()
      .filter((p) => p.source === 'xtream' && p.xtream && isSourceEnabled(p));
    const selId = StorageService.getSelectedXtreamAccountId();
    return accounts.find((a) => a.id === selId) ?? accounts[0] ?? null;
  }

  private lockToAccess(): void {
    this.player.stop();
    this.sidebar.hide();
    this.menu.hide();
    this.showView('access');
    this.access.open();
  }

  /**
   * Keeps the activation honest while the app runs: re-reads it on a timer, locks
   * the app the moment the panel reports it expired or blocked, and tells the
   * panel the device is online (and what it is playing) once a minute.
   */
  private bindActivationGuard(): void {
    ActivationService.subscribe(() => {
      const current = this.viewStack[this.viewStack.length - 1];
      if (ActivationService.locked && current !== 'access') this.lockToAccess();
    });
    setInterval(() => {
      if (document.hidden) return;
      void ActivationService.refresh()
        .then((changed) => {
          // The Access screen reloads on its own polls; elsewhere a changed playlist is applied here.
          if (changed && this.viewStack[this.viewStack.length - 1] !== 'access') {
            void this.onSettingsSaved('reload');
          }
        })
        .catch(err => log.warn('Activation re-check failed:', err));
    }, CONFIG.XSOL.ACTIVATION_RECHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => this.syncHeartbeat());
    this.syncHeartbeat();
  }

  private syncHeartbeat(): void {
    if (document.hidden) {
      if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      return;
    }
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), CONFIG.XSOL.HEARTBEAT_INTERVAL_MS);
  }

  private sendHeartbeat(): void {
    // Only a registered device has anything to report; registering is the activation check's job.
    if (!StorageService.getDeviceLink().secret) return;
    PanelClient.heartbeat(this.watchingNow())
      .catch(err => log.debug('Heartbeat failed:', err));
  }

  // What the panel shows as "watching now"; null clears it.
  private watchingNow(): WatchingInfo | null {
    const current = this.viewStack[this.viewStack.length - 1];
    const playing = current === 'player' || this.player.isInLivePreview();
    if (!playing || this.player.isVod()) return null;
    const channel = this.player.getCurrentChannel();
    return channel ? { type: 'live', title: channel.name } : null;
  }

  private showHome(): void {
    // A preview already running in the channel list carries over into the home card.
    if (!this.player.isInLivePreview()) this.player.stop();
    this.showView('home');
    // A locked device was sent to Access instead.
    if (this.viewStack[this.viewStack.length - 1] !== 'home') return;
    this.home.open();
    this.startHomePreview();
  }

  // Plays the last channel, muted, inside the "where you left off" card. It
  // follows the Live preview setting: off means the card stays a still.
  private startHomePreview(): void {
    if (this.viewStack[this.viewStack.length - 1] !== 'home') return;
    const last = this.homeData().lastWatched;
    const channel = last ? PlaylistService.getByIndex(last.index) : null;
    if (!StorageService.getLivePreview() || !last || !channel) {
      if (this.player.isInLivePreview()) this.player.stop();
      return;
    }
    this.player.enterLivePreview();
    const playing = this.player.getLivePlaybackSnapshot();
    if (!playing || channelKey(playing.channel) !== channelKey(channel)
        || playing.channel.url !== channel.url) {
      this.player.play(last.index);
    }
    const now = this.player.getLivePlaybackSnapshot();
    if (now && !now.muted) {
      this.player.togglePreviewMute();
      this.homePreviewMuted = true;
    }
    this.homePreviewActive = true;
    this.homePresentation?.showPreview();
  }

  // CH+/CH- on the home screen change what the card is playing, same as in the
  // player: the card's channel becomes the new "last watched" one.
  private tuneHomePreview(delta: 1 | -1): boolean {
    if (!this.homePreviewActive) return false;
    if (delta > 0) this.player.channelUp();
    else this.player.channelDown();
    const now = this.player.getLivePlaybackSnapshot();
    if (now && !now.muted) {
      this.player.togglePreviewMute();
      this.homePreviewMuted = true;
    }
    this.home.refresh();
    return true;
  }

  private leaveHomePreview(): void {
    if (!this.homePreviewActive) return;
    this.homePreviewActive = false;
    // Hand the video back unstyled: the channel list or the full-screen player lays it out next.
    this.homePresentation?.showFullscreen();
    if (this.homePreviewMuted) {
      this.homePreviewMuted = false;
      if (this.player.isInLivePreview()) this.player.togglePreviewMute();
    }
  }

  // Continue: when the card is already playing that channel, grow it to full
  // screen instead of starting the stream over.
  private resumeFromHome(index: number): void {
    const channel = PlaylistService.getByIndex(index);
    const playing = this.player.getLivePlaybackSnapshot();
    if (this.homePreviewActive && channel && playing
        && channelKey(playing.channel) === channelKey(channel)
        && playing.channel.url === channel.url) {
      this.showView('player');
      this.player.showOSD();
      return;
    }
    this.playChannel(index);
  }

  // Back out of a screen that has no parent of its own: to home, or to the
  // channel list when the app is set to start there.
  private showPreferences(): void {
    this.panesFromCards = false;
    this.showView('prefs');
    this.preferences.open();
  }

  // A card opens the pane that holds its detailed options.
  private openSettingsPane(pane: PreferencePane): void {
    this.panesFromCards = true;
    this.showView('settings');
    this.settings.render(pane);
  }

  private leaveToStart(): void {
    if (StorageService.getStartView() === 'home' && StorageService.getPlaylists().length > 0) {
      this.showHome();
    } else {
      this.goLive();
    }
  }

  private confirmExit(): void {
    const now = Date.now();
    if (now - this.backPressTime < 3000) {
      void this.exitApp();
    } else {
      this.backPressTime = now;
      showToast(t('app.exitHint'));
    }
  }

  private homeData(): HomeData {
    const toHome = (index: number): HomeChannel | null => {
      const channel = PlaylistService.getByIndex(index);
      return channel ? { index, name: channel.name, group: channel.group, logo: channel.logo } : null;
    };
    // The index alone defaults to 0, which would present the first channel as
    // "last watched" on an install that never played anything.
    const lastKey = StorageService.getLastChannelKey();
    const lastIndex = lastKey
      ? PlaylistService.resolveLastChannelIndex(lastKey, StorageService.getLastChannel())
      : -1;
    const featured: HomeChannel[] = [];
    const taken: Record<number, boolean> = {};
    const add = (index: number): void => {
      if (index < 0 || taken[index] || featured.length >= 4) return;
      const item = toHome(index);
      if (!item) return;
      taken[index] = true;
      featured.push(item);
    };
    const recent = RecentlyWatchedService.getItems();
    for (let i = 0; i < recent.length; i++) add(recent[i].channelIndex);
    for (let i = 0; featured.length < 4 && i < PlaylistService.channels.length; i++) add(i);
    return {
      lastWatched: lastIndex >= 0 ? toHome(lastIndex) : null,
      featured,
      hasXtream: this.activeXtreamAccount() !== null,
    };
  }

  private async homeUserExpiry(): Promise<number | null | undefined> {
    const account = this.activeXtreamAccount();
    if (!account || !account.xtream) return undefined;
    const info = await createXtreamClient({
      baseUrl: account.url,
      username: account.xtream.username,
      password: account.xtream.password,
    }, account.id).getAccountInfo();
    return info ? info.expiresAt : undefined;
  }

  private playChannel(index: number, catchup?: CatchupInfo, scope: ChannelScope | null = null): void {
    this.showView('player');
    this.player.play(index, catchup, scope);
  }

  private bindReminderLifecycle(): void {
    setInterval(() => this.scanReminders(), CONFIG.REMINDER_SCAN_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scanReminders();
    });
    // "Watch now" on a dev-mode reminder alert relaunches us with a channel key.
    document.addEventListener('webOSRelaunch', (e) => {
      this.handleLaunchParams((e as CustomEvent).detail);
    });
  }

  private coldLaunchParams(): unknown {
    const w = window as unknown as { PalmSystem?: { launchParams?: string } };
    return w.PalmSystem?.launchParams;
  }

  private handleLaunchParams(raw: unknown): void {
    const idx = ReminderService.resolveLaunchChannel(raw);
    if (idx >= 0) {
      log.info('Reminder launch — tuning channel index', idx);
      this.playChannel(idx);
    }
  }

  private scanReminders(): void {
    ReminderService.prune();
    // Dev mode: the interactive system alert is the single notification path,
    // so skip the in-app prompt (prune still runs to clean up ended reminders).
    if (ReminderService.devMode) return;
    this.showNextReminder();
  }

  private showNextReminder(): void {
    if (this.reminderPrompt.visible) return;
    const due = ReminderService.dueNow();
    const r = due[0];
    if (!r) return;
    this.reminderPrompt.show(
      truncate(r.title, CONFIG.REMINDER.TITLE_MAX),
      truncate(r.channelName, CONFIG.REMINDER.CHANNEL_MAX),
      {
      onConfirm: () => {
        ReminderService.remove(r.channelKey, r.startMs);
        const idx = ReminderService.resolveChannelIndex(r.channelKey);
        if (idx >= 0) this.playChannel(idx);
        this.showNextReminder();
      },
      onCancel: () => {
        ReminderService.remove(r.channelKey, r.startMs);
        if (this.viewStack[this.viewStack.length - 1] === 'reminders') {
          this.reminderManager.open();
        }
        this.showNextReminder();
      },
    });
  }

  // Which modal/overlay is holding input, for the key diagnostic timeline: a
  // "button does nothing" report is usually an unexpected consumer, not a lost key.
  private keyConsumer(currentView: string): string {
    if (this.reminderPrompt.visible) return 'reminder_prompt';
    if (this.epgGrid.isPromptVisible) return 'epg_prompt';
    if (this.settings.isPromptVisible) return 'settings_prompt';
    if (this.reminderManager.isPromptVisible) return 'reminder_manager_prompt';
    if (this.tabBar.focused) return 'tab_bar';
    if (currentView === 'player' && this.player.subtitleOffsetOpen()) return 'subtitle_offset';
    return `view_${currentView}`;
  }

  private handleKey(action: Action, event?: NumberEvent): void {
    const currentView = this.viewStack[this.viewStack.length - 1];

    log.debug('Key routed', 'event=key.action', `action=${action}`,
      `view=${currentView}`, `consumer=${this.keyConsumer(currentView)}`,
      `number=${event ? String(event.number) : 'none'}`);

    // The digit OSD is body-mounted and outlives every view, so an abandoned
    // entry must be cleared before a modal gets a chance to swallow this.
    if (action === 'number_cancel') {
      hideNumberEntry();
      return;
    }

    // A reminder prompt overlays every view and consumes input first.
    // The PIN entry is modal over everything else.
    if (this.pinPrompt.visible) {
      this.pinPrompt.handleAction(action, event);
      return;
    }
    if (this.reminderPrompt.visible) {
      this.reminderPrompt.handleAction(action);
      return;
    }

    // The catch-up resume prompt is body-mounted but logically inside the EPG;
    // consume all actions (including back/blue globals) while it is visible.
    if (this.epgGrid.isPromptVisible) {
      this.epgGrid.handleAction(action, event);
      return;
    }

    if (this.settings.isPromptVisible) {
      this.settings.handleAction(action);
      return;
    }
    if (this.reminderManager.isPromptVisible) {
      this.reminderManager.handleAction(action);
      return;
    }

    // The docked tab bar consumes input while it holds focus.
    if (this.tabBar.focused) {
      this.tabBar.handleAction(action);
      return;
    }

    // The subtitle-sync adjuster is modal over the player: it consumes all input.
    if (currentView === 'player' && this.player.subtitleOffsetOpen()) {
      this.player.handleSubtitleOffsetAction(action);
      return;
    }

    // Direct channel entry: echo the digits while KeyHandler buffers them, in
    // the two views that act on them (the guide and prompts ignore numbers).
    if (action === 'number_input') {
      if (currentView === 'channels' || currentView === 'player') {
        showNumberEntry(event?.digits ?? '');
      }
      return;
    }
    if (action === 'number') hideNumberEntry();

    // Global shortcuts
    // While the channel list is in edit mode the color keys belong to the editor.
    const editingChannels = currentView === 'channels' && this.channelList.isEditing;
    // Pressed again where it already leads, a colour key steps back out.
    if ((action === 'red' && currentView === 'epg') || (action === 'blue' && (currentView === 'settings' || currentView === 'prefs'))) {
      this.handleKey('back');
      return;
    }
    if (action === 'red' && currentView !== 'epg' && !editingChannels) {
      this.sidebar.hide();
      this.menu.hide();
      this.player.stop();
      this.openEpg();
      return;
    }
    if (action === 'blue' && currentView !== 'settings' && !editingChannels) {
      if (currentView === 'epg') this.epgGrid.deactivateFilters();
      this.sidebar.hide();
      this.menu.hide();
      this.player.stop();
      this.enterSection('settings');
      return;
    }
    if (action === 'green' && currentView === 'player' && (this.sidebar.visible || this.menu.visible)) {
      this.togglePlayingFavorite();
      return;
    }
    if (action === 'yellow' && currentView === 'player') {
      this.player.showOSD();
      return;
    }

    // Back handling
    if (action === 'back') {
      if (currentView === 'player') {
        if (this.sidebar.visible) {
          if (!this.sidebar.handleBack()) this.sidebar.hide();
        } else if (this.menu.visible) {
          // Let the menu step out of its audio sub-menu before closing.
          if (!this.menu.handleBack()) this.menu.hide();
        } else if (!this.livePreview.returnFromFullscreen(true)) {
          this.player.handleAction('back');
        }
        return;
      }
      if (currentView === 'movies') { this.movies.handleAction('back'); return; }
      if (currentView === 'series') { this.series.handleAction('back'); return; }
      if (currentView === 'search') { this.search.handleAction('back'); return; }
      if (currentView === 'access') { this.access.handleAction('back'); return; }
      if (currentView === 'home') { this.home.handleAction('back'); return; }
      if (currentView === 'prefs') { this.preferences.handleAction('back'); return; }
      if (currentView === 'epg') {
        if (this.epgGrid.isFilterOpen) {
          this.epgGrid.handleAction('back');
          return;
        }
        this.epgGrid.deactivateFilters();
        this.tabBar.setActive('live');
        this.channelList.render();
        this.showView('channels');
        return;
      }
      if (currentView === 'settings') {
        if (this.settings.dismissDropdown()) return;
        // Opened from a card: Back leads to the cards again.
        if (this.panesFromCards) { this.showPreferences(); return; }
        this.tabBar.setActive('live');
        this.channelList.render();
        this.showView('channels');
        return;
      }
      if (currentView === 'reminders') {
        this.reminderManager.handleAction('back');
        return;
      }
      if (currentView === 'channels') {
        if (this.livePreview.handleBack()) return;
        if (this.channelList.handleBack()) return;
        // With a home screen, Back from the list returns to it; exiting is Back from home.
        if (StorageService.getStartView() === 'home') this.showHome();
        else this.confirmExit();
        return;
      }
    }

    // Delegate to active view
    switch (currentView) {
      case 'channels': {
        if (this.livePreview.handleAction(action)) break;
        const moved = this.channelList.handleAction(action, event);
        if (action === 'up' && !moved && this.tabBar.shown) this.tabBar.focus();
        break;
      }
      case 'movies':
        this.movies.handleAction(action);
        break;
      case 'series':
        this.series.handleAction(action);
        break;
      case 'search':
        this.search.handleAction(action);
        break;
      case 'access':
        this.access.handleAction(action);
        break;
      case 'home':
        this.home.handleAction(action);
        break;
      case 'prefs':
        this.preferences.handleAction(action);
        break;
      case 'player':
        if (this.player.isVod()) {
          // A VOD menu (opened by the pointer) captures D-pad nav; Left closes
          // it. Otherwise D-pad drives VOD playback (seek / pause / OSD).
          if (this.menu.visible) {
            if (action === 'up' || action === 'down' || action === 'select') this.menu.handleAction(action);
            else if (action === 'left') this.menu.hide();
          } else {
            this.player.handleAction(action, event);
          }
          break;
        }
        // While the OSD is up on seekable catch-up, Left/Right seek instead of
        // opening the sidebar/menu (which stay reachable once the OSD hides).
        if ((action === 'left' || action === 'right')
            && !this.sidebar.visible && !this.menu.visible && this.player.canSeek()) {
          this.player.handleAction(action, event);
          break;
        }
        if (action === 'left') {
          if (this.menu.visible) this.menu.hide();
          else if (this.sidebar.visible) this.sidebar.handleAction(action);
          else this.sidebar.show();
        } else if (action === 'right') {
          if (this.sidebar.visible) this.sidebar.handleAction(action);
          else if (this.menu.visible) this.menu.hide();
          else this.menu.show();
        } else if (this.sidebar.visible && (
          action === 'up' || action === 'down' ||
          action === 'channel_up' || action === 'channel_down' ||
          action === 'select'
        )) {
          this.sidebar.handleAction(action);
        } else if (this.menu.visible && (
          action === 'up' || action === 'down' || action === 'select'
        )) {
          this.menu.handleAction(action);
        } else {
          this.player.handleAction(action, event);
        }
        break;
      case 'epg':
        this.epgGrid.handleAction(action, event);
        break;
      case 'settings':
        if (action === 'back' && this.panesFromCards) {
          this.showPreferences();
        } else if (action === 'back') {
          this.channelList.render();
          this.showView('channels');
        } else {
          this.settings.handleAction(action);
        }
        break;
      case 'reminders':
        this.reminderManager.handleAction(action);
        break;
    }
  }

  private initSidebarTrigger(): void {
    document.addEventListener('pointermove', (e: PointerEvent) => {
      const currentView = this.viewStack[this.viewStack.length - 1];
      if (currentView !== 'player') return;

      const osd = $('#player-osd', this.views.player);
      const osdRect = osd?.getBoundingClientRect();
      const overOsd = !!osd && !osd.classList.contains('hidden') && !!osdRect
        && e.clientY >= osdRect.top;

      // VOD (movies/series) has no channels and no live menu — only the OSD
      // (title + seek bar) is pointer-revealable; suppress the channel sidebar
      // and the live player menu.
      const vod = this.player.isVod();

      // Protect the full-width area beside and below the OSD too: its edge
      // controls sit next to margins where an imprecise cursor can open a panel.
      if (!overOsd && !vod && e.clientX < 80 && !this.menu.visible) {
        this.sidebar.show();
        this.sidebar.handlePointerMove(e.clientX, false);
      } else if (this.sidebar.visible) {
        const overSidebar = !!(e.target as HTMLElement).closest('.player-sidebar');
        const delayingDismiss = this.sidebar.handlePointerMove(e.clientX, overSidebar);
        if (!delayingDismiss && !overSidebar
            && e.clientX > this.sidebar.pointerDismissX && !this.sidebar.keyboardOn) {
          // Never dismiss while the keyboard is on — the pointer naturally
          // leaves the sidebar on its way to the on-screen keyboard.
          this.sidebar.hide();
        }
      }

      // Right menu. Live/catch-up and VOD alike; for VOD it shows the VOD action
      // set (Info, Settings) plus any audio/subtitle tracks — the channel rows
      // are hidden, so it's never empty.
      if (!overOsd && e.clientX > 1840 && !this.sidebar.visible) {
        this.menu.show();
      } else if (this.menu.visible) {
        const overMenu = !!(e.target as HTMLElement).closest('.player-menu');
        if (overMenu) {
          this.menu.resetTimer();
        } else if (e.clientX < 1540) {
          this.menu.hide();
        }
      }

      // Bottom OSD info bar
      if (e.clientY > 900 && !this.sidebar.visible && !this.menu.visible) {
        this.player.showOSD();
      }
    });
  }

  private onMenuAction(action: Action): void {
    if (action === 'green') {
      this.togglePlayingFavorite();
    } else if (action === 'yellow') {
      this.player.showOSD();
    } else {
      this.handleKey(action);
    }
  }

  private togglePlayingFavorite(): void {
    const ch = this.player.getCurrentChannel();
    if (!ch) return;
    this.toggleChannelFavorite(ch);
  }

  private toggleChannelFavorite(ch: Channel): void {
    const key = channelKey(ch);
    StorageService.toggleFavorite(key);
    showToast(StorageService.getFavorites().includes(key)
      ? t('channel.favoriteAdded', { name: ch.name })
      : t('channel.favoriteRemoved', { name: ch.name }));
    this.channelList.render();
    this.sidebar.refresh();
  }


  private async onSettingsSaved(action: SaveAction): Promise<void> {
    if (action === 'edit-channels') {
      this.tabBar.setActive('live');
      this.showView('channels');
      this.channelList.render();
      this.channelList.enterEditMode('builtin:all');
      return;
    }
    if (action === 'reset') {
      await clearAllCachedData();
      await StorageService.clearUserData();
      StorageService.clearAll();
      log.info(
        'App reset completed',
        'event=persistence.reset.completed',
        'operation=clear',
      );
      location.reload();
      return;
    }
    if (action !== 'cancel') {
      const locale = resolveLocale(StorageService.getLocalePreference());
      if (locale !== getLocale()) {
        setLocale(locale);
        this.tabBar.refresh();
        ReminderService.reschedulePending();
      }
    }
    if (action === 'reload') {
      this.search.invalidateCatalog();
      await Promise.all([clearCachedPlaylist(), clearCachedCatalog()]);
      this.showView('channels');
      await this.loadData(true);
      return;
    }
    // 'apply': only display settings changed — re-apply + re-render, no re-fetch.
    if (action === 'apply') {
      this.search.invalidateCatalog();
      this.applyDisplayTz();
      this.epgGrid.resetDay();
      this.scheduleEpgRefresh();
      this.schedulePlaylistRefresh();
    }
    this.channelList.render();
    if (this.panesFromCards) {
      this.showPreferences();
      return;
    }
    this.showView('channels');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  installGlobalErrorHandlers();
  logEnvironment(CONFIG.VERSION);
  const app = new App();
  app.init().catch(err => log.error('App init failed:', err));
});
