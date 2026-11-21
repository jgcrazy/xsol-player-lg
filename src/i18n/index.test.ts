// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  formatNumber,
  isLocalePreference,
  localeOptions,
  resolveLocale,
  setLocale,
  t,
  tp,
  validateTranslations,
} from './index';

describe('i18n', () => {
  it('returns and interpolates English messages', () => {
    expect(t('channel.recentlyWatched')).toBe('Recently Watched');
    expect(tp('channel.count', 12)).toBe('12 channels');
    expect(t('app.loadingChannelsProgress', {
      processed: 1024,
      kept: 512,
    })).toBe('Loading channels… 1024 processed, 512 kept');
  });

  it('follows a Portuguese or English system language, and falls back to Portuguese', () => {
    expect(resolveLocale('system', 'pt-BR')).toBe('pt-BR');
    expect(resolveLocale('system', 'pt-PT')).toBe('pt-BR');
    expect(resolveLocale('system', 'en-US')).toBe('en');
    expect(resolveLocale('system', 'en')).toBe('en');
    // Anything else gets the product's own language.
    expect(resolveLocale('system', 'l1-L1')).toBe('pt-BR');
    expect(resolveLocale('system', 'l2')).toBe('pt-BR');
    expect(resolveLocale('en', 'pt-BR')).toBe('en');
    expect(resolveLocale('pt-BR', 'en-US')).toBe('pt-BR');
  });

  it('recognizes only the two registered locales as preferences', () => {
    expect(isLocalePreference('system')).toBe(true);
    expect(isLocalePreference('en')).toBe(true);
    expect(isLocalePreference('pt-BR')).toBe(true);
    // A preference saved for a language that no longer ships is dropped.
    expect(isLocalePreference('l1')).toBe(false);
    expect(isLocalePreference('l2-L2')).toBe(false);
  });

  it('exposes Portuguese as the default, then English, as the Settings options', () => {
    expect(DEFAULT_LOCALE).toBe('pt-BR');
    expect(localeOptions()).toEqual([
      { value: 'pt-BR', label: 'Português (Brasil)' },
      { value: 'en', label: 'English' },
    ]);
  });

  it('pluralizes refresh-hour options in both locales', () => {
    setLocale('en');
    expect(tp('settings.refreshHours', 1)).toBe('1 hour');
    expect(tp('settings.refreshHours', 3)).toBe('3 hours');
    setLocale('pt-BR');
    expect(tp('settings.refreshHours', 1)).toBe('1 hora');
    expect(tp('settings.refreshHours', 3)).toBe('3 horas');
  });

  it('formats and pluralizes second durations by locale', () => {
    const duration = (seconds: number) => tp('settings.durationSeconds', seconds, {
      seconds: formatNumber(seconds, { maximumFractionDigits: 1 }),
    });

    setLocale('en');
    expect(duration(1)).toBe('1 second');
    expect(duration(1.2)).toBe('1.2 seconds');
    expect(duration(3)).toBe('3 seconds');

    setLocale('pt-BR');
    expect(duration(1)).toContain('1 ');
    expect(duration(1.2)).toContain('1,2 ');
    expect(duration(1)).not.toBe(duration(3).replace('3', '1'));
  });

  it('translates and interpolates Brazilian Portuguese messages', () => {
    setLocale('pt-BR');
    expect(t('channel.recentlyWatched')).toBe('Assistidos recentemente');
    expect(tp('channel.count', 12)).toBe('12 canais');
    expect(document.documentElement.lang).toBe('pt-BR');
  });

  it('enables pseudo-localization without exposing another locale option', () => {
    window.history.pushState({}, '', '?pseudo=1');
    try {
      setLocale('en');
      expect(tp('channel.count', 12)).toContain('12');
      expect(tp('channel.count', 12)).toMatch(/^\[!! /);
      expect(tp('channel.count', 12)).toMatch(/^\[!! /);
      expect(document.documentElement.lang).toBe('en-XA');
      expect(localeOptions().map(option => option.value)).not.toContain('en-XA');
    } finally {
      window.history.pushState({}, '', '/');
      setLocale('en');
    }
  });

  it('has no empty translations or mismatched placeholders', () => {
    expect(validateTranslations()).toEqual([]);
  });

  it('localizes live preview settings and remaining minutes in every locale', () => {
    try {
      for (const { value } of localeOptions()) {
        setLocale(value);
        expect(t('settings.livePreview').length).toBeGreaterThan(0);
        expect(t('settings.livePreviewHint').length).toBeGreaterThan(0);
        for (const minutes of [0, 1, 2, 25]) {
          const remaining = t('preview.timeLeft', { minutes });
          expect(remaining).toContain(String(minutes));
          expect(remaining).not.toContain('{minutes}');
        }
      }
    } finally {
      setLocale('en');
    }
    expect(t('preview.timeLeft', { minutes: 5 })).toBe('5 min left');
  });
});
