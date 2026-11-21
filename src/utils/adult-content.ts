// Playlists carry no rating: the only sign of adult content is the name the
// provider gave the category. These are whole words (or the +18 / 18+ marks),
// so a name that merely contains the letters is not caught.
const WORDS = [
  'adult', 'adults', 'adulto', 'adultos', 'adulta', 'adultas', 'adulte', 'adultes',
  'xxx', 'porn', 'porno', 'pornos', 'erotic', 'erotica', 'erotico', 'eroticos', 'erotik',
  'sexo', 'sex', 'sexy', 'hentai', 'playboy', 'onlyfans', 'brasileirinhas',
];
const WORD_PATTERN = new RegExp(`(^|[^a-z0-9])(${WORDS.join('|')})([^a-z0-9]|$)`);
// "+18", "18+", "18 +", "[18]" style marks, but not a year or a channel number like "118".
const AGE_PATTERN = /(^|[^0-9])(\+\s?18|18\s?\+)([^0-9]|$)/;

function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** True when a category name marks its content as adult. */
export function isAdultName(name: string): boolean {
  const folded = fold(name);
  return WORD_PATTERN.test(folded) || AGE_PATTERN.test(folded);
}
