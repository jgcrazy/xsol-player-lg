import { CONFIG } from '../config';
import { t } from '../i18n';
import { EpgService } from '../services/epg-service';
import { PlaylistService } from '../services/playlist-service';
import { StorageService } from '../services/storage-service';
import type {
  Action,
  CatchupInfo,
  Channel,
  ChannelScope,
  LivePlaybackSnapshot,
  Programme,
} from '../types';
import { channelKey } from '../utils/channel';
import { html, raw, show, hide, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { isSourceEnabled } from '../utils/playlist';
import { addDisplayDays, formatTime, startOfDisplayDay } from '../utils/time';
import type { ChannelList } from './channel-list';
import {
  favoriteIcon,
  FULLSCREEN_ICON,
  VOLUME_ICON,
  VOLUME_MUTED_ICON,
} from './icons';
import { liveBadge } from './live-badge';
import type { Player } from './player';
import { PlayerPresentation } from './player-presentation';
import { showToast } from './toast';

type PreviewHostView = 'channels' | 'player' | string;

export interface LivePreviewOptions {
  /** Placeholder column shown while Live preview is on and nothing is playing. */
  idleContainer?: HTMLElement | null;
  channelView: HTMLElement;
  player: Player;
  channelList: ChannelList;
  getCurrentView: () => PreviewHostView;
  showChannels: (preserveFocus: boolean) => void;
  showPlayer: () => void;
  playFullscreen: (
    index: number,
    catchup?: CatchupInfo,
    scope?: ChannelScope | null,
  ) => void;
  blurTabBar: () => void;
  expansionBlocked: () => boolean;
  isFavorite: (channel: Channel) => boolean;
  toggleFavorite: (channel: Channel) => void;
}

type PreviewControl = 'favorite' | 'mute' | 'fullscreen';

export class LivePreview {
  private state: LivePlaybackSnapshot | null = null;
  private control: PreviewControl | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly presentation: PlayerPresentation;
  private channelSet: Channel[] | null = null;
  private channelKey = '';
  private channelAvailable = true;
  private managingList = false;
  private dayAnchor = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly options: LivePreviewOptions,
  ) {
    this.presentation = new PlayerPresentation(
      () => options.player.getVideoElement(),
      () => this.slot,
    );
    container.setAttribute('data-self-activate', '');
    container.addEventListener('nav:hover', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest<HTMLElement>('[data-preview-action]')?.dataset.previewAction;
      if (action === 'favorite' || action === 'mute' || action === 'fullscreen') this.focus(action);
    });
    container.addEventListener('nav:unhover', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest<HTMLElement>('[data-preview-action]')?.dataset.previewAction;
      if (action !== this.control) return;
      this.blur();
      this.options.channelList.setPreviewFocused(false);
    });
    container.addEventListener('click', event => {
      const target = event.target;
      if (!this.state || !(target instanceof Element)) return;
      const action = target.closest<HTMLElement>('[data-preview-action]')?.dataset.previewAction;
      if (action === 'favorite') {
        this.focus('favorite');
        this.toggleFavorite();
      } else if (action === 'mute') {
        this.focus('mute');
        this.options.player.togglePreviewMute();
      } else if (action === 'fullscreen' || target.closest('.live-preview-slot')) {
        this.expand();
      }
    });
  }

  get isShowing(): boolean { return this.state !== null; }

  private get focused(): boolean { return this.control !== null; }

  private get slot(): HTMLElement | null {
    return this.container.querySelector('.live-preview-slot');
  }

  hintState(): 'off' | 'ready' | 'active' {
    if (!StorageService.getLivePreview()) return 'off';
    return this.options.player.getLivePlaybackSnapshot() ? 'active' : 'ready';
  }

  beforeViewChange(view: PreviewHostView): void {
    const { player } = this.options;
    // The home screen keeps a preview going in its own card; every other view ends it.
    if (view !== 'channels' && view !== 'player' && view !== 'home' && player.isInLivePreview()) {
      player.stop();
    }
    if (view === 'player') player.exitLivePreview();
  }

  selectChannel(
    index: number,
    catchup?: CatchupInfo,
    scope: ChannelScope | null = null,
    mode: 'preview' | 'expand-current' | 'fullscreen' = 'preview',
  ): void {
    if (!StorageService.getLivePreview() || catchup || mode === 'fullscreen') {
      this.options.playFullscreen(index, catchup, scope);
      return;
    }
    const channel = PlaylistService.getByIndex(index);
    if (!channel) return;
    this.options.blurTabBar();
    const current = this.options.player.getLivePlaybackSnapshot();
    if (mode === 'expand-current' && this.isShowing && current
        && channelKey(current.channel) === channelKey(channel)
        && current.channel.url === channel.url) {
      this.expand();
      return;
    }
    this.options.player.enterLivePreview();
    if (!current || channelKey(current.channel) !== channelKey(channel)
        || current.channel.url !== channel.url) {
      this.options.player.play(index, undefined, scope);
    }
    this.options.channelList.render(false);
    this.refresh();
  }

  focusControls(): boolean {
    if (this.options.channelList.isEditing) return false;
    return this.focus();
  }

  leaveControls(restoreListFocus: boolean): void {
    this.blur();
    this.options.channelList.setPreviewFocused(false);
    if (restoreListFocus) this.options.channelList.restoreFocus();
  }

  handleAction(action: Action): boolean {
    if (action === 'stop' && this.isShowing) {
      this.close();
      return true;
    }
    if (!this.options.channelList.isEditing && this.handleControlAction(action)) return true;
    return false;
  }

  handleBack(): boolean {
    if (this.handleControlAction('back')) return true;
    if (!this.isShowing) return false;
    this.close();
    return true;
  }

  close(): void {
    if (!this.isShowing && !this.options.player.isInLivePreview()) return;
    this.leaveControls(false);
    this.options.player.stop();
  }

  returnFromFullscreen(restoreListFocus: boolean): boolean {
    if (!StorageService.getLivePreview()
        || !this.options.player.getLivePlaybackSnapshot()) return false;
    this.options.player.enterLivePreview();
    this.options.showChannels(restoreListFocus);
    this.options.channelList.setPlaying(this.options.player.getCurrentIndex());
    this.options.channelList.render(false);
    if (restoreListFocus) {
      requestAnimationFrame(() => {
        if (this.options.getCurrentView() === 'channels'
            && this.options.player.isInLivePreview()) {
          this.options.channelList.highlightEntryPoint();
        }
      });
    }
    return true;
  }

  canResumePlayback(): boolean {
    const { player } = this.options;
    if (!player.isInLivePreview()) return true;
    const state = player.getLivePlaybackSnapshot();
    if (!StorageService.getLivePreview()) return false;
    if (state && !this.isChannelAvailable(state.channel)) {
      showToast(t('preview.sourceUnavailable'));
      return false;
    }
    return true;
  }

  /** The list editor needs the full width; the idle column steps aside while it is open. */
  setManagingList(managing: boolean): void {
    if (this.managingList === managing) return;
    this.managingList = managing;
    this.syncIdle();
  }

  // With Live preview on, the third column is part of the layout from the start:
  // until a channel is playing it holds a placeholder instead of leaving the list
  // to reflow the moment one is picked. A separate element, so the real panel's
  // visibility keeps meaning "something is playing here".
  private syncIdle(): void {
    const idle = this.options.idleContainer;
    if (!idle) return;
    const shouldIdle = this.options.getCurrentView() === 'channels'
      && StorageService.getLivePreview()
      && !this.isShowing
      && !this.managingList;
    this.options.channelView.classList.toggle('has-idle-preview', shouldIdle);
    if (!shouldIdle) {
      hide(idle);
      return;
    }
    morph(idle, html`
      <div class="live-preview-heading" data-key="idle-heading">
        <span class="live-preview-channel">${t('preview.idleTitle')}</span>
      </div>
      <div class="live-preview-idle-slot" data-key="idle-slot">
        <p class="live-preview-idle-hint">${t('preview.idleHint')}</p>
      </div>
    `);
    show(idle);
  }

  refresh(): void {
    this.refreshPanel();
    this.syncIdle();
  }

  private refreshPanel(): void {
    const { channelView, player } = this.options;
    const currentView = this.options.getCurrentView();
    if (currentView === 'home') {
      // The home card places the video itself; this panel only has to step back,
      // without resetting a layout it does not own.
      channelView.classList.remove('has-live-preview');
      this.options.channelList.setPreviewFocused(false);
      this.applyState(null);
      return;
    }
    const state = player.getLivePlaybackSnapshot();
    if (state && player.isInLivePreview() && !StorageService.getLivePreview()) {
      player.stop();
      return;
    }
    const shouldShow = currentView === 'channels' && StorageService.getLivePreview() && !!state;
    if (shouldShow && state && !this.isChannelAvailable(state.channel)) {
      player.stop();
      showToast(t('preview.sourceUnavailable'));
      return;
    }
    const wasShowing = this.isShowing;
    channelView.classList.toggle('has-live-preview', shouldShow);
    if (shouldShow && state) this.show(state);
    else this.hidePreview(currentView, state, wasShowing);
  }

  refreshLayout(): void {
    this.presentation.refresh();
    if (this.state) this.fitPrograms();
  }

  private applyState(state: LivePlaybackSnapshot | null): void {
    this.state = state;
    if (!state) {
      this.control = null;
      hide(this.container);
      this.stopRefreshTimer();
      return;
    }
    show(this.container);
    this.render();
    if (this.timer === null && !document.hidden) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.refresh();
      }, CONFIG.PLAYER.LIVE_PREVIEW_REFRESH_MS - Date.now() % CONFIG.PLAYER.LIVE_PREVIEW_REFRESH_MS);
    }
  }

  suspend(): void {
    this.presentation.refresh();
    this.stopRefreshTimer();
  }

  private stopRefreshTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private focus(control: PreviewControl = 'mute'): boolean {
    if (!this.state) return false;
    this.control = control;
    this.options.blurTabBar();
    this.options.channelList.setPreviewFocused(true);
    this.render();
    return true;
  }

  private blur(): void {
    if (!this.control) return;
    this.control = null;
    this.render();
  }

  private handleControlAction(action: Action): boolean {
    if (!this.focused) return false;
    if (action === 'back') {
      this.close();
    } else if (action === 'left'
        && (this.control === 'mute' || this.control === 'favorite')) {
      this.leaveControls(true);
    } else if (action === 'left' && this.control === 'fullscreen') {
      this.focus('mute');
    } else if (action === 'right' && this.control === 'mute') {
      this.focus('fullscreen');
    } else if (action === 'up' && this.control !== 'favorite') {
      this.focus('favorite');
    } else if (action === 'down' && this.control === 'favorite') {
      this.focus('fullscreen');
    } else if (action === 'select') {
      if (this.control === 'favorite') this.toggleFavorite();
      else if (this.control === 'mute') this.options.player.togglePreviewMute();
      else this.expand();
    } else if (action === 'green') {
      this.toggleFavorite();
    } else if (action !== 'up' && action !== 'down') {
      return false;
    }
    return true;
  }

  private toggleFavorite(): void {
    if (!this.state) return;
    this.options.toggleFavorite(this.state.channel);
    this.render();
  }

  private expand(): void {
    if (!this.isShowing || this.options.channelList.isEditing
        || this.options.expansionBlocked()) return;
    this.options.blurTabBar();
    this.leaveControls(false);
    this.options.showPlayer();
    this.options.player.showOSD();
  }

  private isChannelAvailable(channel: Channel): boolean {
    const enabledSources = StorageService.getPlaylists()
      .filter(isSourceEnabled).map(source => source.id);
    if (!channel.playlistIds.some(id => enabledSources.includes(id))) return false;
    const key = channelKey(channel);
    if (this.channelSet !== PlaylistService.allChannels || this.channelKey !== key) {
      this.channelSet = PlaylistService.allChannels;
      this.channelKey = key;
      this.channelAvailable = PlaylistService.allChannels
        .some(item => channelKey(item) === key);
    }
    return this.channelAvailable || PlaylistService.hasFailedSource(
      channel.playlistIds.filter(id => enabledSources.includes(id)),
    );
  }

  private show(state: LivePlaybackSnapshot): void {
    this.options.player.enterLivePreview();
    this.applyState(state);
    this.presentation.showPreview();
  }

  private hidePreview(
    currentView: PreviewHostView,
    state: LivePlaybackSnapshot | null,
    wasShowing: boolean,
  ): void {
    const restoreListFocus = this.focused && currentView === 'channels';
    this.options.channelList.setPreviewFocused(false);
    if (wasShowing && currentView === 'player' && state) {
      this.stopRefreshTimer();
      this.presentation.showFullscreen();
    } else if (currentView !== 'player' || !state) {
      this.presentation.showFullscreen();
    }
    this.applyState(null);
    if (wasShowing && !state) {
      this.options.channelList.setPlaying(-1);
      this.options.channelList.render(false);
    }
    if (restoreListFocus) this.options.channelList.restoreFocus();
  }

  private programTimeRange(program: Programme): string {
    return `${formatTime(program.start)}\u2013${formatTime(program.stop)}`;
  }

  // The whole display day, not just what is next: rows already aired stay in the
  // list (dimmed) and the one on air is marked, so the guide can be read against
  // what is playing.
  private renderDay(programmes: Programme[], now: number): Safe {
    return html`${programmes.map(item => {
      const start = item.start.getTime();
      const stop = item.stop.getTime();
      const phase = stop <= now ? 'is-past' : start <= now ? 'is-current' : 'is-upcoming';
      return html`
        <div class="live-preview-program ${phase}"
             data-key="program:${start}:${stop}">
          <time>${this.programTimeRange(item)}</time><span>${item.title}</span>
        </div>`;
    })}`;
  }

  private render(): void {
    const state = this.state;
    if (!state) return;
    const now = new Date();
    const epgId = EpgService.findChannelId(state.channel);
    const program = epgId ? EpgService.getNowPlaying(epgId) : null;
    const dayStart = startOfDisplayDay(now);
    const today = epgId
      ? EpgService.getProgrammesIntersectingRange(
          epgId, dayStart.getTime(), addDisplayDays(dayStart, 1).getTime(),
        ).filter(item => item.stop.getTime() > item.start.getTime())
      : [];
    const length = program ? program.stop.getTime() - program.start.getTime() : 0;
    const fraction = program && length > 0
      ? Math.max(0, Math.min(1, (now.getTime() - program.start.getTime()) / length)) : 0;
    const remaining = program
      ? Math.max(0, Math.ceil((program.stop.getTime() - now.getTime()) / 60000)) : 0;
    const favorite = this.options.isFavorite(state.channel);
    const muteLabel = t(state.muted ? 'preview.unmute' : 'preview.mute');
    const message = state.status === 'loading' ? t('common.loading')
      : state.status === 'buffering' ? t('preview.connecting')
      : state.status === 'error' ? t('player.streamError') : '';
    morph(this.container, html`
      <div class="live-preview-heading" data-key="preview-heading">
        <span class="live-preview-channel">${state.channel.name}</span>
        <button class="live-preview-favorite ${this.control === 'favorite' ? 'focused' : ''}"
                data-key="preview-favorite" data-focusable data-preview-action="favorite"
                aria-label="${t('player.toggleFavorite')}" aria-pressed="${String(favorite)}">
          ${raw(favoriteIcon(favorite))}
        </button>
        <time class="live-preview-clock" datetime="${formatTime(now)}">${formatTime(now)}</time>
      </div>
      <div class="live-preview-slot" data-key="preview-slot" aria-label="${t('preview.fullScreen')}">
        ${liveBadge('live-preview-badge')}
        ${message ? html`
          <div class="live-preview-message"
               data-key="preview-message">${message}</div>` : ''}
        <div class="live-preview-controls" data-key="preview-controls" data-nav-container>
          <button class="live-preview-button ${this.control === 'mute' ? 'focused' : ''}"
                  data-key="preview-mute" data-focusable data-preview-action="mute"
                  aria-label="${muteLabel}" aria-pressed="${String(state.muted)}">
            ${raw(state.muted ? VOLUME_MUTED_ICON : VOLUME_ICON)}
          </button>
          <button class="live-preview-button ${this.control === 'fullscreen' ? 'focused' : ''}"
                  data-key="preview-fullscreen" data-focusable data-preview-action="fullscreen"
                  aria-label="${t('preview.fullScreen')}">
            ${raw(FULLSCREEN_ICON)}
          </button>
        </div>
        ${this.control === 'mute' || this.control === 'fullscreen' ? html`
          <div class="live-preview-legend" data-key="preview-legend">
            <span class="live-preview-hint"><span class="live-preview-key">OK</span>
              <span class="live-preview-hint-label">${
              this.control === 'mute' ? muteLabel : t('preview.fullScreen')
            }</span></span>
          </div>` : ''}
      </div>
      <div class="live-preview-details" data-key="preview-details">
        ${program ? html`<h2 class="live-preview-title">${program.title}</h2>` : ''}
        ${program && length > 0 ? html`
          <div class="live-preview-schedule">
            <time class="live-preview-time-range">${this.programTimeRange(program)}</time>
            <span class="live-preview-remaining">${t('preview.timeLeft', { minutes: remaining })}</span>
          </div>
          <div class="live-preview-progress" role="progressbar" aria-label="${program.title}"
               aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(fraction * 100)}">
            <div style="width:${fraction * 100}%"></div>
          </div>` : ''}
        ${today.length ? html`
          <h3 class="live-preview-day-title" data-key="preview-day-title">${t('preview.today')}</h3>
          <div class="live-preview-upcoming" data-key="preview-day">
            ${this.renderDay(today, now.getTime())}
          </div>` : html`<p class="live-preview-empty" data-key="preview-empty">${t('preview.noGuide')}</p>`}
      </div>
    `);
    this.fitPrograms();
  }

  // Brings the programme on air to the top of the day list. Only when the channel
  // or the current programme changes: the list re-renders every second, and a user
  // who scrolled back through the day must not be yanked forward each time.
  private fitPrograms(): void {
    const list = this.container.querySelector<HTMLElement>('.live-preview-upcoming');
    const state = this.state;
    if (!list || !state) {
      this.dayAnchor = '';
      return;
    }
    const current = list.querySelector<HTMLElement>('.live-preview-program.is-current')
      ?? list.querySelector<HTMLElement>('.live-preview-program.is-upcoming');
    const anchor = `${channelKey(state.channel)}|${current?.dataset.key ?? ''}`;
    if (anchor === this.dayAnchor) return;
    if (list.getBoundingClientRect().height <= 0) return;
    this.dayAnchor = anchor;
    if (!current) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    list.scrollTop += current.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }
}
