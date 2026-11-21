import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, sha256, sha256Hex, toHex, utf8Bytes } from './sha256';

describe('sha256', () => {
  it('matches the published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with the platform digest across every padding boundary', () => {
    for (let length = 0; length <= 200; length++) {
      const text = new Array(length + 1).join('a');
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
    }
  });

  it('hashes non-ASCII text as UTF-8', () => {
    const text = 'Ação é 中文 😀';
    expect(toHex(utf8Bytes(text))).toBe(Buffer.from(text, 'utf8').toString('hex'));
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('hashes binary input', () => {
    const bytes = new Uint8Array(300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    expect(toHex(sha256(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('hmacSha256Hex', () => {
  it('matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('agrees with the platform HMAC for short, block-sized and long keys', () => {
    const message = 'l1\nl2\nPOST\n/a/b\n{"k":"v"}';
    for (const keyLength of [1, 32, 63, 64, 65, 200]) {
      const key = new Array(keyLength + 1).join('k');
      expect(hmacSha256Hex(key, message))
        .toBe(createHmac('sha256', key).update(message).digest('hex'));
    }
  });
});
