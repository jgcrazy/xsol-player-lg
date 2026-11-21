import type { Action } from '../types';
import { CONFIG } from '../config';
import { SpatialNav } from '../navigation/spatial-nav';
import {
  ActivationService,
  settleSingleAccess,
  useOnlyPlaylist,
  type ActivationSnapshot,
} from '../services/xsol/activation-service';
import { LoginService, type LoginResult } from '../services/xsol/login-service';
import { StorageService } from '../services/storage-service';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { qrDataUrl } from '../utils/qr';
import { getLocale, t, type TextMessageKey } from '../i18n';
import { BACK_ICON, RESYNC_ICON } from './icons';

interface AccessHandlers {
  /** The panel delivered (or withdrew) a playlist: channel data must be reloaded. */
  onPlaylistChanged: () => void;
  onBack: () => void;
  /** Up from the top row: hand focus to the tab bar. Returns false when there is none. */
  onRevealTabBar: () => boolean;
}

type Notice = { kind: 'error' | 'info' | 'success'; text: string } | null;

const STATUS_KEY: Record<ActivationSnapshot['status'], TextMessageKey> = {
  connecting: 'access.status.connecting',
  active: 'access.status.active',
  expired: 'access.status.expired',
  blocked: 'access.status.blocked',
  inactive: 'access.status.inactive',
  offline: 'access.status.offline',
  refused: 'access.status.refused',
};

// Long enough for the spin to be seen: a check against a nearby panel returns
// in well under a frame's worth of attention.
const MIN_REFRESH_SPIN_MS = 700;

function formatKey(key: string): string {
  return key.length === 6 ? `${key.slice(0, 3)} ${key.slice(3)}` : key;
}

// The panel sends either "YYYY-MM-DD HH:MM:SS" or an ISO timestamp.
function formatExpiry(raw: string): string {
  const parsed = new Date(raw.indexOf('T') === -1 ? raw.replace(' ', 'T') : raw);
  if (isNaN(parsed.getTime())) return '';
  try {
    return parsed.toLocaleDateString(getLocale());
  } catch {
    return parsed.toLocaleDateString();
  }
}

/**
 * The "Access" section: shows the MAC and key the customer types on the portal,
 * a QR code that opens the portal for this device, the activation state, and the
 * playlist the panel has linked. While it is on screen it polls the panel, so a
 * playlist saved on the portal reaches the TV without the user doing anything
 * here. It lists the configured accesses, to pick the one in use or remove
 * one, and lets the user sign in on the TV with a server or code plus an account.
 */
export class Access {
  private nav: SpatialNav;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private opened = false;
  private refreshing = false;
  private qrFor = '';
  private qrSrc = '';
  private formOpen = false;
  private submitting = false;
  // The row whose Remove was pressed once; a second press on it removes.
  private pendingRemove = '';
  private removing = false;
  // Ids present before a sign-in on the TV; the one that arrives next takes over.
  private adoptAfter: string[] | null = null;
  private notice: Notice = null;

  constructor(
    private container: HTMLElement,
    private handlers: AccessHandlers,
  ) {
    this.nav = new SpatialNav(container);
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control);
      this.activate(control);
    });
    // The global key handler leaves typing to the field; Enter there means "next".
    this.container.addEventListener('keydown', (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== 'Enter' || !(target instanceof HTMLInputElement)) return;
      event.preventDefault();
      event.stopPropagation();
      target.blur();
      this.nav.move('down');
    });
  }

  open(): void {
    if (!this.opened) {
      this.opened = true;
      this.unsubscribe = ActivationService.subscribe(() => this.render());
    }
    // Exactly one access is in use; settle a leftover from when several could be.
    const settled = settleSingleAccess();
    this.render();
    this.focusFirst();
    if (settled) {
      this.handlers.onPlaylistChanged();
      return;
    }
    void this.poll(false);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.formOpen = false;
    this.pendingRemove = '';
    this.adoptAfter = null;
    this.notice = null;
  }

  handleAction(action: Action): void {
    if (action === 'back') {
      if (this.pendingRemove) this.cancelRemove();
      else if (this.formOpen) this.setFormOpen(false);
      else this.handlers.onBack();
      return;
    }
    if (action === 'select' && this.nav.focused) {
      this.activate(this.nav.focused);
      return;
    }
    if (action !== 'up' && action !== 'down' && action !== 'left' && action !== 'right') return;
    // A field keeps DOM focus while the D-pad moves on; let go of it first.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && this.container.contains(active)) active.blur();
    // Moving away from a half-confirmed Remove withdraws it.
    if (this.pendingRemove) this.cancelRemove();
    if (!this.nav.move(action) && action === 'up') this.handlers.onRevealTabBar();
  }

  private activate(control: HTMLElement): void {
    if (control instanceof HTMLInputElement) {
      control.focus();
      return;
    }
    const action = control.dataset.accessAction;
    const id = control.dataset.id ?? '';
    if (action !== 'remove' && this.pendingRemove) this.cancelRemove();
    if (action === 'back') this.handlers.onBack();
    else if (action === 'refresh') void this.poll(true);
    else if (action === 'login-open') this.setFormOpen(true);
    else if (action === 'login-cancel') this.setFormOpen(false);
    else if (action === 'login-submit') void this.submit();
    else if (action === 'use') this.usePlaylist(id);
    else if (action === 'remove') void this.removePlaylist(id);
  }

  private setFormOpen(open: boolean): void {
    this.formOpen = open;
    this.notice = null;
    this.render();
    const target = open
      ? this.container.querySelector<HTMLElement>('.access-form [data-focusable]')
      : this.container.querySelector<HTMLElement>('[data-access-action="login-open"]');
    if (target) this.nav.focus(target);
  }

  private cancelRemove(): void {
    this.pendingRemove = '';
    this.render();
  }

  // Selecting an access makes it the one the TV plays: the others stay
  // configured but are switched off.
  private usePlaylist(id: string): void {
    const chosen = StorageService.getPlaylists().filter(item => item.id === id)[0];
    if (!chosen) return;
    if (!useOnlyPlaylist(id)) {
      this.notice = { kind: 'info', text: t('access.list.alreadyInUse', { name: chosen.name }) };
      this.render();
      return;
    }
    this.notice = { kind: 'success', text: t('access.list.selected', { name: chosen.name }) };
    this.render();
    this.handlers.onPlaylistChanged();
  }

  private async removePlaylist(id: string): Promise<void> {
    if (this.removing) return;
    if (this.pendingRemove !== id) {
      this.pendingRemove = id;
      this.notice = null;
      this.render();
      return;
    }
    this.removing = true;
    this.pendingRemove = '';
    this.notice = { kind: 'info', text: t('access.list.removing') };
    this.render();
    let removed = false;
    try {
      removed = await ActivationService.removePlaylist(id);
    } finally {
      this.removing = false;
    }
    if (!this.opened) return;
    this.notice = removed
      ? { kind: 'success', text: t('access.list.removed') }
      : { kind: 'error', text: t('access.list.removeFailed') };
    this.render();
    if (!removed) return;
    if (!this.nav.focused || !this.container.contains(this.nav.focused)) {
      const next = this.container.querySelector<HTMLElement>('[data-access-action="use"]')
        ?? this.container.querySelector<HTMLElement>('[data-access-action="login-open"]');
      if (next) this.nav.focus(next);
    }
    this.handlers.onPlaylistChanged();
  }

  private field(name: string): string {
    return this.container.querySelector<HTMLInputElement>(`[data-access-field="${name}"]`)?.value ?? '';
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.formOpen) return;
    this.submitting = true;
    this.notice = { kind: 'info', text: t('access.login.working') };
    this.render();
    let result: LoginResult;
    try {
      result = await LoginService.signIn({
        target: this.field('target'),
        username: this.field('username'),
        password: this.field('password'),
      });
    } finally {
      this.submitting = false;
    }
    if (!this.opened) return;

    if (result.status === 'needs_account') {
      // The code was good and named the server; only the account is missing.
      this.notice = { kind: 'info', text: t('access.login.codeNeedsAccount') };
      this.render();
      const first = this.container.querySelector<HTMLElement>('[data-access-field="username"]');
      if (first) this.nav.focus(first);
      return;
    }
    if (result.status === 'error') {
      this.notice = { kind: 'error', text: this.errorText(result) };
      this.render();
      return;
    }
    this.formOpen = false;
    // The list just signed in with is the one the user wants in use.
    this.adoptAfter = StorageService.getPlaylists().map(item => item.id);
    this.notice = { kind: 'success', text: t('access.login.success') };
    this.render();
    // The panel now holds the playlist; the same check that serves the portal picks it up.
    void this.poll(false);
  }

  private errorText(result: Extract<LoginResult, { status: 'error' }>): string {
    switch (result.code) {
      case 'invalid_code': return t('access.error.invalidCode');
      case 'code_not_found': return t('access.error.codeNotFound');
      case 'code_wrong_device': return t('access.error.codeWrongDevice');
      case 'max_devices':
        return result.max ? t('access.error.maxDevicesCount', { max: result.max }) : t('access.error.maxDevices');
      case 'expired': return t('access.status.expired');
      case 'blocked': return t('access.status.blocked');
      case 'missing_fields': return t('access.error.missingFields');
      case 'invalid_url': return t('access.error.invalidUrl');
      case 'invalid_credentials': return t('access.error.invalidCredentials');
      case 'server_unreachable': return t('access.error.serverUnreachable');
      case 'network': return t('access.status.offline');
      default: return t('access.detail.code', { code: result.detail ?? '' });
    }
  }

  private focusFirst(): void {
    const first = this.container.querySelector<HTMLElement>('[data-focusable]');
    if (first) this.nav.focus(first);
  }

  private async poll(manual: boolean): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.opened || this.refreshing) return;
    this.refreshing = true;
    this.render();
    const started = Date.now();
    let changed = false;
    try {
      changed = await ActivationService.refresh();
      if (manual) {
        const remaining = MIN_REFRESH_SPIN_MS - (Date.now() - started);
        if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, remaining));
      }
    } finally {
      this.refreshing = false;
    }
    if (!this.opened) return;
    if (changed && this.adoptAfter) {
      const before = this.adoptAfter;
      const arrived = StorageService.getPlaylists().filter(item => before.indexOf(item.id) === -1)[0];
      if (arrived) {
        this.adoptAfter = null;
        useOnlyPlaylist(arrived.id);
      }
    }
    this.render();
    if (changed) {
      this.handlers.onPlaylistChanged();
      return;
    }
    this.timer = setTimeout(() => { void this.poll(false); }, CONFIG.XSOL.ACTIVATION_POLL_INTERVAL_MS);
  }

  private statusDetail(snapshot: ActivationSnapshot): string {
    if (snapshot.status === 'refused') {
      return snapshot.errorCode === 'device_already_registered'
        ? t('access.detail.alreadyRegistered')
        : t('access.detail.code', { code: snapshot.errorCode });
    }
    if (snapshot.status !== 'active') return '';
    if (snapshot.lifetime) return t('access.detail.lifetime');
    const date = formatExpiry(snapshot.expiryDate);
    if (!date) return '';
    return t(snapshot.trial ? 'access.detail.trialUntil' : 'access.detail.validUntil', { date });
  }

  private listBlock(snapshot: ActivationSnapshot): Safe {
    const playlists = StorageService.getPlaylists();
    const rows = playlists.map((item) => {
      const inUse = item.enabled !== false;
      const confirming = this.pendingRemove === item.id;
      return html`
        <li class="access-row ${inUse ? 'is-in-use' : ''}" data-key="row:${item.id}">
          <button class="access-row-main" data-focusable data-access-action="use"
                  data-id="${item.id}" data-key="use:${item.id}">
            <span class="access-row-name">${item.name}</span>
            ${inUse ? html`<span class="access-row-state">${t('access.list.inUse')}</span>` : ''}
          </button>
          <button class="access-button access-row-remove ${confirming ? 'is-confirming' : ''}" data-focusable
                  data-access-action="remove" data-id="${item.id}" data-key="remove:${item.id}">${
            t(confirming ? 'access.list.confirmRemove' : 'common.remove')}</button>
        </li>`;
    });
    return html`
      <div class="access-list" data-key="access-list">
        <h2 class="access-list-title">${t('access.list.title')}</h2>
        ${rows.length
          ? html`<ul class="access-rows" id="access-rows" data-nav-container>${rows}</ul>`
          : html`<p class="access-list-empty" id="access-playlist">${
              t(snapshot.hasPlaylist ? 'access.playlist.linked' : 'access.playlist.none')}</p>`}
      </div>`;
  }

  private qr(deviceId: string): string {
    if (deviceId !== this.qrFor) {
      this.qrFor = deviceId;
      this.qrSrc = deviceId ? qrDataUrl(ActivationService.portalUrl(deviceId)) : '';
    }
    return this.qrSrc;
  }

  private loginBlock(): Safe {
    const notice = this.notice
      ? html`<p class="access-notice access-notice--${this.notice.kind}" id="access-notice"
                data-key="access-notice">${this.notice.text}</p>`
      : '';
    if (!this.formOpen) {
      return html`
        <div class="access-login" data-key="access-login">
          <h2 class="access-login-title">${t('access.login.title')}</h2>
          <div class="access-login-actions" data-nav-container>
            <button class="access-button" data-focusable data-access-action="login-open"
                    data-key="login-open">${t('access.login.fill')}</button>
          </div>
          ${notice}
        </div>`;
    }
    return html`
      <div class="access-login" data-key="access-login">
        <h2 class="access-login-title">${t('access.login.title')}</h2>
        <div class="access-form" data-key="access-form" data-nav-container>
          <label class="access-field" data-key="field-target">
            <span>${t('access.field.target')}</span>
            <input class="access-input" data-focusable data-access-field="target" data-key="input-target"
                   type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
          </label>
          <label class="access-field" data-key="field-username">
            <span>${t('access.field.username')}</span>
            <input class="access-input" data-focusable data-access-field="username" data-key="input-username"
                   type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
          </label>
          <label class="access-field" data-key="field-password">
            <span>${t('access.field.password')}</span>
            <input class="access-input" data-focusable data-access-field="password" data-key="input-password"
                   type="password" autocomplete="off">
          </label>
          <div class="access-form-actions">
            <button class="access-button access-button--primary" data-focusable
                    data-access-action="login-submit" data-key="login-submit">${t('access.login.submit')}</button>
            <button class="access-button" data-focusable data-access-action="login-cancel"
                    data-key="login-cancel">${t('common.cancel')}</button>
          </div>
        </div>
        ${notice}
      </div>`;
  }

  private render(): void {
    const snapshot = ActivationService.snapshot;
    const focusedKey = this.nav.focused?.dataset.key ?? '';
    const detail = this.statusDetail(snapshot);
    const qr = this.qr(snapshot.deviceId);
    const portal = CONFIG.XSOL.PORTAL_URL.replace(/^https?:\/\//, '');
    morph(this.container, html`
      <div class="access-view">
        <header class="access-header">
          <button class="access-button" data-focusable data-access-action="back" data-key="access-back">
            <span class="access-button-icon">${raw(BACK_ICON)}</span>
            <span>${t('common.back')}</span>
          </button>
          <button class="access-button ${this.refreshing ? 'is-refreshing' : ''}" data-focusable
                  data-access-action="refresh" data-key="access-refresh"
                  aria-busy="${String(this.refreshing)}">
            <span class="access-button-icon access-refresh-icon">${raw(RESYNC_ICON)}</span>
            <span>${t('access.refresh')}</span>
          </button>
        </header>
        <div class="access-body">
          <section class="access-identity" data-key="access-identity">
            <h1 class="access-title">${t('access.title')}</h1>
            <p class="access-intro">${t('access.intro', { portal })}</p>
            <dl class="access-codes">
              <div class="access-code" data-key="access-mac">
                <dt>${t('access.mac')}</dt>
                <dd class="access-code-value" id="access-mac">${snapshot.deviceId || '—'}</dd>
              </div>
              <div class="access-code" data-key="access-key">
                <dt>${t('access.key')}</dt>
                <dd class="access-code-value" id="access-key">${
                  snapshot.manageKey ? formatKey(snapshot.manageKey) : '—'}</dd>
              </div>
            </dl>
            <div class="access-status access-status--${snapshot.status}" data-key="access-status">
              <span class="access-status-dot"></span>
              <span class="access-status-text" id="access-status">${t(STATUS_KEY[snapshot.status])}</span>
              ${detail ? html`<span class="access-status-detail" id="access-status-detail">${detail}</span>` : ''}
            </div>
            ${ActivationService.locked ? html`
              <p class="access-locked" id="access-locked" data-key="access-locked">${t('access.lockedHint')}</p>` : ''}
            ${this.formOpen ? '' : this.listBlock(snapshot)}
            ${this.loginBlock()}
          </section>
          <section class="access-portal" data-key="access-portal">
            ${qr
              ? html`<img class="access-qr" data-key="access-qr" alt="${t('access.qrAlt')}" src="${qr}">`
              : html`<div class="access-qr access-qr--empty" data-key="access-qr-empty"></div>`}
            <p class="access-portal-hint">${t('access.qrHint')}</p>
            <p class="access-portal-url">${portal}</p>
          </section>
        </div>
      </div>
    `);
    // morph rewrites the class attribute, which drops the focus ring SpatialNav put there.
    if (focusedKey) {
      const again = this.container.querySelector<HTMLElement>(`[data-key="${focusedKey}"][data-focusable]`);
      if (again) this.nav.focus(again);
    }
  }
}
