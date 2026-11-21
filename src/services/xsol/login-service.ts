import { normalizeXtreamBaseUrl } from '../../utils/xtream-url';
import { createLogger } from '../../utils/logger';
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
  | 'network'
  | 'server';

export type LoginResult =
  | { status: 'done' }
  /** The code named a server but no account: the user still has to enter one. */
  | { status: 'needs_account'; server: string }
  | { status: 'error'; code: LoginErrorCode; max?: number; detail?: string };

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

/**
 * Signing in on the TV, mirroring what the other XSol apps send. The panel is
 * called only here, on an explicit action: it restarts the trial clock on a
 * non-partner account every time an account is bound, so this must never run
 * on its own at launch.
 */
export const LoginService = {
  /** A 5-6 digit playlist code handed out by the provider. */
  async redeemCode(rawCode: string): Promise<LoginResult> {
    const code = rawCode.replace(/\D/g, '');
    if (code.length < 5 || code.length > 6) return { status: 'error', code: 'invalid_code' };
    try {
      const response = await PanelClient.redeemPlaylistCode(code);
      if (!accepted(response)) return refusal(response);
      const url = typeof response.data.m3u_url === 'string' ? response.data.m3u_url.trim() : '';
      if (!url) return { status: 'error', code: 'code_not_found' };
      if (isServerOnlyUrl(url)) return { status: 'needs_account', server: normalizeXtreamBaseUrl(url) };
      log.info('Playlist code redeemed', 'event=login.code.completed');
      return { status: 'done' };
    } catch (error) {
      return failure(error);
    }
  },

  /**
   * Server + username + password, or a complete playlist link on its own. A
   * `get.php` link that already carries the account is taken apart and treated
   * as the three fields.
   */
  async signIn(fields: { server: string; username: string; password: string }): Promise<LoginResult> {
    let server = fields.server.trim();
    let username = fields.username.trim();
    let password = fields.password.trim();
    if (!server) return { status: 'error', code: 'missing_fields' };

    const embedded = playlistFromDomain(/^https?:\/\//i.test(server) ? server : `http://${server}`, '');
    if (embedded && embedded.source === 'xtream' && embedded.xtream && !username && !password) {
      server = embedded.url;
      username = embedded.xtream.username;
      password = embedded.xtream.password;
    }

    try {
      if (!username && !password) {
        // A bare link: only meaningful when it points at a playlist file.
        const url = /^https?:\/\//i.test(server) ? server : `http://${server}`;
        if (isServerOnlyUrl(url)) return { status: 'error', code: 'missing_fields' };
        const saved = await PanelClient.savePlaylist(url);
        return accepted(saved) ? { status: 'done' } : refusal(saved);
      }
      if (!username || !password) return { status: 'error', code: 'missing_fields' };

      const base = normalizeXtreamBaseUrl(server.replace(/\/get\.php.*$/i, ''));
      if (!/^https?:\/\/[^/?#]+/i.test(base)) return { status: 'error', code: 'invalid_url' };
      const bound = await PanelClient.bindAccount({
        username, password, serverHost: base, manual: true,
      });
      if (!accepted(bound)) return refusal(bound);
      const saved = await PanelClient.savePlaylist(xtreamPlaylistUrl(base, username, password));
      if (!accepted(saved)) return refusal(saved);
      log.info('Account signed in', 'event=login.account.completed');
      return { status: 'done' };
    } catch (error) {
      return failure(error);
    }
  },
};
