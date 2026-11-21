import { describe, expect, it } from 'vitest';
import { isAdultName } from './adult-content';

describe('isAdultName', () => {
  it.each([
    'ADULTOS', 'Adultos +18', 'Canais | Adulto', 'XXX', '[XXX] 24H', 'ADULT VOD', 'Filmes 18+',
    '+18', '+ 18 HD', 'Eróticos', 'EROTIK', 'Sexy 24h', 'Hentai', 'PORN HD', 'FOR ADULTS',
  ])('catches %j', (name) => {
    expect(isAdultName(name)).toBe(true);
  });

  it.each([
    'Filmes', 'Esportes', 'Canais 4K', 'Séries 2018', 'Canal 118', '1080p', 'Sussex', 'Middlesex TV',
    'Adulteration', 'Hot News', 'Documentários', 'Infantil', '18 de Novembro', 'Top 18',
  ])('leaves %j alone', (name) => {
    expect(isAdultName(name)).toBe(false);
  });
});
