import { normalizeXtreamBaseUrl } from '../../utils/xtream-url';
import { createLogger } from '../../utils/logger';
import { createXtreamClient } from '../xtream-client';
import { PanelClient, PanelError, type PanelResponse } from './panel-client';
import { isServerOnlyUrl, playlistFromDomain } from './activation-service';

const log = createLogger('Login');

export type LoginErrorCode =
  | 'invalid_code'
  | 'code_not_found'
  | 'code_wrong_device'
  | 'max_devices'
  | 'expired'
  | 'blocked'
  | 'missing_fields'
  | 'invalid_url'
  | 'invalid_credentials'
  | 'server_unreachable'
  | 'network'
  | 'server';

export type LoginResult =
  | { status: 'done' }
  /** The code named a server but no account: the user still has to enter one. */
  | { status: 'needs_account'; server: string }
  | { status: 'error'; code: LoginErrorCode; max?: number; detail?: string };

export interface LoginFields {
  /** A server URL, a complete playlist link, or a 5-6 digit playlist code. */
  target: string;
  username: string;
  password: string;
}

function message(response: PanelResponse): string {
  return typeof response.data.message === 'string' ? response.data.message : '';
}

function maxDevices(response: PanelResponse): number | undefined {
  const value = response.data.max_devices;
  return typeof value === 'number' ? value : undefined;
}

function refusal(response: PanelResponse): LoginResult {
  const text = message(response);
  const status = typeof response.data.status === 'string' ? response.data.status : '';
  if (text === 'invalid_code') return { status: 'error', code: 'invalid_code' };
  if (text === 'code_not_found' || text === 'invalid_playlist') return { status: 'error', code: 'code_not_found' };
  if (text === 'code_wrong_device') return { status: 'error', code: 'code_wrong_device' };
  if (text === 'code_max_devices' || text.indexOf('Max devices') === 0) {
    return { status: 'error', code: 'max_devices', max: maxDevices(response) };
  }
  if (status === 'expired') return { status: 'error', code: 'expired' };
  if (status === 'blocked') return { status: 'error', code: 'blocked' };
  return { status: 'error', code: 'server', detail: text || `http_${response.status}` };
}

function failure(error: unknown): LoginResult {
  if (error instanceof PanelError && error.code !== 'network') {
    return { status: 'error', code: 'server', detail: error.code };
  }
  return { status: 'error', code: 'network' };
}

function accepted(response: PanelResponse): boolean {
  return response.status === 200 && response.data.success === true;
}

function xtreamPlaylistUrl(server: string, username: string, password: string): string {
  return `${server}/get.php?username=${encodeURIComponent(username)}`
    + `&password=${encodeURIComponent(password)}&type=m3u_plus&output=ts`;
}

function withScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

/** A playlist code is 5-6 digits; spaces between them are how people read it out. */
export function playlistCodeFrom(target: string): string | null {
  const compact = target.replace(/\s+/g, '');
  return /^\d{5,6}$/.test(compact) ? compact : null;
}

// The account is checked against the IPTV server before the panel hears of it:
// binding a mistyped account would take a device slot and restart the trial.
async function verifyAccount(base: string, username: string, password: string): Promise<LoginResult | null> {
  let info;
  try {
    info = await createXtreamClient({ baseUrl: base, username, password }).getAccountInfo();
  } catch {
    info = null;
  }
  if (!info) return { status: 'error', code: 'server_unreachable' };
  if (!info.auth) return { status: 'error', code: 'invalid_credentials' };
  return null;
}

async function bindAndSave(base: string, username: string, password: string): Promise<LoginResult> {
  const invalid = await verifyAccount(base, username, password);
  if (invalid) return invalid;
  // The panel recognizes a partner by this host, and sets the validity from it.
  const bound = await PanelClient.bindAccount({ username, password, serverHost: base, manual: true });
  if (!accepted(bound)) return refusal(bound);
  const saved = await PanelClient.savePlaylist(xtreamPlaylistUrl(base, username, password));
  if (!accepted(saved)) return refusal(saved);
  log.info('Account signed in', 'event=login.account.completed');
  return { status: 'done' };
}

/**
 * Signing in on the TV, mirroring what the other XSol apps send. The panel is
 * called only here, on an explicit action: it restarts the trial clock on a
 * non-partner account every time an account is bound, so this must never run
 * on its own at launch.
 */
export const LoginService = {
  /**
   * One form: where to connect (a server URL, or the playlist code that stands
   * for one) plus the account. A code resolves to the URL registered for it on
   * the panel; a `get.php` link that already carries the account is taken apart
   * and treated as the three fields.
   */
  async signIn(fields: LoginFields): Promise<LoginResult> {
    const target = fields.target.trim();
    let username = fields.username.trim();
    let password = fields.password.trim();
    if (!target) return { status: 'error', code: 'missing_fields' };

    try {
      const code = playlistCodeFrom(target);
      if (code) {
        const response = await PanelClient.redeemPlaylistCode(code);
        if (!accepted(response)) return refusal(response);
        const url = typeof response.data.m3u_url === 'string' ? response.data.m3u_url.trim() : '';
        if (!url) return { status: 'error', code: 'code_not_found' };
        if (!isServerOnlyUrl(url)) {
          // The code carries its own account, as on the other apps.
          log.info('Playlist code redeemed', 'event=login.code.completed');
          return { status: 'done' };
        }
        const server = normalizeXtreamBaseUrl(url);
        if (!username || !password) return { status: 'needs_account', server };
        return await bindAndSave(server, username, password);
      }
      if (/^[\d\s]+$/.test(target)) return { status: 'error', code: 'invalid_code' };

      let server = withScheme(target);
      const embedded = playlistFromDomain(server, '');
      if (embedded && embedded.source === 'xtream' && embedded.xtream && !username && !password) {
        server = embedded.url;
        username = embedded.xtream.username;
        password = embedded.xtream.password;
      }
      if (!username && !password) {
        // A bare link: only meaningful when it points at a playlist file.
        if (isServerOnlyUrl(server)) return { status: 'error', code: 'missing_fields' };
        const saved = await PanelClient.savePlaylist(server);
        return accepted(saved) ? { status: 'done' } : refusal(saved);
      }
      if (!username || !password) return { status: 'error', code: 'missing_fields' };

      const base = normalizeXtreamBaseUrl(server.replace(/\/get\.php.*$/i, ''));
      if (!/^https?:\/\/[^/?#]+/i.test(base)) return { status: 'error', code: 'invalid_url' };
      return await bindAndSave(base, username, password);
    } catch (error) {
      return failure(error);
    }
  },
};
