// @vitest-environment jsdom
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../config';
import { StorageService } from '../storage-service';
import { resetDeviceIdentityForTests } from './device-identity';
import { PanelClient, PanelError } from './panel-client';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  body: Record<string, unknown>;
}

interface Reply {
  status: number;
  data?: Record<string, unknown>;
}

const API = CONFIG.XSOL.API_PREFIX;
const TOKEN_1 = new Array(65).join('a');
const TOKEN_2 = new Array(65).join('b');

class FakePanel {
  calls: Call[] = [];
  secret = new Array(65).join('1');
  registrations = 0;
  serverTime = 2000000000;
  registerReply: Reply | null = null;
  signedReply: (call: Call) => Reply = () => ({ status: 200, data: { success: true } });

  signatureIsValid(call: Call): boolean {
    const canonical = [
      call.headers['X-Device-Timestamp'],
      call.headers['X-Device-Nonce'],
      call.method,
      call.path,
      call.rawBody,
    ].join('\n');
    return createHmac('sha256', this.secret).update(canonical).digest('hex')
      === call.headers['X-Device-Signature'];
  }

  handle(call: Call): Reply {
    if (call.path === `${API}/time`) {
      return { status: 200, data: { success: true, server_time: this.serverTime } };
    }
    if (call.path === `${API}/register`) {
      this.registrations++;
      if (this.registerReply) return this.registerReply;
      return {
        status: 200,
        data: {
          success: true,
          device_secret: this.secret,
          device_token: TOKEN_1,
          manage_key: '123456',
          server_time: this.serverTime,
        },
      };
    }
    return this.signedReply(call);
  }

  signedCalls(): Call[] {
    return this.calls.filter(c => c.path !== `${API}/time` && c.path !== `${API}/register`);
  }
}

let panel: FakePanel;

function installPanel(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const call: Call = {
      method: init.method ?? 'GET',
      path: url.slice(CONFIG.XSOL.PANEL_BASE_URL.length),
      headers: (init.headers ?? {}) as Record<string, string>,
      rawBody,
      body: rawBody ? JSON.parse(rawBody) : {},
    };
    panel.calls.push(call);
    const reply = panel.handle(call);
    return { status: reply.status, json: async () => reply.data ?? {} };
  }));
}

beforeEach(() => {
  localStorage.clear();
  resetDeviceIdentityForTests();
  PanelClient.resetForTests();
  panel = new FakePanel();
  installPanel();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PanelClient registration', () => {
  it('registers once, then signs with the secret the panel issued', async () => {
    await PanelClient.checkActivation();
    await PanelClient.checkActivation();

    expect(panel.registrations).toBe(1);
    const register = panel.calls.find(c => c.path === `${API}/register`)!;
    const link = StorageService.getDeviceLink();
    expect(register.body).toEqual({
      device_id: link.deviceId,
      device_proof: link.proof,
      device_name: CONFIG.XSOL.DEVICE_NAME,
      app_version: CONFIG.VERSION,
      platform: 'webos',
    });
    expect(register.headers['X-Device-Signature']).toBeUndefined();

    const signed = panel.signedCalls();
    expect(signed).toHaveLength(2);
    for (const call of signed) {
      expect(call.path).toBe(`${API}/check-activation`);
      expect(call.headers['X-Device-Id']).toBe(link.deviceId);
      expect(call.headers['X-Device-Nonce']).toMatch(/^[a-f0-9]{32}$/);
      expect(call.body.device_id).toBe(link.deviceId);
      expect(panel.signatureIsValid(call)).toBe(true);
    }
    expect(signed[0].headers['X-Device-Nonce']).not.toBe(signed[1].headers['X-Device-Nonce']);
  });

  it('keeps the secret, the ownership token and the portal key from registration', async () => {
    await PanelClient.ensureRegistered();

    const link = StorageService.getDeviceLink();
    expect(link.secret).toBe(panel.secret);
    expect(link.deviceToken).toBe(TOKEN_1);
    expect(link.manageKey).toBe('123456');
  });

  it('never sends the hardware proof or the secret on a signed call', async () => {
    await PanelClient.checkActivation();

    const call = panel.signedCalls()[0];
    const link = StorageService.getDeviceLink();
    expect(call.rawBody.indexOf(link.proof!)).toBe(-1);
    expect(call.rawBody.indexOf(panel.secret)).toBe(-1);
    expect(call.body.device_token).toBe(TOKEN_1);
    expect(call.body.mac_address).toBeUndefined();
    expect(call.body.hardware_fingerprint).toBeUndefined();
  });

  it('surfaces a refused registration with the panel code', async () => {
    panel.registerReply = { status: 409, data: { success: false, message: 'device_already_registered' } };

    const error = await PanelClient.checkActivation().catch(e => e);
    expect(error).toBeInstanceOf(PanelError);
    expect((error as PanelError).code).toBe('device_already_registered');
    expect((error as PanelError).status).toBe(409);
    expect(StorageService.getDeviceLink().secret).toBeUndefined();
    expect(panel.signedCalls()).toHaveLength(0);
  });

  it('shares one registration between concurrent first calls', async () => {
    await Promise.all([PanelClient.checkActivation(), PanelClient.heartbeat()]);
    expect(panel.registrations).toBe(1);
  });
});

describe('PanelClient signed calls', () => {
  it('signs with the panel clock, not the TV clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1000000000 * 1000));

    await PanelClient.checkActivation();

    expect(panel.signedCalls()[0].headers['X-Device-Timestamp']).toBe(String(panel.serverTime));
  });

  it('re-signs once with the corrected time after timestamp_expired', async () => {
    let attempts = 0;
    panel.signedReply = () => {
      attempts++;
      return attempts === 1
        ? { status: 401, data: { success: false, message: 'timestamp_expired', server_time: panel.serverTime + 900 } }
        : { status: 200, data: { success: true } };
    };

    const response = await PanelClient.checkActivation();

    expect(response.status).toBe(200);
    const signed = panel.signedCalls();
    expect(signed).toHaveLength(2);
    expect(Number(signed[1].headers['X-Device-Timestamp']) - Number(signed[0].headers['X-Device-Timestamp']))
      .toBeGreaterThanOrEqual(899);
    expect(panel.registrations).toBe(1);
  });

  it('registers again when the panel no longer accepts the secret', async () => {
    await PanelClient.ensureRegistered();
    panel.secret = new Array(65).join('2');
    panel.signedReply = (call) => (panel.signatureIsValid(call)
      ? { status: 200, data: { success: true, activated: true } }
      : { status: 401, data: { success: false, message: 'invalid_signature' } });

    const response = await PanelClient.checkActivation();

    expect(response.status).toBe(200);
    expect(panel.registrations).toBe(2);
    expect(StorageService.getDeviceLink().secret).toBe(panel.secret);
  });

  it('does not loop on registration when the panel keeps refusing', async () => {
    await PanelClient.ensureRegistered();
    panel.signedReply = () => ({ status: 401, data: { success: false, message: 'unknown_device' } });

    const first = await PanelClient.checkActivation();
    const second = await PanelClient.checkActivation();

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    // One forced re-registration, then the cooldown holds.
    expect(panel.registrations).toBe(2);
  });

  it('leaves a revoked credential alone', async () => {
    await PanelClient.ensureRegistered();
    panel.signedReply = () => ({ status: 401, data: { success: false, message: 'credential_revoked' } });

    const response = await PanelClient.checkActivation();

    expect(response.data.message).toBe('credential_revoked');
    expect(panel.registrations).toBe(1);
  });

  it('stores a newly issued ownership token and key even on a refusal', async () => {
    await PanelClient.ensureRegistered();
    panel.signedReply = () => ({
      status: 403,
      data: { success: false, message: 'Device activation has expired', device_token: TOKEN_2, manage_key: '654321' },
    });

    await PanelClient.checkActivation();

    const link = StorageService.getDeviceLink();
    expect(link.deviceToken).toBe(TOKEN_2);
    expect(link.manageKey).toBe('654321');
  });

  it('returns business refusals to the caller instead of throwing', async () => {
    panel.signedReply = () => ({ status: 409, data: { success: false, message: 'code_max_devices', max_devices: 2 } });

    const response = await PanelClient.redeemPlaylistCode('12345');

    expect(response.status).toBe(409);
    expect(response.data.max_devices).toBe(2);
    expect(panel.signedCalls()[0].body.code).toBe('12345');
  });

  it('throws a network PanelError when the panel is unreachable', async () => {
    await PanelClient.ensureRegistered();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));

    const error = await PanelClient.checkActivation().catch(e => e);
    expect(error).toBeInstanceOf(PanelError);
    expect((error as PanelError).code).toBe('network');
  });
});

describe('PanelClient endpoints', () => {
  it('reports what is playing, and clears it explicitly', async () => {
    await PanelClient.heartbeat({ type: 'live', title: 'ch1', streamId: '7' });
    await PanelClient.heartbeat(null);
    await PanelClient.heartbeat();

    const [watching, cleared, plain] = panel.signedCalls();
    expect(watching.path).toBe(`${API}/heartbeat`);
    expect(watching.body).toMatchObject({ watching_type: 'live', watching_title: 'ch1', watching_stream_id: '7' });
    expect(cleared.body).toMatchObject({ watching_type: '', watching_title: '' });
    expect('watching_type' in plain.body).toBe(false);
  });

  it('binds an account and saves a playlist with the panel field names', async () => {
    await PanelClient.bindAccount({ username: 'u1', password: 'p1', serverHost: 'http://host', manual: true });
    await PanelClient.savePlaylist('http://host/a');

    const [bind, save] = panel.signedCalls();
    expect(bind.path).toBe(`${API}/bind-account`);
    expect(bind.body).toMatchObject({ username: 'u1', password: 'p1', server_host: 'http://host', manual: true });
    expect(save.path).toBe(`${API}/save-playlist`);
    expect(save.body.playlist_url).toBe('http://host/a');
    expect(panel.signatureIsValid(bind)).toBe(true);
    expect(panel.signatureIsValid(save)).toBe(true);
  });
});
