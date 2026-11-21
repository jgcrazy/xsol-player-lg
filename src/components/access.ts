import type { Action } from '../types';
import { CONFIG } from '../config';
import { SpatialNav } from '../navigation/spatial-nav';
import {
  ActivationService,
  type ActivationSnapshot,
} from '../services/xsol/activation-service';
import { LoginService, type LoginResult } from '../services/xsol/login-service';
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

type LoginMode = 'closed' | 'code' | 'account';
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
 * here. It also lets the user sign in on the TV, with a code or an account.
 */
export class Access {
  private nav: SpatialNav;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private opened = false;
  private refreshing = false;
  private qrFor = '';
  private qrSrc = '';
  private mode: LoginMode = 'closed';
  private lockedServer = '';
  private submitting = false;
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
    this.render();
    this.focusFirst();
    void this.poll(false);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.mode = 'closed';
    this.lockedServer = '';
    this.notice = null;
  }

  handleAction(action: Action): void {
    if (action === 'back') {
      if (this.mode !== 'closed') this.setMode('closed');
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
    if (!this.nav.move(action) && action === 'up') this.handlers.onRevealTabBar();
  }

  private activate(control: HTMLElement): void {
    if (control instanceof HTMLInputElement) {
      control.focus();
      return;
    }
    const action = control.dataset.accessAction;
    if (action === 'back') this.handlers.onBack();
    else if (action === 'refresh') void this.poll(true);
    else if (action === 'login-code') this.setMode('code');
    else if (action === 'login-account') this.setMode('account');
    else if (action === 'login-cancel') this.setMode('closed');
    else if (action === 'login-submit') void this.submit();
  }

  private setMode(mode: LoginMode): void {
    this.mode = mode;
    this.lockedServer = '';
    this.notice = null;
    this.render();
    const target = mode === 'closed'
      ? this.container.querySelector<HTMLElement>('[data-access-action="login-code"]')
      : this.container.querySelector<HTMLElement>('.access-form [data-focusable]');
    if (target) this.nav.focus(target);
  }

  private field(name: string): string {
    return this.container.querySelector<HTMLInputElement>(`[data-access-field="${name}"]`)?.value ?? '';
  }

  private async submit(): Promise<void> {
    if (this.submitting || this.mode === 'closed') return;
    const mode = this.mode;
    this.submitting = true;
    this.notice = { kind: 'info', text: t('access.login.working') };
    this.render();
    let result: LoginResult;
    try {
      result = mode === 'code'
        ? await LoginService.redeemCode(this.field('code'))
        : await LoginService.signIn({
            server: this.lockedServer || this.field('server'),
            username: this.field('username'),
            password: this.field('password'),
          });
    } finally {
      this.submitting = false;
    }
    if (!this.opened) return;

    if (result.status === 'needs_account') {
      // The code was good and named the server; only the account is missing.
      this.mode = 'account';
      this.lockedServer = result.server;
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
    this.mode = 'closed';
    this.lockedServer = '';
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

  private playlistText(snapshot: ActivationSnapshot): string {
    if (snapshot.playlistName) return snapshot.playlistName;
    return t(snapshot.hasPlaylist ? 'access.playlist.linked' : 'access.playlist.none');
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
    if (this.mode === 'closed') {
      return html`
        <div class="access-login" data-key="access-login">
          <h2 class="access-login-title">${t('access.login.title')}</h2>
          <div class="access-login-actions" data-nav-container>
            <button class="access-button" data-focusable data-access-action="login-code"
                    data-key="login-code">${t('access.login.withCode')}</button>
            <button class="access-button" data-focusable data-access-action="login-account"
                    data-key="login-account">${t('access.login.withAccount')}</button>
          </div>
          ${notice}
        </div>`;
    }
    const fields = this.mode === 'code'
      ? html`
          <label class="access-field" data-key="field-code">
            <span>${t('access.field.code')}</span>
            <input class="access-input" data-focusable data-access-field="code" data-key="input-code"
                   type="text" inputmode="numeric" maxlength="6" autocomplete="off">
          </label>`
      : html`
          ${this.lockedServer
            ? html`<p class="access-locked-server" data-key="locked-server">${this.lockedServer}</p>`
            : html`
              <label class="access-field" data-key="field-server">
                <span>${t('access.field.server')}</span>
                <input class="access-input" data-focusable data-access-field="server" data-key="input-server"
                       type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
              </label>`}
          <label class="access-field" data-key="field-username">
            <span>${t('access.field.username')}</span>
            <input class="access-input" data-focusable data-access-field="username" data-key="input-username"
                   type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
          </label>
          <label class="access-field" data-key="field-password">
            <span>${t('access.field.password')}</span>
            <input class="access-input" data-focusable data-access-field="password" data-key="input-password"
                   type="password" autocomplete="off">
          </label>`;
    return html`
      <div class="access-login" data-key="access-login">
        <h2 class="access-login-title">${
          t(this.mode === 'code' ? 'access.login.withCode' : 'access.login.withAccount')}</h2>
        <div class="access-form" data-key="access-form:${this.mode}" data-nav-container>
          ${fields}
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
            <div class="access-playlist" data-key="access-playlist">
              <span class="access-playlist-label">${t('access.playlist.label')}</span>
              <span class="access-playlist-name" id="access-playlist">${this.playlistText(snapshot)}</span>
            </div>
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
