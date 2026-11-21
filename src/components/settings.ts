import type { Action, ChannelCycleMode, EpgSource, ManualEpgSource, NavDirection, PlaylistEntry, TzMode } from '../types';
import { $, $$, html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { SpatialNav } from '../navigation/spatial-nav';
import {
  NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS,
  LIVE_RECONNECT_ATTEMPT_OPTIONS,
  PLAYER_OSD_TIMEOUT_MS_OPTIONS,
  REFRESH_INTERVAL_HOUR_OPTIONS,
  StorageService,
  XTREAM_CATALOG_REFRESH_HOUR_OPTIONS,
} from '../services/storage-service';
import { accessChoices } from '../services/xsol/activation-service';
import { EpgService } from '../services/epg-service';
import { ChannelCustomizationService } from '../services/channel-customization';
import { PlaylistService } from '../services/playlist-service';
import {
  clearAllCachedData,
  getCacheUsage,
  type CacheUsageSummary,
} from '../services/idb-cache';
import { ReminderService } from '../services/reminder-service';
import {
  ChannelHealthService,
  type ChannelHealthProgress,
} from '../services/channel-health';
import { createXtreamClient } from '../services/xtream-client';
import { normalizeXtreamBaseUrl, normalizeXtreamLiveOutputPreference } from '../utils/xtream-url';
import { genPlaylistId, isSourceEnabled } from '../utils/playlist';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { formatEpgOffset } from '../utils/epg-offset';
import { CONFIG } from '../config';
import { OVERLAY_STYLES, TEXT_SIZES, DEFAULT_TEXT_SIZE, type OverlayStyle, type TextSize } from '../config/themes';
import { applyTextSize } from '../services/theme-service';
import { showToast } from './toast';
import { ConfirmationPrompt } from './confirmation-prompt';
import { createLogger } from '../utils/logger';
import {
  formatNumber,
  localeOptions,
  t,
  tp,
  type LocalePreference,
  type TextMessageKey,
} from '../i18n';
import {
  ANIMATION_MODES,
  applyAnimationMode,
  type AnimationMode,
} from '../services/motion-service';
import { CHEVRON_DOWN, CHEVRON_LEFT_ICON, CHEVRON_UP } from './icons';

const log = createLogger('Settings');

type EpgScopePlaylist = Pick<PlaylistEntry, 'id' | 'name' | 'url'>;

/** "UTC+08:00" / "UTC-05:00" / "UTC" for a feed offset in minutes. */
function formatOffset(min: number): string {
  if (!min) return 'UTC';
  const sign = min > 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function correctedTime(min: number): string {
  const total = 20 * 60 + min;
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function correctionPreview(min: number): Safe {
  return html`${t('settings.timeCorrectionExample')}: 20:00 -> ${correctedTime(min)}`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** A single-select toggle group: connected buttons, the active one filled.
 *  Shared by every toggle row (styled via .toggle-group in settings.css). */
function toggleGroup(id: string, options: { value: string; label: string }[], active: string) {
  return html`
    <div class="toggle-group" id="${id}">
      ${options.map(o => html`
        <button class="toggle-option ${o.value === active ? 'active' : ''}"
                data-focusable data-value="${o.value}">${o.label}</button>
      `)}
    </div>`;
}

/** Preferred-subtitle-language options for the online-subtitle search ranking.
 *  '' = no preference. Endonyms render on the TV's fonts (Latin/Cyrillic/CJK/Hangul). */
function subtitleLanguages(): { value: string; label: string }[] {
  return [
    { value: '', label: t('settings.any') },
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'pt', label: 'Português' },
    { value: 'ru', label: 'Русский' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
  ];
}

function languageOptions(): { value: LocalePreference; label: string }[] {
  return [
    { value: 'system', label: t('settings.languageSystem') },
    ...localeOptions(),
  ];
}

function languageHeading(): string {
  const localized = t('settings.language');
  return localized === 'Language' ? localized : `${localized} / Language`;
}

function refreshIntervalOptions(): { value: string; label: string }[] {
  return REFRESH_INTERVAL_HOUR_OPTIONS.map(hours => ({
    value: String(hours),
    label: hours === 0
      ? t('common.off')
      : tp('settings.refreshHours', hours),
  }));
}

function xtreamCatalogRefreshIntervalOptions(): { value: string; label: string }[] {
  return XTREAM_CATALOG_REFRESH_HOUR_OPTIONS.map(hours => ({
    value: String(hours),
    label: tp('settings.refreshHours', hours),
  }));
}

const ANIMATION_MODE_LABELS: Record<AnimationMode, TextMessageKey> = {
  essential: 'settings.animationEssential',
  reduced: 'settings.animationReduced',
  full: 'settings.animationFull',
};

function animationModeOptions(): { value: AnimationMode; label: string }[] {
  return ANIMATION_MODES.map(value => ({
    value,
    label: t(ANIMATION_MODE_LABELS[value]),
  }));
}

function timeoutOptions(values: readonly number[]): { value: string; label: string }[] {
  return values.map(value => {
    const seconds = value / 1000;
    return {
      value: String(value),
      label: tp('settings.durationSeconds', seconds, {
        seconds: formatNumber(seconds, { maximumFractionDigits: 1 }),
      }),
    };
  });
}

export type SettingsCategory = 'sources' | 'channels' | 'guide' | 'appearance'
  | 'playback' | 'subtitles' | 'data';

const SETTINGS_CATEGORIES: readonly { id: SettingsCategory; label: TextMessageKey }[] = [
  { id: 'sources', label: 'settings.sources' },
  { id: 'channels', label: 'settings.channels' },
  { id: 'guide', label: 'settings.guide' },
  { id: 'appearance', label: 'settings.appearance' },
  { id: 'playback', label: 'settings.playback' },
  { id: 'subtitles', label: 'settings.onlineSubtitles' },
  { id: 'data', label: 'settings.dataManagement' },
];

/** One option on a line: what it is on the left, its control on the right. */
function optionRow(title: string, control: Safe, hint: Safe | string = '', modifier = ''): Safe {
  return html`
    <div class="settings-item settings-option ${modifier}">
      <div class="settings-option-text">
        <div class="settings-item-title">${title}</div>
        ${hint ? html`<div class="settings-item-hint">${hint}</div>` : ''}
      </div>
      <div class="settings-option-control">${control}</div>
    </div>`;
}

/** Custom single-select dropdown — remote/D-pad friendly and app-styled (the app
 *  uses no native `<select>`). The trigger toggles the menu; each option carries a
 *  `data-dropdown-value`; the chosen value lives on the root's `data-value`. */
function dropdown(id: string, options: { value: string; label: string }[], active: string) {
  const current = options.find(o => o.value === active) ?? options[0];
  return html`
    <div class="dropdown" id="${id}" data-value="${active}">
      <span class="dropdown-sizer" aria-hidden="true">
        ${options.map(o => html`<span>${o.label}</span>`)}
      </span>
      <button class="dropdown-trigger" data-focusable data-dropdown-trigger>
        <span class="dropdown-current">${current.label}</span>
        <span class="dropdown-caret"></span>
      </button>
      <div class="dropdown-menu">
        ${options.map(o => html`
          <button class="dropdown-option ${o.value === active ? 'active' : ''}"
                  data-focusable data-dropdown-value="${o.value}">${o.label}</button>
        `)}
      </div>
    </div>`;
}

function disabledDropdown(id: string, label: string): Safe {
  return html`
    <div class="dropdown epg-offset-unavailable" id="${id}" data-value="">
      <span class="dropdown-sizer" aria-hidden="true"><span>${label}</span></span>
      <button class="dropdown-trigger" disabled>
        <span class="dropdown-current">${label}</span>
        <span class="dropdown-caret"></span>
      </button>
    </div>`;
}

function sourceToggle(enabled: boolean): Safe {
  return html`
    <button class="source-toggle ${enabled ? 'active' : ''}" data-focusable
            data-enabled="${enabled ? 'true' : 'false'}"
            aria-pressed="${enabled ? 'true' : 'false'}">
      <span class="source-toggle-track" aria-hidden="true">
        <span class="source-toggle-knob"></span>
      </span>
      <span class="source-toggle-label">${t(enabled ? 'settings.on' : 'settings.off')}</span>
    </button>`;
}

function withEnabledState(entry: PlaylistEntry, enabled: boolean): PlaylistEntry {
  if (!enabled) return { ...entry, enabled: false };
  const copy = { ...entry };
  delete copy.enabled;
  return copy;
}

/** One editable Xtream account: its fields grouped in a card
 *  keyed by the entry's stable id. Untrusted values interpolate through `html`. */
function xtreamCard(pl: Partial<PlaylistEntry>) {
  const liveOutput = normalizeXtreamLiveOutputPreference(pl.xtream?.liveOutput);
  const enabled = pl.enabled !== false;
  return html`
    <div class="xtream-card ${enabled ? '' : 'source-disabled'}"
         data-id="${pl.id || ''}" data-source-entry>
      <div class="xtream-managed-name">${pl.name || ''}</div>
      <div class="xtream-fields">
        <div class="settings-field xtream-field-private">
          <label>${t('settings.label')}</label>
          <input type="text" class="settings-input xtream-name" data-focusable
                 aria-label="${t('settings.accountLabel')}" placeholder="${t('settings.myProvider')}" value="${pl.name || ''}">
        </div>
        <div class="settings-field wide xtream-field-private">
          <label>${t('settings.serverUrl')}</label>
          <input type="text" class="settings-input xtream-url" data-focusable
                 aria-label="${t('settings.serverUrl')}" placeholder="http://host:port" value="${pl.url || ''}">
        </div>
        <div class="settings-field xtream-field-private">
          <label>${t('settings.username')}</label>
          <input type="text" class="settings-input xtream-username" data-focusable
                 aria-label="${t('settings.username')}" placeholder="${t('settings.username')}" value="${pl.xtream?.username || ''}">
        </div>
        <div class="settings-field xtream-field-private">
          <label>${t('settings.password')}</label>
          <input type="password" class="settings-input xtream-password" data-focusable
                 aria-label="${t('settings.password')}" placeholder="${t('settings.password')}" value="${pl.xtream?.password || ''}">
        </div>
        <div class="settings-field xtream-output">
          <label>${t('settings.streamFormat')}</label>
          ${dropdown(`xtream-output-${pl.id || ''}`, [
            { value: 'ts', label: t('settings.streamFormatTs') },
            { value: 'm3u8', label: t('settings.streamFormatHls') },
            { value: 'auto', label: t('settings.streamFormatAuto') },
          ], liveOutput)}
        </div>
      </div>
      <div class="xtream-card-foot">
        ${sourceToggle(enabled)}
        <button class="btn btn-secondary check-xtream" data-focusable>${t('settings.check')}</button>
        <button class="btn btn-danger remove-xtream" data-focusable>${t('common.remove')}</button>
        <div class="xtream-status"></div>
      </div>
    </div>`;
}

function manualEpgSourceRow(
  source: ManualEpgSource,
  playlists: EpgScopePlaylist[],
  index: number,
  sourceCount: number,
): Safe {
  const canMoveEarlier = index > 0;
  const canMoveLater = index < sourceCount - 1;
  return html`
    <div class="manual-epg-source" data-manual-epg-source data-key="manual-epg-${index}">
      <div class="manual-epg-source-head">
        <span class="manual-epg-priority">${index + 1}</span>
        <input type="text" class="settings-input manual-epg-url" data-focusable
               aria-label="${t('settings.xmltvUrl')}" value="${source.url}"
               placeholder="http://host/guide.xml">
        <button class="btn btn-secondary move-epg-earlier"
                ${raw(canMoveEarlier ? 'data-focusable' : 'disabled')}
                aria-label="${t('settings.moveEarlier')}">${raw(CHEVRON_UP)}</button>
        <button class="btn btn-secondary move-epg-later"
                ${raw(canMoveLater ? 'data-focusable' : 'disabled')}
                aria-label="${t('settings.moveLater')}">${raw(CHEVRON_DOWN)}</button>
        <button class="btn btn-danger remove-epg-source" data-focusable>
          ${t('common.remove')}
        </button>
      </div>
      <div class="manual-epg-scope">
        <span class="manual-epg-scope-label">${t('settings.epgAppliesTo')}</span>
        ${manualEpgScopeOptions(source, playlists)}
      </div>
    </div>`;
}

function manualEpgScopeOptions(
  source: ManualEpgSource,
  playlists: EpgScopePlaylist[],
): Safe {
  const allPlaylists = source.playlistIds.length === 0;
  return html`
    <div class="manual-epg-scope-options">
      <button class="epg-scope-option ${allPlaylists ? 'active' : ''}"
              data-focusable data-scope-all>
        ${t('settings.allPlaylists')}
      </button>
      ${playlists.map(playlist => html`
        <button class="epg-scope-option ${
          source.playlistIds.includes(playlist.id) ? 'active' : ''
        }" data-focusable data-playlist-id="${playlist.id}">
          ${playlist.name || playlist.url}
        </button>
      `)}
    </div>`;
}

/** "expires 2026-08-01" (UTC) or "never expires" for a unix-seconds expiry. */
function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return t('settings.neverExpires');
  const d = new Date(expiresAt * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return t('settings.expires', {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
  });
}

/** What the app does after Settings closes: reload = re-fetch playlist/EPG;
 *  apply = re-render for display-only changes; reset = erase local app data;
 *  edit-channels = open the channel list in edit mode; cancel = discard. */
export type SaveAction = 'reload' | 'apply' | 'reset' | 'cancel' | 'edit-channels';

export class Settings {
  private container: HTMLElement;
  private onSave: (action: SaveAction) => void | Promise<void>;
  private onChannelsChanged: () => void;
  private nav: SpatialNav;
  private epgOffsets: Record<string, number> = {};
  private storedEpgOffsets: Record<string, number> = {};
  private confirmationPrompt = new ConfirmationPrompt();
  private watchlistAccount: PlaylistEntry | null = null;
  private onManageReminders: () => void;
  private healthController: AbortController | null = null;
  private healthCheckPromise: Promise<void> | null = null;
  private healthProgress: ChannelHealthProgress | null = null;
  private healthPaused = false;
  private healthResume: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    onSave: (action: SaveAction) => void | Promise<void>,
    onChannelsChanged: () => void = () => {},
    onManageReminders: () => void = () => {},
  ) {
    this.container = container;
    this.onSave = onSave;
    this.onChannelsChanged = onChannelsChanged;
    this.onManageReminders = onManageReminders;
    this.nav = new SpatialNav(container, (el) => this.onNavFocus(el));

    // Mouse/pointer support: clicking a focusable element behaves like remote OK.
    // Attached once on the persistent container (render() replaces innerHTML).
    // Marked `data-self-activate` so the global click handler skips this subtree
    // (this local handler is the "OK" action).
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const openDropdown = this.container.querySelector<HTMLElement>('.dropdown.open');
      if (openDropdown && target.closest('.dropdown') !== openDropdown) {
        this.closeDropdown(openDropdown);
      }
      const el = target.closest<HTMLElement>('[data-focusable]');
      if (!el) return;
      this.nav.focus(el);
      this.activate(el);
    });

    // Enter on input: commit and move to next focusable element in DOM order.
    // Attached once on the persistent container (render() replaces innerHTML).
    this.container.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
        e.preventDefault();
        (e.target as HTMLInputElement).blur();
        const all = Array.from(this.container.querySelectorAll<HTMLElement>('[data-focusable]'));
        const idx = all.indexOf(e.target as HTMLElement);
        const next = all[idx + 1];
        if (next) this.nav.focus(next);
      }
    });

    this.container.addEventListener('input', (e: Event) => {
      const input = e.target as HTMLInputElement;
      if (input.classList.contains('manual-epg-url')) {
        this.refreshEpgOffsetEditor(this.manualEpgSourcesFromEditor(), input.value.trim());
      } else if (
        input.classList.contains('playlist-name')
        || input.classList.contains('playlist-url')
        || input.classList.contains('xtream-name')
        || input.classList.contains('xtream-url')
      ) {
        this.refreshManualEpgScopes();
      }
    });

  }

  render(category: SettingsCategory = 'sources'): void {
    const allPlaylists = StorageService.getPlaylists();
    const playlists = allPlaylists.filter(pl => pl.source !== 'xtream');
    const accounts = allPlaylists.filter(pl => pl.source === 'xtream');
    const enabledAccounts = accounts.filter(isSourceEnabled);
    const selectedAccountId = StorageService.getSelectedXtreamAccountId();
    this.watchlistAccount = enabledAccounts.find((account) => account.id === selectedAccountId)
      ?? enabledAccounts[0] ?? null;
    // Accesses delivered by the panel are managed on the Access screen: here
    // only the stream format of the one in use is offered, and no server address.
    const managedSources = accessChoices() !== null;
    const manualEpgSources = StorageService.getManualEpgSources();
    this.storedEpgOffsets = StorageService.getEpgOffsets();
    this.epgOffsets = { ...this.storedEpgOffsets };
    const epgSources = this.epgSources(manualEpgSources, allPlaylists);
    const autoPlay = StorageService.getAutoPlay();
    const livePreview = StorageService.getLivePreview();
    const channelCycleMode = StorageService.getChannelCycleMode();
    const showHidden = StorageService.getShowHiddenChannels();
    const feedTime = StorageService.getTzMode() === 'feed';
    const tzOffset = StorageService.getEpgTzOffset();
    const os = StorageService.getOnlineSubtitleConfig();
    const overlayStyle = StorageService.getOverlayStyle();
    const textSize = StorageService.getTextSize();
    const localePreference = StorageService.getLocalePreference();
    const liveReconnectAttempts = StorageService.getLiveReconnectAttempts();
    const numberEntryOsdTimeoutMs = StorageService.getNumberEntryOsdTimeoutMs();
    const playerOsdTimeoutMs = StorageService.getPlayerOsdTimeoutMs();
    const animationMode = StorageService.getAnimationMode();
    const playlistRefreshHours = StorageService.getPlaylistRefreshIntervalHours();
    const epgRefreshHours = StorageService.getEpgRefreshIntervalHours();
    const xtreamCatalogRefreshHours = StorageService.getXtreamCatalogRefreshIntervalHours();
    const overlayStyles = OVERLAY_STYLES.map(option => ({
      value: option.value,
      label: t(option.value === 'dark' ? 'settings.overlayDark' : 'settings.overlayFrosted'),
    }));
    const textSizes = TEXT_SIZES.map(size => ({
      value: size,
      label: size === DEFAULT_TEXT_SIZE ? t('settings.textSizeDefault', { percent: size }) : `${size}%`,
    }));

    const onOff = [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }];
    const sectionTitle = SETTINGS_CATEGORIES.filter(item => item.id === category)[0];

    this.container.innerHTML = String(html`
      <div class="settings-view">
        <header class="settings-head" data-nav-container>
          <button class="settings-back" data-focusable id="settings-back"
                  aria-label="${t('common.back')}">${raw(CHEVRON_LEFT_ICON)}</button>
          <div class="settings-head-text">
            <div class="settings-eyebrow">${t('common.settings')}</div>
            <h2 class="settings-title" id="settings-pane-title">${sectionTitle ? t(sectionTitle.label) : ''}</h2>
          </div>
        </header>

        <div class="settings-main">
          <div class="settings-scroll">
            <div class="settings-category ${managedSources ? 'sources-managed' : ''}"
                 id="settings-sources" data-settings-category="sources">
              <div class="settings-section">
                <h3 class="settings-section-title">${t(managedSources ? 'settings.sources' : 'settings.xtreamAccount')}</h3>
                <div class="xtream-entries" id="xtream-entries">
                  ${accounts.length
                    ? html`${accounts.map((pl) => xtreamCard(pl))}`
                    : html`<div class="empty-hint">${t('settings.noXtream')}</div>`}
                </div>
                <button class="btn btn-primary" data-focusable id="add-xtream">${t('settings.addXtream')}</button>
                <div class="settings-item-hint">
                  <strong>${t('settings.streamFormat')}:</strong> ${t('settings.streamFormatHint')}
                </div>
              </div>

              <div class="settings-section settings-section-playlists">
                <h3 class="settings-section-title">${t('settings.playlists')}</h3>
                <div class="playlist-entries" id="playlist-entries">
                  ${playlists.length
                    ? html`
                      <div class="settings-row playlist-header-row">
                        <div class="settings-field"><label>${t('settings.name')}</label></div>
                        <div class="settings-field"><label>${t('settings.url')}</label></div>
                        <div class="playlist-header-spacer"></div>
                      </div>
                      ${playlists.map((pl) => html`
                      <div class="settings-row ${isSourceEnabled(pl) ? '' : 'source-disabled'}"
                           data-id="${pl.id}" data-source-entry>
                        <div class="settings-field">
                          <input type="text" class="settings-input playlist-name"
                                 aria-label="${t('settings.playlistName')}" placeholder="${t('settings.myPlaylist')}"
                                 data-focusable value="${pl.name || ''}">
                        </div>
                        <div class="settings-field">
                          <input type="text" class="settings-input playlist-url"
                                 aria-label="${t('settings.playlistUrl')}" placeholder="https://...m3u"
                                 data-focusable value="${pl.url || ''}">
                        </div>
                        ${sourceToggle(isSourceEnabled(pl))}
                        <button class="btn btn-danger remove-playlist" data-focusable>${t('common.remove')}</button>
                      </div>
                    `)}`
                    : html`<div class="empty-hint">${t('settings.noPlaylists')}</div>`}
                </div>
                <button class="btn btn-primary" data-focusable id="add-playlist">${t('settings.addPlaylist')}</button>
              </div>
            </div>

            <div class="settings-category" id="settings-channels" data-settings-category="channels">
              <div class="settings-section" id="channel-customization-settings">
                <div class="settings-panel">
                  ${this.channelHealthPanel()}
                  ${optionRow(
                    t('settings.editChannelList'),
                    html`<button class="btn btn-secondary" data-focusable id="edit-channel-list"
                                 aria-label="${t('settings.editChannelList')}">${t('settings.editChannelList')}</button>`,
                    t('settings.editChannelListHint'),
                    'settings-item--action',
                  )}
                  ${optionRow(
                    t('settings.showHidden'),
                    toggleGroup('show-hidden', onOff, showHidden ? 'on' : 'off'),
                    t('settings.showHiddenHint'),
                  )}
                  ${optionRow(
                    t('settings.resetCustomization'),
                    html`<button class="btn btn-danger" data-focusable id="reset-customization"
                                 aria-label="${t('settings.resetCustomization')}">${t('settings.resetCustomization')}</button>`,
                    t('settings.resetCustomizationHint'),
                    'settings-item--action',
                  )}
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-guide" data-settings-category="guide">
              <div class="settings-section">
                <div class="settings-panel">
                  ${optionRow(
                    t('settings.timeZone'),
                    toggleGroup('tz-mode', [{ value: 'device', label: t('settings.device') }, { value: 'feed', label: t('settings.feed') }], feedTime ? 'feed' : 'device'),
                    tzOffset === null
                      ? t('settings.timeZoneUnknown')
                      : t('settings.timeZoneKnown', { offset: formatOffset(tzOffset) }),
                  )}
                  <div class="settings-item settings-block">
                    <div class="settings-item-title">${t('settings.timeCorrection')}</div>
                    <div class="settings-item-hint">${t('settings.timeCorrectionHint')}</div>
                    <div class="epg-offset-editor">
                      ${this.epgOffsetEditor(epgSources, allPlaylists, epgSources[0]?.url)}
                    </div>
                  </div>
                  ${optionRow(
                    t('reminderManager.title'),
                    html`<button class="btn btn-secondary" data-focusable id="manage-reminders">
                      ${t('settings.manageReminders', {
                        count: ReminderService.listManageable().length,
                      })}
                    </button>`,
                    '',
                    'settings-item--action',
                  )}
                </div>
              </div>
              <div class="settings-section">
                <h3 class="settings-section-title">${t('settings.manualEpgSources')}</h3>
                <div class="settings-panel"><div class="settings-item settings-block">
                  <div class="manual-epg-sources">
                    ${manualEpgSources.length
                      ? manualEpgSources.map((source, index) =>
                        manualEpgSourceRow(
                          source,
                          allPlaylists,
                          index,
                          manualEpgSources.length,
                        ))
                      : html`<div class="empty-hint">${t('settings.noEpgSources')}</div>`}
                  </div>
                  <button class="btn btn-primary" data-focusable id="add-epg-source">
                    <span class="btn-add-icon" aria-hidden="true">+</span>${t('settings.addEpgSource')}
                  </button>
                  <div class="settings-item-hint">${t('settings.xmltvUrlsHint')}</div>
                </div></div>
              </div>
            </div>

            <div class="settings-category" id="settings-appearance" data-settings-category="appearance">
              <div class="settings-section">
                <div class="settings-panel">
                  ${optionRow(
                    languageHeading(),
                    dropdown('app-language', languageOptions(), localePreference),
                    t('settings.languageHint'),
                  )}
                  ${optionRow(t('settings.textSize'), dropdown('text-size', textSizes, textSize))}
                  ${optionRow(
                    t('settings.overlayGlass'),
                    toggleGroup('overlay-style', overlayStyles, overlayStyle),
                    t('settings.overlayHint'),
                  )}
                  ${optionRow(
                    t('settings.animationMode'),
                    toggleGroup('animation-mode', animationModeOptions(), animationMode),
                    t('settings.animationHint'),
                  )}
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-playback" data-settings-category="playback">
              <div class="settings-section">
                <div class="settings-panel">
                  ${optionRow(
                    t('settings.autoPlay'),
                    toggleGroup('auto-play', onOff, autoPlay ? 'on' : 'off'),
                  )}
                  ${optionRow(
                    t('settings.livePreview'),
                    toggleGroup('live-preview-setting', onOff, livePreview ? 'on' : 'off'),
                    t('settings.livePreviewHint'),
                  )}
                  ${optionRow(
                    t('settings.channelCycleMode'),
                    toggleGroup('channel-cycle-mode', [
                      { value: 'global', label: t('settings.channelCycleGlobal') },
                      { value: 'active', label: t('settings.channelCycleActive') },
                    ], channelCycleMode),
                    t('settings.channelCycleModeHint'),
                  )}
                  ${optionRow(
                    t('settings.liveReconnectAttempts'),
                    dropdown(
                      'live-reconnect-attempts',
                      LIVE_RECONNECT_ATTEMPT_OPTIONS.map(value => ({
                        value: String(value), label: String(value),
                      })),
                      String(liveReconnectAttempts),
                    ),
                    t('settings.liveReconnectHint'),
                  )}
                  ${optionRow(
                    t('settings.numberEntryOsdTimeout'),
                    dropdown(
                      'number-entry-osd-timeout',
                      timeoutOptions(NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS),
                      String(numberEntryOsdTimeoutMs),
                    ),
                    t('settings.numberEntryOsdTimeoutHint'),
                  )}
                  ${optionRow(
                    t('settings.playerOsdTimeout'),
                    dropdown(
                      'player-osd-timeout',
                      timeoutOptions(PLAYER_OSD_TIMEOUT_MS_OPTIONS),
                      String(playerOsdTimeoutMs),
                    ),
                    t('settings.playerOsdTimeoutHint'),
                  )}
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-subtitles" data-settings-category="subtitles">
              <div class="settings-section">
                <div class="settings-panel">
                  ${optionRow(
                    t('settings.preferredSubtitle'),
                    dropdown('os-pref-lang', subtitleLanguages(), os.preferredLanguage),
                  )}
                  <div class="settings-item settings-block">
                    <div class="settings-row">
                      <div class="settings-field wide">
                        <label><span class="settings-domain">SubDL.com</span> ${t('settings.apiKey')}</label>
                        <input type="text" class="settings-input" data-focusable id="subdl-key"
                               value="${os.subdl.apiKey}" placeholder="${t('settings.apiKey')}">
                      </div>
                    </div>
                  </div>
                  <div class="settings-item settings-block">
                    <div class="settings-row">
                      <div class="settings-field wide">
                        <label><span class="settings-domain">Assrt.net</span> ${t('settings.assrtToken')}</label>
                        <input type="text" class="settings-input" data-focusable id="assrt-key"
                               value="${os.assrt.apiKey}" placeholder="${t('settings.assrtToken')}">
                        <div class="settings-item-hint">${t('settings.assrtDescription')}</div>
                      </div>
                    </div>
                  </div>
                  <div class="settings-item settings-block">
                    <div class="settings-row">
                      <div class="settings-field">
                        <label><span class="settings-domain">OpenSubtitles.com</span> ${t('settings.apiKey')}</label>
                        <input type="text" class="settings-input" data-focusable id="os-key"
                               value="${os.opensubtitles.apiKey}" placeholder="${t('settings.apiKey')}">
                      </div>
                      <div class="settings-field">
                        <label>${t('settings.username')}</label>
                        <input type="text" class="settings-input" data-focusable id="os-user"
                               value="${os.opensubtitles.username}" placeholder="${t('settings.username')}">
                      </div>
                      <div class="settings-field">
                        <label>${t('settings.password')}</label>
                        <input type="password" class="settings-input" data-focusable id="os-pass"
                               value="${os.opensubtitles.password}" placeholder="${t('settings.password')}">
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-category" id="settings-data" data-settings-category="data">
              <div class="settings-columns">
                <div class="settings-column">
                  <div class="settings-section">
                    <h3 class="settings-section-title">${t('settings.advancedGroupBackgroundRefresh')}</h3>
                    <div class="settings-panel">
                      ${optionRow(
                        t('settings.playlistRefreshInterval'),
                        dropdown('playlist-refresh-interval', refreshIntervalOptions(), String(playlistRefreshHours)),
                        t('settings.playlistRefreshHint', { action: t('settings.refreshAll') }),
                      )}
                      ${optionRow(
                        t('settings.epgRefreshInterval'),
                        dropdown('epg-refresh-interval', refreshIntervalOptions(), String(epgRefreshHours)),
                        t('settings.epgRefreshHint', { action: t('settings.refreshAll') }),
                      )}
                      ${enabledAccounts.length ? optionRow(
                        t('settings.xtreamCatalogRefreshInterval'),
                        dropdown(
                          'xtream-catalog-refresh-interval',
                          xtreamCatalogRefreshIntervalOptions(),
                          String(xtreamCatalogRefreshHours),
                        ),
                        t('settings.xtreamCatalogRefreshHint', { action: t('settings.refreshAll') }),
                      ) : ''}
                    </div>
                  </div>
                  <div class="settings-section">
                    <h3 class="settings-section-title">${t('settings.dataManagement')}</h3>
                    <div class="settings-panel">
                      ${optionRow(
                        t('channel.recentlyWatched'),
                        html`<button class="btn btn-danger" data-focusable id="clear-recently-watched"
                                     aria-label="${t('settings.clearRecentlyWatched')}">${t('settings.clearRecentlyWatched')}</button>`,
                        t('settings.clearRecentDescription'),
                        'settings-item--action',
                      )}
                      ${this.watchlistAccount ? optionRow(
                        t('common.watchlist'),
                        html`<button class="btn btn-danger" data-focusable id="clear-watchlist"
                                     aria-label="${t('settings.clearWatchlist')}">${t('settings.clearWatchlist')}</button>`,
                        t('settings.clearWatchlistDescription', { account: this.watchlistAccount.name }),
                        'settings-item--action',
                      ) : ''}
                      ${optionRow(
                        t('settings.resetApp'),
                        html`<button class="btn btn-danger" data-focusable id="reset-app"
                                     aria-label="${t('settings.resetApp')}">${t('settings.resetApp')}</button>`,
                        t('settings.resetAppDescription'),
                        'settings-item--action settings-reset',
                      )}
                    </div>
                  </div>
                </div>
                <div class="settings-column settings-column-side">
                  <div class="cache-usage" id="cache-usage" aria-live="polite">
                    <div class="cache-usage-loading">${t('common.loading')}</div>
                  </div>
                  <div class="settings-maintenance">
                    <button class="btn btn-secondary" data-focusable id="refresh-data">${t('settings.refreshAll')}</button>
                    <button class="btn btn-danger" data-focusable id="clear-cache">${t('settings.clearCache')}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-actions" data-nav-container>
            <button class="btn btn-secondary btn-large" data-focusable id="cancel-settings">${t('common.cancel')}</button>
            <button class="btn btn-primary btn-large" data-focusable id="save-settings">${t('settings.saveApply')}</button>
          </div>
        </div>
      </div>
    `);

    this.openCategory(category);
    void this.loadCacheUsage();
  }

  private epgSources(manualSources: ManualEpgSource[], playlists: PlaylistEntry[]): EpgSource[] {
    const enabledIds = new Set(playlists.filter(isSourceEnabled).map(source => source.id));
    const discovered = PlaylistService.epgSources
      .map(source => ({
        ...source,
        playlistIds: source.playlistIds.filter(id => enabledIds.has(id)),
      }))
      .filter(source => source.playlistIds.length > 0);
    const sources: EpgSource[] = manualSources.map(source => ({
      ...source,
      kind: 'manual',
    }));
    for (const source of discovered) {
      const existing = sources.find(candidate => candidate.url === source.url);
      if (!existing) {
        sources.push(source);
      } else if (existing.playlistIds.length) {
        for (const id of source.playlistIds) {
          if (!existing.playlistIds.includes(id)) existing.playlistIds.push(id);
        }
      }
    }
    return sources;
  }

  private epgSourceOptions(
    sources: EpgSource[],
    playlists: PlaylistEntry[],
  ): { value: string; label: string }[] {
    const names = new Map(playlists.map(source => [source.id, source.name || source.url]));
    const fallbackLabels = sources.map(source => {
      const labels = source.playlistIds
        .map(id => names.get(id))
        .filter((name): name is string => Boolean(name));
      return source.kind === 'manual'
        ? t('settings.manualXmltv')
        : labels.join(', ') || t('settings.discoveredEpg');
    });
    const sourceNames = sources.map(source => EpgService.getSourceName(source.url));
    const baseLabels = sources.map((_source, index) =>
      sourceNames[index] || fallbackLabels[index]);
    return sources.map((source, index) => {
      const base = baseLabels[index];
      const duplicateIndexes = baseLabels
        .map((label, candidate) => label === base ? candidate : -1)
        .filter(candidate => candidate >= 0);
      if (duplicateIndexes.length === 1) return { value: source.url, label: base };
      const qualified = sourceNames[index] ? `${base} — ${fallbackLabels[index]}` : base;
      const qualifiedLabels = duplicateIndexes.map(candidate =>
        sourceNames[candidate]
          ? `${baseLabels[candidate]} — ${fallbackLabels[candidate]}`
          : baseLabels[candidate]);
      const duplicateIndex = duplicateIndexes.indexOf(index) + 1;
      return {
        value: source.url,
        label: qualifiedLabels.filter(label => label === qualified).length === 1
          ? qualified
          : `${qualified} — EPG ${duplicateIndex}`,
      };
    });
  }

  private epgOffsetEditor(
    sources: EpgSource[],
    playlists: PlaylistEntry[],
    selectedUrl?: string,
  ): Safe {
    const selected = sources.some(source => source.url === selectedUrl)
      ? selectedUrl as string
      : sources[0]?.url;
    const offset = selected ? this.epgOffsets[selected] ?? 0 : 0;
    return html`
      <div class="epg-offset-controls">
        ${selected
          ? dropdown('epg-offset-source', this.epgSourceOptions(sources, playlists), selected)
          : disabledDropdown('epg-offset-source', t('settings.manualXmltv'))}
        <div class="epg-offset-stepper ${selected ? '' : 'epg-offset-unavailable'}">
          ${selected
            ? html`
              <button class="btn btn-secondary epg-offset-step" data-focusable
                      data-offset-delta="-${CONFIG.EPG.OFFSET_STEP_MINUTES}"
                      aria-label="${t('settings.offsetEarlier')}">-</button>
              <button class="btn btn-secondary epg-offset-value" data-focusable
                      aria-label="${t('settings.offsetReset')}">
                ${formatEpgOffset(offset)}
              </button>
              <button class="btn btn-secondary epg-offset-step" data-focusable
                      data-offset-delta="${CONFIG.EPG.OFFSET_STEP_MINUTES}"
                      aria-label="${t('settings.offsetLater')}">+</button>
            `
            : html`
              <button class="btn btn-secondary epg-offset-step" disabled>-</button>
              <button class="btn btn-secondary epg-offset-value" disabled>
                ${formatEpgOffset(0)}
              </button>
              <button class="btn btn-secondary epg-offset-step" disabled>+</button>
            `}
        </div>
      </div>
      <div class="settings-item-hint epg-offset-preview">
        ${correctionPreview(offset)}
      </div>`;
  }

  private refreshEpgOffsetEditor(
    manualSources: ManualEpgSource[],
    selectedUrl?: string,
  ): void {
    const editor = $('.epg-offset-editor', this.container);
    if (!editor) return;
    const playlists = StorageService.getPlaylists();
    const sources = this.epgSources(manualSources, playlists);
    morph(editor, this.epgOffsetEditor(sources, playlists, selectedUrl));
  }

  private adjustEpgOffset(delta: number): void {
    if (!Number.isFinite(delta)) return;
    const source = $('#epg-offset-source', this.container)?.dataset.value;
    if (!source) return;
    this.setEpgOffset((this.epgOffsets[source] ?? 0) + delta);
  }

  private setEpgOffset(value: number): void {
    const source = $('#epg-offset-source', this.container)?.dataset.value;
    if (!source) return;
    const bounded = Math.max(
      -CONFIG.EPG.OFFSET_MAX_MINUTES,
      Math.min(CONFIG.EPG.OFFSET_MAX_MINUTES, value),
    );
    if (bounded === 0) delete this.epgOffsets[source];
    else this.epgOffsets[source] = bounded;
    this.updateEpgOffsetControl();
  }

  private updateEpgOffsetControl(): void {
    const source = $('#epg-offset-source', this.container)?.dataset.value;
    if (!source) return;
    const offset = this.epgOffsets[source] ?? 0;
    const value = $('.epg-offset-value', this.container);
    if (value) value.textContent = formatEpgOffset(offset);
    const preview = $('.epg-offset-preview', this.container);
    if (preview) morph(preview, correctionPreview(offset));
  }

  // An open dropdown menu is absolutely positioned over the settings pane, so an
  // untrapped move scores items behind it. The restriction is released straight
  // after: the pane is re-morphed on every render, so a held element goes stale.
  private moveFocus(action: NavDirection): void {
    const open = this.container.querySelector<HTMLElement>('.dropdown.open');
    // Sideways moves stay in the block they started in: a control at the edge
    // of a pane must not jump to the header or the action bar.
    const sideways = action === 'left' || action === 'right';
    const block = sideways
      ? this.nav.focused?.closest<HTMLElement>('.settings-category, .settings-actions, .settings-head') ?? null
      : null;
    this.nav.setRestrict(open?.querySelector<HTMLElement>('.dropdown-menu') ?? block);
    this.nav.move(action);
    this.nav.setRestrict(null);
  }

  private restoreOpenDropdownFocus(open: HTMLElement): void {
    const option = open.querySelector<HTMLElement>('.dropdown-option.active')
      ?? open.querySelector<HTMLElement>('.dropdown-option');
    if (option) this.nav.focus(option);
  }

  handleAction(action: Action): void {
    if (this.confirmationPrompt.visible) {
      this.confirmationPrompt.handleAction(action);
      return;
    }

    switch (action) {
      case 'up':
      case 'down':
        this.moveFocus(action);
        break;

      case 'right':
        this.moveFocus(action);
        break;

      case 'left': {
        const openDropdown = this.container.querySelector<HTMLElement>('.dropdown.open');
        if (openDropdown) this.closeDropdown(openDropdown);
        else this.moveFocus(action);
        break;
      }

      case 'select': {
        const focused = this.nav.focused;
        if (!focused) break;
        const openDropdown = this.container.querySelector<HTMLElement>('.dropdown.open');
        if (openDropdown && !openDropdown.contains(focused)) {
          this.restoreOpenDropdownFocus(openDropdown);
          break;
        }
        this.activate(focused);
        break;
      }
    }
  }

  focusReminderEntry(): void {
    const entry = $('#manage-reminders', this.container);
    if (!entry) return;
    entry.textContent = t('settings.manageReminders', {
      count: ReminderService.listManageable().length,
    });
    this.nav.focus(entry);
  }

  private activate(el: HTMLElement): void {
    if (el.id === 'settings-back') {
      this.onSave('cancel');
    } else if (el.id === 'add-playlist') {
      this.addPlaylistEntry();
    } else if (el.classList.contains('remove-playlist')) {
      this.removePlaylistEntry(el);
    } else if (el.id === 'add-epg-source') {
      this.addManualEpgSource();
    } else if (el.classList.contains('remove-epg-source')) {
      this.removeManualEpgSource(el);
    } else if (el.classList.contains('move-epg-earlier')) {
      this.moveManualEpgSource(el, -1);
    } else if (el.classList.contains('move-epg-later')) {
      this.moveManualEpgSource(el, 1);
    } else if (el.classList.contains('epg-scope-option')) {
      this.toggleManualEpgScope(el);
    } else if (el.id === 'add-xtream') {
      this.addXtreamEntry();
    } else if (el.classList.contains('remove-xtream')) {
      this.removeXtreamEntry(el);
    } else if (el.classList.contains('check-xtream')) {
      void this.checkXtreamAccount(el);
    } else if (el.classList.contains('source-toggle')) {
      this.toggleSource(el);
    } else if (el.hasAttribute('data-dropdown-trigger')) {
      this.toggleDropdown(el.closest<HTMLElement>('.dropdown'));
    } else if (el.classList.contains('dropdown-option')) {
      this.selectDropdownOption(el);
    } else if (el.classList.contains('toggle-option')) {
      // Single-select toggle group: clear the siblings, activate the chosen option.
      el.parentElement?.querySelectorAll('.toggle-option').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    } else if (el.classList.contains('epg-offset-step')) {
      this.adjustEpgOffset(Number(el.dataset.offsetDelta));
    } else if (el.classList.contains('epg-offset-value')) {
      this.setEpgOffset(0);
    } else if (el.id === 'save-settings') {
      this.save();
    } else if (el.id === 'cancel-settings') {
      this.onSave('cancel');
    } else if (el.id === 'refresh-data') {
      this.onSave('reload');
    } else if (el.id === 'clear-cache') {
      this.confirmationPrompt.show({
        title: t('settings.clearCacheTitle'),
        message: t('settings.clearCacheMessage'),
        confirmLabel: t('common.clear'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => { void this.clearCache(); },
        onCancel: () => {},
      });
    } else if (el.id === 'reset-app') {
      this.confirmationPrompt.show({
        title: t('settings.resetAppTitle'),
        message: t('settings.resetAppMessage'),
        confirmLabel: t('common.reset'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => { void this.resetApp(); },
        onCancel: () => {},
      });
    } else if (el.id === 'edit-channel-list') {
      this.saveShowHidden();
      this.onSave('edit-channels');
    } else if (el.id === 'check-channel-health') {
      if (!this.healthController) {
        const check = this.startChannelHealthCheck();
        this.healthCheckPromise = check;
        const clearHealthCheckPromise = () => {
          if (this.healthCheckPromise === check) this.healthCheckPromise = null;
        };
        void check.then(clearHealthCheckPromise, clearHealthCheckPromise);
      }
    } else if (el.id === 'pause-channel-health') {
      this.toggleChannelHealthPause();
    } else if (el.id === 'cancel-channel-health') {
      this.cancelChannelHealthCheck();
    } else if (el.id === 'manage-reminders') {
      this.onManageReminders();
    } else if (el.id === 'reset-customization') {
      this.confirmationPrompt.show({
        title: t('settings.resetCustomizationTitle'),
        message: t('settings.resetCustomizationMessage'),
        confirmLabel: t('common.reset'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => {
          ChannelCustomizationService.reset();
          PlaylistService.applyCustomization();
          this.onChannelsChanged();
          showToast(t('settings.customizationReset'));
        },
        onCancel: () => {},
      });
    } else if (el.id === 'clear-recently-watched') {
      this.confirmationPrompt.show({
        title: t('settings.clearRecentTitle'),
        message: t('settings.clearRecentMessage'),
        confirmLabel: t('common.clear'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => {
          StorageService.clearRecentlyWatched();
          showToast(t('settings.recentCleared'));
        },
        onCancel: () => {},
      });
    } else if (el.id === 'clear-watchlist' && this.watchlistAccount) {
      const account = this.watchlistAccount;
      this.confirmationPrompt.show({
        title: t('settings.clearWatchlistTitle'),
        message: t('settings.clearWatchlistMessage', { account: account.name }),
        confirmLabel: t('common.clear'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => {
          StorageService.clearWatchlist(account.id);
          showToast(t('settings.watchlistCleared', { account: account.name }));
        },
        onCancel: () => {},
      });
    } else if (el.tagName === 'INPUT') {
      (el as HTMLInputElement).focus();
    }
  }

  private channelHealthPanel(): Safe {
    const channels = PlaylistService.allChannels;
    const summary = ChannelHealthService.getSummary(channels);
    return html`
      <div class="settings-item settings-block settings-item--action channel-health-panel">
        <div class="settings-item-title">${t('settings.channelHealth')}</div>
        ${this.healthController
          ? html`
            <div class="channel-health-actions">
              <button class="btn btn-secondary" data-key="pause-channel-health"
                      data-focusable id="pause-channel-health">
                ${this.healthPaused
                  ? t('common.continue')
                  : t('common.pause')}
              </button>
              <button class="btn btn-danger" data-key="cancel-channel-health"
                      data-focusable id="cancel-channel-health">${t('common.cancel')}</button>
            </div>
          `
          : html`
            <button class="btn btn-secondary" data-key="check-channel-health"
                    data-focusable id="check-channel-health">
              ${t('settings.checkChannelHealth')}
            </button>
          `}
        ${this.healthProgress ? html`
          <div class="channel-health-progress" aria-live="polite">
            <div class="channel-health-progress-track">
              <div class="channel-health-progress-fill"
                   style="width:${this.healthProgress.total
                     ? Math.round(this.healthProgress.completed / this.healthProgress.total * 100)
                     : 0}%"></div>
            </div>
            <span>${t('settings.channelHealthProgress', {
              completed: this.healthProgress.completed,
              total: this.healthProgress.total,
            })}</span>
          </div>
        ` : ''}
        <div class="channel-health-summary">
          <span class="channel-health-status healthy">${t('channel.healthHealthy')}: ${summary.healthy}</span>
          <span class="channel-health-status suspect">${t('channel.healthSuspect')}: ${summary.suspect}</span>
          <span class="channel-health-status unavailable">${t('channel.healthUnavailable')}: ${summary.unavailable}</span>
          <span>${t('settings.channelHealthUnknown')}: ${summary.unknown}</span>
        </div>
        <div class="settings-item-hint">${t('settings.channelHealthHint')}</div>
      </div>
    `;
  }

  private updateChannelHealthPanel(): void {
    const panel = $('.channel-health-panel', this.container);
    if (panel) morph(panel, this.channelHealthPanel());
  }

  private toggleChannelHealthPause(): void {
    if (!this.healthController) return;
    this.healthPaused = !this.healthPaused;
    if (!this.healthPaused) {
      this.healthResume?.();
      this.healthResume = null;
    }
    this.updateChannelHealthPanel();
  }

  private cancelChannelHealthCheck(): void {
    this.healthController?.abort();
    this.healthPaused = false;
    this.healthResume?.();
    this.healthResume = null;
  }

  private waitWhileChannelHealthPaused(): Promise<void> {
    if (!this.healthPaused) return Promise.resolve();
    return new Promise(resolve => {
      this.healthResume = resolve;
    });
  }

  private async startChannelHealthCheck(): Promise<void> {
    const channels = PlaylistService.allChannels;
    if (!channels.length) {
      showToast(t('settings.channelHealthEmpty'));
      return;
    }
    const controller = new AbortController();
    this.healthController = controller;
    this.healthPaused = false;
    this.healthProgress = {
      ...ChannelHealthService.getSummary(channels),
      completed: 0,
    };
    this.updateChannelHealthPanel();
    try {
      await ChannelHealthService.checkAll(channels, {
        signal: controller.signal,
        waitWhilePaused: () => this.waitWhileChannelHealthPaused(),
        onProgress: progress => {
          if (this.healthController !== controller) return;
          this.healthProgress = progress;
          this.updateChannelHealthPanel();
        },
      });
      if (!controller.signal.aborted) showToast(t('settings.channelHealthComplete'));
    } catch (err) {
      log.error(
        'Channel health check failed',
        'event=channel.health.check.failed',
        err,
      );
      showToast(t('settings.channelHealthFailed'));
    } finally {
      if (this.healthController === controller) {
        this.healthController = null;
        this.healthPaused = false;
        this.healthResume = null;
        this.healthProgress = null;
        this.updateChannelHealthPanel();
        this.onChannelsChanged();
      }
    }
  }

  private async resetApp(): Promise<void> {
    try {
      await this.onSave('reset');
    } catch (err) {
      log.error(
        'App reset failed',
        'event=persistence.reset.failed',
        'operation=clear',
        err,
      );
      showToast(t('settings.resetFailed'));
    }
  }

  private async loadCacheUsage(): Promise<void> {
    try {
      const usage = await getCacheUsage();
      this.renderCacheUsage(usage);
    } catch (err) {
      log.warn(
        'Cache usage read failed',
        'event=persistence.cache.accounting.read.failed',
        'operation=read',
        'surface=settings',
        err,
      );
      const target = $('#cache-usage', this.container);
      if (target) morph(target, html`<div class="cache-usage-loading">-</div>`);
    }
  }

  private renderCacheUsage(usage: CacheUsageSummary): void {
    const target = $('#cache-usage', this.container);
    if (!target) return;
    const usedPercent = usage.budgetBytes > 0
      ? Math.max(0, Math.min(100, usage.total.bytes / usage.budgetBytes * 100))
      : 0;
    const used = formatBytes(usage.total.bytes);
    const budget = formatBytes(usage.budgetBytes);
    morph(target, html`
      <div class="cache-usage-total" role="img" aria-label="${used} / ${budget}">
        <svg class="cache-usage-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="cache-usage-ring-track" cx="60" cy="60" r="50"></circle>
          <circle class="cache-usage-ring-used" cx="60" cy="60" r="50"
                  pathLength="100" stroke-dasharray="${usedPercent.toFixed(1)} 100"
                  stroke-dashoffset="0"
                  transform="rotate(-90 60 60)"></circle>
        </svg>
        <div class="cache-usage-value">
          <strong>${used}</strong>
          <span>/ ${budget}</span>
        </div>
      </div>
      <div class="cache-usage-breakdown">
        <span>${t('settings.playlists')} <strong>${formatBytes(usage.categories.playlist.bytes)}</strong></span>
        <span>${t('settings.epg')} <strong>${formatBytes(usage.categories.epg.bytes)}</strong></span>
        <span>${t('settings.moviesSeriesMediaData')} <strong>${formatBytes(usage.categories.catalog.bytes)}</strong></span>
        <span>${t('settings.onlineSubtitles')} <strong>${formatBytes(usage.categories.subtitle.bytes)}</strong></span>
        <span>${t('settings.channelHealth')} <strong>${formatBytes(usage.categories.health.bytes)}</strong></span>
      </div>
    `);
  }

  private async clearCache(): Promise<void> {
    try {
      const activeCheck = this.healthCheckPromise;
      if (activeCheck) {
        this.cancelChannelHealthCheck();
        await activeCheck;
      }
      await clearAllCachedData();
      ChannelHealthService.reset();
      this.updateChannelHealthPanel();
      this.onChannelsChanged();
      await this.loadCacheUsage();
      showToast(t('settings.cacheCleared'));
    } catch (err) {
      log.error(
        'Cache clear failed',
        'event=persistence.cache.clear.failed',
        'operation=clear',
        'scope=all',
        'surface=settings',
        err,
      );
      showToast(t('settings.cacheClearFailed'));
    }
  }

  // Applied on its own (not only on Save) so leaving through "Edit channel list"
  // still honors the toggle.
  private saveShowHidden(): void {
    const btn = $('#show-hidden .toggle-option.active', this.container);
    if (!btn) return;
    const show = btn.dataset.value === 'on';
    if (show === StorageService.getShowHiddenChannels()) return;
    StorageService.setShowHiddenChannels(show);
    PlaylistService.applyCustomization();
    this.onChannelsChanged();
  }

  get isPromptVisible(): boolean {    return this.confirmationPrompt.visible;
  }

  dismissPrompt(): void {
    this.confirmationPrompt.hide();
  }

  private onNavFocus(el: HTMLElement | null): void {
    this.container.querySelector('.settings-option.is-current')
      ?.classList.remove('is-current');
    el?.closest('.settings-option')?.classList.add('is-current');
  }

  /** Shows one category - the only one on screen - and lands on its first control. */
  openCategory(category: SettingsCategory): void {
    this.container.querySelectorAll<HTMLElement>('.settings-category').forEach((pane) => {
      pane.classList.toggle('is-active', pane.dataset.settingsCategory === category);
    });
    const title = this.container.querySelector<HTMLElement>('#settings-pane-title');
    const meta = SETTINGS_CATEGORIES.filter(item => item.id === category)[0];
    if (title && meta) title.textContent = t(meta.label);
    const scroll = this.container.querySelector<HTMLElement>('.settings-scroll');
    if (scroll) scroll.scrollTop = 0;
    this.focusCategoryFirst(category);
  }

  // Entry takes the pane's first focusable in DOM order, with no geometry to
  // fall back on, so measurement is what keeps focus off an invisible control -
  // a closed menu's options stay focusable.
  private focusCategoryFirst(category: SettingsCategory): void {
    const pane = this.container.querySelector<HTMLElement>(`#settings-${category}`);
    if (pane) {
      this.nav.setRestrict(pane);
      const focused = this.nav.focusFirst();
      this.nav.setRestrict(null);
      if (focused) {
        // The first control scrolls itself into view; the pane starts at its top.
        const scroll = this.container.querySelector<HTMLElement>('.settings-scroll');
        if (scroll) scroll.scrollTop = 0;
        return;
      }
    }
    this.nav.focusFirst();
  }

  // Opening moves focus to the active option, or the first one when the stored
  // value is no longer offered.
  private toggleDropdown(dd: HTMLElement | null): void {
    if (!dd) return;
    const open = !dd.classList.contains('open');
    const current = this.container.querySelector<HTMLElement>('.dropdown.open');
    if (current && current !== dd) this.closeDropdown(current);
    if (!open) {
      this.closeDropdown(dd);
      return;
    }
    dd.classList.toggle('open', open);
    const opt = dd.querySelector<HTMLElement>('.dropdown-option.active') ?? dd.querySelector<HTMLElement>('.dropdown-option');
    if (opt) this.nav.focus(opt);
  }

  private closeDropdown(dd: HTMLElement): void {
    dd.classList.remove('open');
    const trigger = dd.querySelector<HTMLElement>('.dropdown-trigger');
    if (trigger) this.nav.focus(trigger);
  }

  dismissDropdown(): boolean {
    const open = this.container.querySelector<HTMLElement>('.dropdown.open');
    if (!open) return false;
    this.closeDropdown(open);
    return true;
  }

  // Commit a dropdown option: record it on the root's data-value, update the
  // trigger label, close the menu, and return focus to the trigger.
  private selectDropdownOption(el: HTMLElement): void {
    const dd = el.closest<HTMLElement>('.dropdown');
    if (!dd) return;
    dd.dataset.value = el.dataset.dropdownValue ?? '';
    dd.querySelectorAll('.dropdown-option').forEach(o => o.classList.remove('active'));
    el.classList.add('active');
    const cur = dd.querySelector('.dropdown-current');
    if (cur) cur.textContent = el.textContent;
    dd.classList.remove('open');
    // Text size previews live so the choice can be judged at its own scale;
    // showView() reverts it if Settings closes without saving.
    if (dd.id === 'text-size') applyTextSize(dd.dataset.value ?? '');
    if (dd.id === 'epg-offset-source') this.updateEpgOffsetControl();
    const trigger = dd.querySelector<HTMLElement>('.dropdown-trigger');
    if (trigger) this.nav.focus(trigger);
  }

  private addPlaylistEntry(): void {
    const entries = $('#playlist-entries', this.container);
    if (!entries) return;

    // First add: replace the empty-hint with the column header row.
    const emptyHint = entries.querySelector('.empty-hint');
    if (emptyHint) {
      emptyHint.remove();
      const header = document.createElement('div');
      header.className = 'settings-row playlist-header-row';
      header.innerHTML = `
        <div class="settings-field"><label>${t('settings.name')}</label></div>
        <div class="settings-field"><label>${t('settings.url')}</label></div>
        <div class="playlist-header-spacer"></div>
      `;
      entries.appendChild(header);
    }

    // Seed a concrete default name so it persists as a real value (a blank name
    // makes save() fall back to position-based numbering). Use one past the
    // highest existing "Playlist N" (and the row count) so adding after deleting
    // a middle row never reuses a surviving label.
    const nameInputs = entries.querySelectorAll<HTMLInputElement>('.playlist-name');
    const nextNum = Array.from(nameInputs).reduce((max, inp) => {
      const m = /^Playlist (\d+)$/.exec(inp.value.trim());
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, nameInputs.length) + 1;
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.dataset.id = genPlaylistId();
    row.setAttribute('data-source-entry', '');
    row.innerHTML = `
      <div class="settings-field">
        <input type="text" class="settings-input playlist-name"
               aria-label="${t('settings.playlistName')}" placeholder="${t('settings.myPlaylist')}"
               data-focusable value="${t('settings.playlistDefault', { number: nextNum })}">
      </div>
      <div class="settings-field">
        <input type="text" class="settings-input playlist-url"
               aria-label="${t('settings.playlistUrl')}" placeholder="https://...m3u"
               data-focusable value="">
      </div>
      ${String(sourceToggle(true))}
      <button class="btn btn-danger remove-playlist" data-focusable>${t('common.remove')}</button>
    `;
    entries.appendChild(row);
    this.refreshManualEpgScopes();

    const newInput = row.querySelector<HTMLElement>('input');
    if (newInput) {
      this.nav.focus(newInput);
      (newInput as HTMLInputElement).focus();
    }
  }

  private manualEpgSourcesFromEditor(
    allowedPlaylistIds?: ReadonlySet<string>,
  ): ManualEpgSource[] {
    return Array.from(
      this.container.querySelectorAll<HTMLElement>('[data-manual-epg-source]'),
    ).map(row => {
      const source = this.manualEpgSourceFromRow(row);
      return {
        url: source.url.trim(),
        playlistIds: allowedPlaylistIds && source.playlistIds.length
          ? source.playlistIds.filter(id => allowedPlaylistIds.has(id))
          : source.playlistIds,
      };
    })
      .filter(source => source.url !== '');
  }

  private manualEpgSourceFromRow(row: HTMLElement): ManualEpgSource {
    const url = row.querySelector<HTMLInputElement>('.manual-epg-url')?.value ?? '';
    const all = row.querySelector('.epg-scope-option[data-scope-all].active');
    const playlistIds = all
      ? []
      : Array.from(row.querySelectorAll<HTMLElement>(
          '.epg-scope-option[data-playlist-id].active',
        )).map(option => option.dataset.playlistId ?? '').filter(Boolean);
    return { url, playlistIds };
  }

  private applyManualEpgSourceToRow(
    row: HTMLElement,
    source: ManualEpgSource,
  ): void {
    const input = row.querySelector<HTMLInputElement>('.manual-epg-url');
    if (input) input.value = source.url;
    row.querySelector<HTMLElement>('[data-scope-all]')?.classList.toggle(
      'active',
      source.playlistIds.length === 0,
    );
    row.querySelectorAll<HTMLElement>('[data-playlist-id]').forEach(option => {
      option.classList.toggle(
        'active',
        source.playlistIds.includes(option.dataset.playlistId ?? ''),
      );
    });
  }

  private currentEpgOffsetSource(): string | undefined {
    return $('#epg-offset-source', this.container)?.dataset.value;
  }

  private epgScopePlaylistsFromEditor(): EpgScopePlaylist[] {
    const playlists = $$('#playlist-entries [data-source-entry]', this.container)
      .map(row => ({
        id: row.dataset.id ?? '',
        name: row.querySelector<HTMLInputElement>('.playlist-name')?.value.trim() ?? '',
        url: row.querySelector<HTMLInputElement>('.playlist-url')?.value.trim() ?? '',
      }))
      .filter(playlist => playlist.id !== '');
    const accounts = $$('#xtream-entries .xtream-card', this.container)
      .map(card => ({
        id: card.dataset.id ?? '',
        name: card.querySelector<HTMLInputElement>('.xtream-name')?.value.trim() ?? '',
        url: card.querySelector<HTMLInputElement>('.xtream-url')?.value.trim() ?? '',
      }))
      .filter(account => account.id !== '');
    return [...playlists, ...accounts];
  }

  private refreshManualEpgScopes(): void {
    const playlists = this.epgScopePlaylistsFromEditor();
    const playlistIds = new Set(playlists.map(playlist => playlist.id));
    this.container.querySelectorAll<HTMLElement>('[data-manual-epg-source]')
      .forEach(row => {
        const source = this.manualEpgSourceFromRow(row);
        if (source.playlistIds.length) {
          source.playlistIds = source.playlistIds.filter(id => playlistIds.has(id));
        }
        const options = row.querySelector<HTMLElement>('.manual-epg-scope-options');
        if (options) morph(options, manualEpgScopeOptions(source, playlists));
      });
  }

  private addManualEpgSource(): void {
    const entries = $('.manual-epg-sources', this.container);
    if (!entries) return;
    entries.querySelector('.empty-hint')?.remove();
    const playlists = this.epgScopePlaylistsFromEditor();
    const index = entries.querySelectorAll('[data-manual-epg-source]').length;
    const wrap = document.createElement('div');
    wrap.innerHTML = String(manualEpgSourceRow(
      { url: '', playlistIds: [] },
      playlists,
      index,
      index + 1,
    ));
    const row = wrap.firstElementChild;
    if (!row) return;
    entries.appendChild(row);
    this.renumberManualEpgSources();
    const input = row.querySelector<HTMLInputElement>('.manual-epg-url');
    if (input) {
      this.nav.focus(input);
      input.focus();
    }
  }

  private removeManualEpgSource(button: HTMLElement): void {
    const entries = $('.manual-epg-sources', this.container);
    button.closest('[data-manual-epg-source]')?.remove();
    if (entries && !entries.querySelector('[data-manual-epg-source]')) {
      const emptyHint = document.createElement('div');
      emptyHint.className = 'empty-hint';
      emptyHint.textContent = t('settings.noEpgSources');
      entries.appendChild(emptyHint);
    }
    this.renumberManualEpgSources();
    this.refreshEpgOffsetEditor(
      this.manualEpgSourcesFromEditor(),
      this.currentEpgOffsetSource(),
    );
    this.nav.focus($('#add-epg-source', this.container));
  }

  private moveManualEpgSource(button: HTMLElement, direction: -1 | 1): void {
    const row = button.closest<HTMLElement>('[data-manual-epg-source]');
    if (!row) return;
    const target = direction < 0
      ? row.previousElementSibling
      : row.nextElementSibling;
    if (!(target instanceof HTMLElement)) return;
    const source = this.manualEpgSourceFromRow(row);
    const targetSource = this.manualEpgSourceFromRow(target);
    this.applyManualEpgSourceToRow(target, source);
    this.applyManualEpgSourceToRow(row, targetSource);
    this.refreshEpgOffsetEditor(
      this.manualEpgSourcesFromEditor(),
      this.currentEpgOffsetSource(),
    );
    this.nav.focus(target.querySelector<HTMLElement>('.manual-epg-url'));
  }

  private renumberManualEpgSources(): void {
    const rows = Array.from(
      this.container.querySelectorAll<HTMLElement>('[data-manual-epg-source]'),
    );
    rows.forEach((row, index) => {
        const priority = row.querySelector('.manual-epg-priority');
        if (priority) priority.textContent = String(index + 1);
        const earlier = row.querySelector<HTMLButtonElement>('.move-epg-earlier');
        const later = row.querySelector<HTMLButtonElement>('.move-epg-later');
        this.setManualEpgMoveState(earlier, index > 0);
        this.setManualEpgMoveState(later, index < rows.length - 1);
      });
  }

  private setManualEpgMoveState(
    button: HTMLButtonElement | null,
    enabled: boolean,
  ): void {
    if (!button) return;
    button.disabled = !enabled;
    if (enabled) button.setAttribute('data-focusable', '');
    else button.removeAttribute('data-focusable');
  }

  private toggleManualEpgScope(option: HTMLElement): void {
    const row = option.closest<HTMLElement>('[data-manual-epg-source]');
    if (!row) return;
    const all = row.querySelector<HTMLElement>('[data-scope-all]');
    const scoped = Array.from(
      row.querySelectorAll<HTMLElement>('[data-playlist-id]'),
    );
    if (option.hasAttribute('data-scope-all')) {
      all?.classList.add('active');
      scoped.forEach(item => item.classList.remove('active'));
    } else {
      option.classList.toggle('active');
      all?.classList.remove('active');
      if (!scoped.some(item => item.classList.contains('active'))) {
        all?.classList.add('active');
      }
    }
    this.refreshEpgOffsetEditor(
      this.manualEpgSourcesFromEditor(),
      this.currentEpgOffsetSource(),
    );
  }

  private removePlaylistEntry(removeBtn: HTMLElement): void {
    const entries = $('#playlist-entries', this.container);
    if (!entries) return;
    // Remove the row the clicked button sits in — no positional index, so it
    // can't be thrown off by stale/duplicate row ordering.
    removeBtn.closest('.settings-row')?.remove();
    // Drop the header row too if no data rows remain (lone header would look orphaned).
    if (entries.querySelectorAll('.settings-row:not(.playlist-header-row)').length === 0) {
      const header = entries.querySelector('.playlist-header-row');
      if (header) header.remove();
      const e = document.createElement('div');
      e.className = 'empty-hint';
      e.textContent = t('settings.noPlaylists');
      entries.appendChild(e);
    }
    this.refreshManualEpgScopes();
    this.nav.focusFirst();
  }

  private addXtreamEntry(): void {
    const entries = $('#xtream-entries', this.container);
    if (!entries) return;
    entries.querySelector('.empty-hint')?.remove();

    // Build the card off-DOM from the trusted template, then attach it. The
    // seeded id gives morph/save a stable key from the moment it's created.
    const tmp = document.createElement('div');
    tmp.innerHTML = String(xtreamCard({ id: genPlaylistId() }));
    const card = tmp.firstElementChild as HTMLElement | null;
    if (!card) return;
    entries.appendChild(card);
    this.refreshManualEpgScopes();

    const firstInput = card.querySelector<HTMLInputElement>('input');
    if (firstInput) {
      this.nav.focus(firstInput);
      firstInput.focus();
    }
  }

  private removeXtreamEntry(removeBtn: HTMLElement): void {
    const entries = $('#xtream-entries', this.container);
    if (!entries) return;
    // Remove the card the clicked button sits in (closest), independent of order.
    removeBtn.closest('.xtream-card')?.remove();
    if (entries.querySelectorAll('.xtream-card').length === 0) {
      const e = document.createElement('div');
      e.className = 'empty-hint';
      e.textContent = t('settings.noXtream');
      entries.appendChild(e);
    }
    this.refreshManualEpgScopes();
    this.nav.focusFirst();
  }

  private toggleSource(button: HTMLElement): void {
    const enabled = button.dataset.enabled !== 'true';
    button.dataset.enabled = enabled ? 'true' : 'false';
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.classList.toggle('active', enabled);
    const label = button.querySelector('.source-toggle-label');
    if (label) label.textContent = t(enabled ? 'settings.on' : 'settings.off');
    button.closest<HTMLElement>('[data-source-entry]')
      ?.classList.toggle('source-disabled', !enabled);
  }

  /**
   * Verify a card's current (unsaved) credentials via get_account_info and show
   * the result inline, so the user can confirm before saving. Re-resolves the
   * status node after the await in case the view re-rendered, and never blocks
   * the rest of the form.
   */
  private async checkXtreamAccount(btn: HTMLElement): Promise<void> {
    const card = btn.closest<HTMLElement>('.xtream-card');
    if (!card) return;
    const id = card.dataset.id || '';
    const url = card.querySelector<HTMLInputElement>('.xtream-url')!.value.trim();
    const username = card.querySelector<HTMLInputElement>('.xtream-username')!.value.trim();
    const password = card.querySelector<HTMLInputElement>('.xtream-password')!.value;
    if (!url || !username || !password) {
      this.setXtreamStatus(id, html`${t('settings.enterCredentials')}`, 'err');
      return;
    }

    this.setXtreamStatus(id, html`${t('settings.checking')}`, '');
    const info = await createXtreamClient({ baseUrl: url, username, password }).getAccountInfo();
    if (!info) {
      log.warn(
        'Xtream verify failed — server unreachable or non-JSON',
        'event=xtream.verify.failed',
        'reason=request_failed',
      );
      this.setXtreamStatus(id, html`${t('settings.verifyFailed')}`, 'err');
      return;
    }
    if (!info.auth) {
      log.warn(
        'Xtream verify rejected — credentials not accepted (auth 0)',
        'event=xtream.verify.rejected',
        'reason=credentials',
      );
      this.setXtreamStatus(id, html`${t('settings.loginFailed')}`, 'err');
      return;
    }
    const status = info.status || t('settings.active');
    log.info('Xtream verify OK —', status, '| expires', formatExpiry(info.expiresAt),
      '|', info.activeConnections + '/' + info.maxConnections, 'connections');
    this.setXtreamStatus(
      id,
      html`${status} \u00b7 ${formatExpiry(info.expiresAt)} \u00b7 ${t('settings.connections', {
        active: info.activeConnections,
        max: info.maxConnections,
      })}`,
      'ok',
    );
  }

  private setXtreamStatus(id: string, content: Safe, cls: '' | 'ok' | 'err'): void {
    const el = $(`#xtream-entries .xtream-card[data-id="${id}"] .xtream-status`, this.container);
    if (!el) return;
    el.className = 'xtream-status' + (cls ? ` ${cls}` : '');
    morph(el, content);
  }

  private save(): void {
    // Read row-by-row so each row's stable id (data-id) is preserved; a row
    // added before this build has none, so mint one.
    const rows = $$('#playlist-entries .settings-row:not(.playlist-header-row)', this.container) as HTMLElement[];
    const playlists: PlaylistEntry[] = [];

    for (const row of rows) {
      const url = row.querySelector<HTMLInputElement>('.playlist-url')!.value.trim();
      if (!url) continue;
      const name = row.querySelector<HTMLInputElement>('.playlist-name')!.value.trim();
      const entry: PlaylistEntry = {
        id: row.dataset.id || genPlaylistId(),
        name: name || t('settings.playlistDefault', { number: playlists.length + 1 }),
        url,
        source: 'url',
      };
      playlists.push(withEnabledState(
        entry,
        row.querySelector<HTMLElement>('.source-toggle')?.dataset.enabled !== 'false',
      ));
    }

    // Xtream accounts derive their get.php/xmltv.php URLs from these credentials
    // at load time; the base URL is normalized so a bare host still resolves.
    const accounts: PlaylistEntry[] = [];
    const cards = $$('#xtream-entries .xtream-card', this.container) as HTMLElement[];
    for (const card of cards) {
      const rawUrl = card.querySelector<HTMLInputElement>('.xtream-url')!.value.trim();
      const username = card.querySelector<HTMLInputElement>('.xtream-username')!.value.trim();
      const password = card.querySelector<HTMLInputElement>('.xtream-password')!.value;
      if (!rawUrl || !username || !password) continue;
      const base = normalizeXtreamBaseUrl(rawUrl);
      const name = card.querySelector<HTMLInputElement>('.xtream-name')!.value.trim();
      const liveOutput = normalizeXtreamLiveOutputPreference(
        card.querySelector<HTMLElement>('.xtream-output .dropdown')!.dataset.value,
      );
      const entry: PlaylistEntry = {
        id: card.dataset.id || genPlaylistId(),
        name: name || base.replace(/^https?:\/\//i, ''),
        url: base,
        source: 'xtream',
        xtream: { username, password, liveOutput },
      };
      accounts.push(withEnabledState(
        entry,
        card.querySelector<HTMLElement>('.source-toggle')?.dataset.enabled !== 'false',
      ));
    }

    const stored = StorageService.getPlaylists();
    const nextSources = [...playlists, ...accounts];
    const manualEpgSources = this.manualEpgSourcesFromEditor(
      new Set(nextSources.map(source => source.id)),
    );
    const seenEpgUrls = new Set<string>();
    const duplicateEpgUrl = manualEpgSources.find(source => {
      if (seenEpgUrls.has(source.url)) return true;
      seenEpgUrls.add(source.url);
      return false;
    })?.url;
    if (duplicateEpgUrl) {
      const duplicateInput = Array.from(
        this.container.querySelectorAll<HTMLInputElement>('.manual-epg-url'),
      ).filter(input => input.value.trim() === duplicateEpgUrl)[1];
      if (duplicateInput) {
        this.nav.focus(duplicateInput);
        duplicateInput.focus();
      }
      showToast(t('settings.duplicateEpgSource'));
      return;
    }

    ReminderService.backfillSourceIds();
    StorageService.setPlaylists(nextSources);

    const previousManualEpgSources = StorageService.getManualEpgSources();
    StorageService.setManualEpgSources(manualEpgSources);

    const autoPlayBtn = $('#auto-play .toggle-option.active', this.container);
    if (autoPlayBtn) StorageService.setAutoPlay(autoPlayBtn.dataset.value === 'on');

    const livePreviewBtn = $('#live-preview-setting .toggle-option.active', this.container);
    if (livePreviewBtn) StorageService.setLivePreview(livePreviewBtn.dataset.value === 'on');

    const channelCycleBtn = $('#channel-cycle-mode .toggle-option.active', this.container);
    if (channelCycleBtn?.dataset.value) {
      StorageService.setChannelCycleMode(channelCycleBtn.dataset.value as ChannelCycleMode);
    }

    this.saveShowHidden();

    const tzModeBtn = $('#tz-mode .toggle-option.active', this.container);
    if (tzModeBtn?.dataset.value) StorageService.setTzMode(tzModeBtn.dataset.value as TzMode);
    const sourceByChannel: Record<string, string> = {};
    const legacySources = new Map<string, string>();
    const ambiguousLegacyKeys = new Set<string>();
    for (const channel of PlaylistService.channels) {
      const sourceUrl = EpgService.getSourceUrl(channel);
      if (!sourceUrl) continue;
      sourceByChannel[channelKey(channel)] = sourceUrl;
      const legacyKey = legacyChannelKey(channel);
      if (legacySources.has(legacyKey)) {
        ambiguousLegacyKeys.add(legacyKey);
      } else {
        legacySources.set(legacyKey, sourceUrl);
      }
    }
    for (const [legacyKey, sourceUrl] of legacySources) {
      if (!ambiguousLegacyKeys.has(legacyKey)) sourceByChannel[legacyKey] = sourceUrl;
    }
    ReminderService.migrateEpgOffsets(
      this.storedEpgOffsets,
      this.epgOffsets,
      sourceByChannel,
    );
    StorageService.migrateCatchupEpgOffsets(
      this.storedEpgOffsets,
      this.epgOffsets,
      sourceByChannel,
    );
    const nextEpgOffsets = { ...this.epgOffsets };
    for (const source of previousManualEpgSources) {
      if (!manualEpgSources.some(candidate => candidate.url === source.url)
          && !PlaylistService.epgSources.some(candidate => candidate.url === source.url)) {
        delete nextEpgOffsets[source.url];
      }
    }
    this.epgOffsets = nextEpgOffsets;
    StorageService.setEpgOffsets(nextEpgOffsets);

    const overlayBtn = $('#overlay-style .toggle-option.active', this.container);
    if (overlayBtn?.dataset.value) StorageService.setOverlayStyle(overlayBtn.dataset.value as OverlayStyle);

    const textSize = ($('#text-size', this.container) as HTMLElement | null)?.dataset.value;
    if (textSize) StorageService.setTextSize(textSize as TextSize);

    const locale = ($('#app-language', this.container) as HTMLElement | null)?.dataset.value as LocalePreference | undefined;
    if (locale) StorageService.setLocalePreference(locale);

    const liveReconnectAttempts = Number(
      ($('#live-reconnect-attempts', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setLiveReconnectAttempts(liveReconnectAttempts);

    const numberEntryOsdTimeoutMs = Number(
      ($('#number-entry-osd-timeout', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setNumberEntryOsdTimeoutMs(numberEntryOsdTimeoutMs);

    const playerOsdTimeoutMs = Number(
      ($('#player-osd-timeout', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setPlayerOsdTimeoutMs(playerOsdTimeoutMs);

    const animationMode = $('#animation-mode .toggle-option.active', this.container)
      ?.dataset.value as AnimationMode | undefined;
    if (animationMode) {
      StorageService.setAnimationMode(animationMode);
      applyAnimationMode(animationMode);
    }

    const playlistRefreshHours = Number(
      ($('#playlist-refresh-interval', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setPlaylistRefreshIntervalHours(playlistRefreshHours);

    const epgRefreshHours = Number(
      ($('#epg-refresh-interval', this.container) as HTMLElement | null)?.dataset.value,
    );
    StorageService.setEpgRefreshIntervalHours(epgRefreshHours);

    const xtreamCatalogRefresh = $(
      '#xtream-catalog-refresh-interval',
      this.container,
    ) as HTMLElement | null;
    if (xtreamCatalogRefresh) {
      StorageService.setXtreamCatalogRefreshIntervalHours(
        Number(xtreamCatalogRefresh.dataset.value),
      );
    }

    const prevOs = StorageService.getOnlineSubtitleConfig();
    const osVal = (id: string) => ($(`#${id}`, this.container) as HTMLInputElement | null)?.value.trim() ?? '';
    const sameCreds = osVal('os-key') === prevOs.opensubtitles.apiKey
      && osVal('os-user') === prevOs.opensubtitles.username
      && osVal('os-pass') === prevOs.opensubtitles.password;
    StorageService.setOnlineSubtitleConfig({
      preferredLanguage: ($('#os-pref-lang', this.container) as HTMLElement | null)?.dataset.value ?? '',
      subdl: { apiKey: osVal('subdl-key') },
      assrt: { apiKey: osVal('assrt-key') },
      opensubtitles: {
        apiKey: osVal('os-key'), username: osVal('os-user'), password: osVal('os-pass'),
        token: sameCreds ? prevOs.opensubtitles.token : '',
        tokenTs: sameCreds ? prevOs.opensubtitles.tokenTs : 0,
      },
    });

    // Source, EPG URL, and time correction changes rebuild loaded data. Display-only
    // settings (time zone, auto-play) just re-render in place.
    const sig = (l: PlaylistEntry[]) =>
      JSON.stringify(l.map(pl => [
        pl.id,
        pl.name,
        pl.url,
        isSourceEnabled(pl),
        pl.xtream?.username,
        pl.xtream?.password,
        pl.xtream ? normalizeXtreamLiveOutputPreference(pl.xtream.liveOutput) : '',
      ]));
    const offsetSig = (offsets: Record<string, number>) =>
      JSON.stringify(Object.keys(offsets).sort().map(url => [url, offsets[url]]));
    const dataChanged = JSON.stringify(manualEpgSources)
        !== JSON.stringify(previousManualEpgSources)
      || sig(stored) !== sig(nextSources)
      || offsetSig(this.storedEpgOffsets) !== offsetSig(this.epgOffsets);
    this.onSave(dataChanged ? 'reload' : 'apply');
  }
}
