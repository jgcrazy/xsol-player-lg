// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageService } from '../storage-service';
import {
  proofFromSeed,
  pseudoMacFromSeed,
  resetDeviceIdentityForTests,
  resolveDeviceIdentity,
} from './device-identity';

const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

type BridgeWindow = { PalmServiceBridge?: unknown };

function installBridge(reply: (uri: string, payload: string) => string | null): void {
  class FakeBridge {
    onservicecallback: ((message: string) => void) | null = null;
    call(uri: string, payload: string): void {
      const message = reply(uri, payload);
      if (message !== null) setTimeout(() => this.onservicecallback?.(message), 0);
    }
    cancel(): void {}
  }
  (window as unknown as BridgeWindow).PalmServiceBridge = FakeBridge;
}

beforeEach(() => {
  localStorage.clear();
  resetDeviceIdentityForTests();
});

afterEach(() => {
  delete (window as unknown as BridgeWindow).PalmServiceBridge;
});

describe('pseudoMacFromSeed', () => {
  it('always yields a locally administered, unicast MAC', () => {
    for (let i = 0; i < 300; i++) {
      const mac = pseudoMacFromSeed(`seed-${i}`);
      expect(mac).toMatch(MAC);
      const firstByte = parseInt(mac.slice(0, 2), 16);
      expect(firstByte & 0x02).toBe(0x02);
      expect(firstByte & 0x01).toBe(0);
    }
  });

  it('is stable for a seed and differs between seeds', () => {
    expect(pseudoMacFromSeed('tv-1')).toBe(pseudoMacFromSeed('tv-1'));
    expect(pseudoMacFromSeed('tv-1')).not.toBe(pseudoMacFromSeed('tv-2'));
  });
});

describe('proofFromSeed', () => {
  it('is a 64-hex digest unrelated to the MAC digits', () => {
    const proof = proofFromSeed('tv-1');
    expect(proof).toMatch(/^[a-f0-9]{64}$/);
    const macDigits = pseudoMacFromSeed('tv-1').replace(/:/g, '').toLowerCase();
    expect(proof.indexOf(macDigits.slice(2))).toBe(-1);
  });
});

describe('resolveDeviceIdentity', () => {
  it('generates and keeps an install identity when the TV exposes no id', async () => {
    const first = await resolveDeviceIdentity();
    expect(first.source).toBe('install');
    expect(first.deviceId).toMatch(MAC);

    resetDeviceIdentityForTests();
    const second = await resolveDeviceIdentity();
    expect(second).toEqual(first);
  });

  it('derives the identity from the TV id, so a reinstall gets the same one', async () => {
    let seenUri = '';
    let seenPayload = '';
    installBridge((uri, payload) => {
      seenUri = uri;
      seenPayload = payload;
      return JSON.stringify({ returnValue: true, idList: [{ idType: 'LGUDID', idValue: 'id-1' }] });
    });

    const first = await resolveDeviceIdentity();
    expect(seenUri).toBe('luna://com.webos.service.sm/deviceid/getIDs');
    expect(JSON.parse(seenPayload)).toEqual({ idType: ['LGUDID'] });
    expect(first).toEqual({
      deviceId: pseudoMacFromSeed('id-1'),
      proof: proofFromSeed('id-1'),
      source: 'hardware',
    });

    localStorage.clear();
    resetDeviceIdentityForTests();
    expect(await resolveDeviceIdentity()).toEqual(first);
  });

  it('falls back to an install identity when the id request fails', async () => {
    installBridge(() => JSON.stringify({ returnValue: false, errorCode: 5, errorText: 'denied' }));
    const identity = await resolveDeviceIdentity();
    expect(identity.source).toBe('install');
  });

  it('shares one resolution between concurrent callers', async () => {
    const [a, b] = await Promise.all([resolveDeviceIdentity(), resolveDeviceIdentity()]);
    expect(a).toEqual(b);
  });

  it('survives an app reset', async () => {
    const before = await resolveDeviceIdentity();
    localStorage.setItem('iptv_other', '"x"');
    StorageService.clearAll();
    resetDeviceIdentityForTests();

    expect(localStorage.getItem('iptv_other')).toBeNull();
    expect(await resolveDeviceIdentity()).toEqual(before);
  });
});
