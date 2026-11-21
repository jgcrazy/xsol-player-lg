// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginService, playlistCodeFrom } from './login-service';
import { PanelClient, PanelError, type PanelResponse } from './panel-client';

const xtream = vi.hoisted(() => ({
  getAccountInfo: vi.fn(),
  created: [] as Array<{ baseUrl: string; username: string; password: string }>,
}));
vi.mock('../xtream-client', () => ({
  createXtreamClient: (creds: { baseUrl: string; username: string; password: string }) => {
    xtream.created.push(creds);
    return { getAccountInfo: xtream.getAccountInfo };
  },
}));

function reply(status: number, data: Record<string, unknown>): PanelResponse {
  return { status, data };
}

describe('playlistCodeFrom', () => {
  it.each([['12345', '12345'], [' 12 345 ', '12345'], ['123456', '123456']])('reads %j as a code', (raw, code) => {
    expect(playlistCodeFrom(raw)).toBe(code);
  });

  it.each(['', '1234', '1234567', 'host', 'host:8080', '12345a', 'http://host'])('does not take %j for a code', (raw) => {
    expect(playlistCodeFrom(raw)).toBeNull();
  });
});

describe('LoginService.signIn', () => {
  let redeem: ReturnType<typeof vi.spyOn>;
  let bind: ReturnType<typeof vi.spyOn>;
  let save: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    xtream.created.length = 0;
    xtream.getAccountInfo.mockReset().mockResolvedValue({ auth: true });
    redeem = vi.spyOn(PanelClient, 'redeemPlaylistCode').mockResolvedValue(reply(200, { success: true }));
    bind = vi.spyOn(PanelClient, 'bindAccount').mockResolvedValue(reply(200, { success: true }));
    save = vi.spyOn(PanelClient, 'savePlaylist').mockResolvedValue(reply(200, { success: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with a server URL', () => {
    it('checks the account on the server, binds it as a manual login, then saves the playlist', async () => {
      const result = await LoginService.signIn({ target: ' host:8080/ ', username: ' u1 ', password: 'p&1' });

      expect(result).toEqual({ status: 'done' });
      expect(xtream.created).toEqual([{ baseUrl: 'http://host:8080', username: 'u1', password: 'p&1' }]);
      // The host is what the panel compares with its partner codes.
      expect(bind).toHaveBeenCalledWith({
        username: 'u1', password: 'p&1', serverHost: 'http://host:8080', manual: true,
      });
      expect(save).toHaveBeenCalledWith(
        'http://host:8080/get.php?username=u1&password=p%261&type=m3u_plus&output=ts',
      );
      expect(redeem).not.toHaveBeenCalled();
    });

    it('never tells the panel about an account the server refuses', async () => {
      xtream.getAccountInfo.mockResolvedValue({ auth: false });

      expect(await LoginService.signIn({ target: 'http://host', username: 'u1', password: 'p1' }))
        .toEqual({ status: 'error', code: 'invalid_credentials' });
      expect(bind).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it.each([
      ['answers nothing usable', () => Promise.resolve(null)],
      ['cannot be reached', () => Promise.reject(new Error('x'))],
    ])('stops when the server %s', async (_label, answer) => {
      xtream.getAccountInfo.mockImplementation(answer);

      expect(await LoginService.signIn({ target: 'http://host', username: 'u1', password: 'p1' }))
        .toEqual({ status: 'error', code: 'server_unreachable' });
      expect(bind).not.toHaveBeenCalled();
    });

    it('takes a pasted get.php link apart instead of asking for the fields again', async () => {
      await LoginService.signIn({
        target: 'https://host/a/get.php?username=u1&password=p1&type=m3u_plus', username: '', password: '',
      });

      expect(bind).toHaveBeenCalledWith({
        username: 'u1', password: 'p1', serverHost: 'https://host/a', manual: true,
      });
      expect(save).toHaveBeenCalledWith(
        'https://host/a/get.php?username=u1&password=p1&type=m3u_plus&output=ts',
      );
    });

    it('saves a bare playlist link without binding an account', async () => {
      expect(await LoginService.signIn({ target: 'http://host/a.m3u', username: '', password: '' }))
        .toEqual({ status: 'done' });

      expect(bind).not.toHaveBeenCalled();
      expect(xtream.getAccountInfo).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledWith('http://host/a.m3u');
    });

    it.each([
      [{ target: '', username: 'u1', password: 'p1' }],
      [{ target: 'http://host', username: '', password: '' }],
      [{ target: 'http://host', username: 'u1', password: '' }],
      [{ target: 'http://host', username: '', password: 'p1' }],
    ])('asks for what is missing %j', async (fields) => {
      expect(await LoginService.signIn(fields)).toEqual({ status: 'error', code: 'missing_fields' });
      expect(bind).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it('does not save a playlist when the account is refused by the panel', async () => {
      bind.mockResolvedValue(reply(409, {
        success: false, message: 'Max devices reached for this account', max_devices: 3,
      }));

      expect(await LoginService.signIn({ target: 'http://host', username: 'u1', password: 'p1' }))
        .toEqual({ status: 'error', code: 'max_devices', max: 3 });
      expect(save).not.toHaveBeenCalled();
    });

    it.each([
      [{ success: false, message: 'Device activation has expired', status: 'expired' }, 'expired'],
      [{ success: false, message: 'Device is blocked', status: 'blocked' }, 'blocked'],
    ])('reports an activation problem raised while saving %j', async (data, code) => {
      save.mockResolvedValue(reply(403, data));

      expect(await LoginService.signIn({ target: 'http://host', username: 'u1', password: 'p1' }))
        .toEqual({ status: 'error', code });
    });

    it('reports a network failure', async () => {
      bind.mockRejectedValue(new PanelError(0, 'network'));

      expect(await LoginService.signIn({ target: 'http://host', username: 'u1', password: 'p1' }))
        .toEqual({ status: 'error', code: 'network' });
    });
  });

  describe('with a playlist code', () => {
    it('uses the server registered for the code, with the account that was typed', async () => {
      redeem.mockResolvedValue(reply(200, { success: true, m3u_url: 'http://host:8080/' }));

      expect(await LoginService.signIn({ target: ' 12 345 ', username: 'u1', password: 'p1' }))
        .toEqual({ status: 'done' });

      expect(redeem).toHaveBeenCalledWith('12345');
      expect(xtream.created).toEqual([{ baseUrl: 'http://host:8080', username: 'u1', password: 'p1' }]);
      expect(bind).toHaveBeenCalledWith({
        username: 'u1', password: 'p1', serverHost: 'http://host:8080', manual: true,
      });
      expect(save).toHaveBeenCalledWith('http://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts');
    });

    it.each(['http://host:8080', 'http://host:8080/', 'https://host'])(
      'asks for the account when the code only names the server %s',
      async (url) => {
        redeem.mockResolvedValue(reply(200, { success: true, m3u_url: url }));

        expect(await LoginService.signIn({ target: '123456', username: '', password: '' })).toEqual({
          status: 'needs_account', server: url.replace(/\/$/, ''),
        });
        expect(bind).not.toHaveBeenCalled();
      },
    );

    it('is done on its own when the code carries the account', async () => {
      redeem.mockResolvedValue(reply(200, {
        success: true, m3u_url: 'http://host/get.php?username=u1&password=p1',
      }));

      expect(await LoginService.signIn({ target: '12345', username: '', password: '' })).toEqual({ status: 'done' });
      expect(bind).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it('refuses a wrong account on the code server', async () => {
      redeem.mockResolvedValue(reply(200, { success: true, m3u_url: 'http://host' }));
      xtream.getAccountInfo.mockResolvedValue({ auth: false });

      expect(await LoginService.signIn({ target: '12345', username: 'u1', password: 'p1' }))
        .toEqual({ status: 'error', code: 'invalid_credentials' });
      expect(bind).not.toHaveBeenCalled();
    });

    it.each(['1234', '1234567', '12 34'])('rejects the malformed code %j without calling the panel', async (code) => {
      expect(await LoginService.signIn({ target: code, username: 'u1', password: 'p1' }))
        .toEqual({ status: 'error', code: 'invalid_code' });
      expect(redeem).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
    });

    it.each([
      [404, { success: false, message: 'code_not_found' }, { code: 'code_not_found' }],
      [404, { success: false, message: 'invalid_playlist' }, { code: 'code_not_found' }],
      [403, { success: false, message: 'code_wrong_device' }, { code: 'code_wrong_device' }],
      [409, { success: false, message: 'code_max_devices', max_devices: 2 }, { code: 'max_devices', max: 2 }],
      [400, { success: false, message: 'invalid_code' }, { code: 'invalid_code' }],
      [500, {}, { code: 'server', detail: 'http_500' }],
    ])('maps the panel refusal %i %j', async (status, data, expected) => {
      redeem.mockResolvedValue(reply(status, data));

      expect(await LoginService.signIn({ target: '12345', username: 'u1', password: 'p1' }))
        .toMatchObject({ status: 'error', ...expected });
      expect(bind).not.toHaveBeenCalled();
    });

    it('treats a success without a playlist as an unknown code', async () => {
      redeem.mockResolvedValue(reply(200, { success: true, m3u_url: '' }));

      expect(await LoginService.signIn({ target: '12345', username: '', password: '' }))
        .toEqual({ status: 'error', code: 'code_not_found' });
    });

    it('reports the network and registration failures', async () => {
      redeem.mockRejectedValue(new PanelError(0, 'network'));
      expect(await LoginService.signIn({ target: '12345', username: '', password: '' }))
        .toEqual({ status: 'error', code: 'network' });

      redeem.mockRejectedValue(new PanelError(409, 'device_already_registered'));
      expect(await LoginService.signIn({ target: '12345', username: '', password: '' }))
        .toEqual({ status: 'error', code: 'server', detail: 'device_already_registered' });
    });
  });
});
