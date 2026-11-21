import { beforeEach } from 'vitest';
import { setLocale } from '../i18n';

// The app defaults to Portuguese; the suites assert the English catalog.
beforeEach(() => {
  setLocale('en');
});
