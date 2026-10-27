// Text utilities: slugs, tags, excerpts, reading time, search tokenisation.

const SPECIAL_CHARS = {
  œ: 'oe',
  Œ: 'OE',
  æ: 'ae',
  Æ: 'AE',
  ß: 'ss',
  ø: 'o',
  Ø: 'O',
  đ: 'd',
  Đ: 'D',
  ł: 'l',
  Ł: 'L',
};

/** Removes diacritics: "Éléphant à l'œil" -> "Elephant a l'oeil". */
export function foldAccents(value) {
  return String(value ?? '')
    .replace(/[œŒæÆßøØđĐłŁ]/g, (char) => SPECIAL_CHARS[char])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** "Mon Premier Article !" -> "mon-premier-article" (max `maxLength` chars, cut on a word boundary). */
export function slugify(value, maxLength = 80) {
  const slug = foldAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > maxLength / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/** Tags are normalised to lowercase slugs: "Serverless AWS" -> "serverless-aws". */
export function normalizeTag(tag) {
  return slugify(tag, 40);
}

/** Normalises, de-duplicates and drops empty tags while preserving order. */
export function normalizeTags(tags = []) {
  const seen = new Set();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** Very small Markdown/HTML to plain text converter (for excerpts, reading time and search). */
export function stripMarkdown(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/<[^>]+>/g, ' ') // HTML tags
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '') // headings, quotes, list markers
    .replace(/(\*\*|__|~~|\*|_)/g, '') // emphasis markers
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain-text excerpt of at most `maxLength` characters, cut on a word boundary. */
export function makeExcerpt(content, maxLength = 200) {
  const plain = stripMarkdown(content);
  if (plain.length <= maxLength) return plain;
  const cut = plain.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function countWords(content) {
  const plain = stripMarkdown(content);
  return plain ? plain.split(' ').length : 0;
}

/** Estimated reading time (200 words per minute, minimum 1 minute). */
export function readingTimeMinutes(content) {
  return Math.max(1, Math.ceil(countWords(content) / 200));
}

// French + English stop words (accent-folded). "ai" is deliberately absent (AI / IA).
export const STOP_WORDS = new Set(
  `alors au aucun aucune aussi autre autres aux avaient avais avait avant avec avez aviez avions avoir
  avons ayant bon car ce ceci cela celle celles celui ces cet cette ceux chaque ci comme comment dans de
  des du donc dont deja elle elles en encore entre es est et etaient etais etait etant ete etes etre eu
  eux fait faire fois font hors ici il ils je jusqu la le les leur leurs lui ma mais me meme memes mes
  moi mon ne ni nos notre nous on ont ou par parce pas peu peut plus pour pourquoi qu quand que quel
  quelle quelles quels qui sa sans se sera ses si son sont sous sur ta te tes toi ton tous tout toute
  toutes tres tu un une unes uns vos votre vous vu ca
  about above after again against all am an and any are as at be because been before being below
  between both but by can could did do does doing down during each few for from further had has have
  having he her here hers herself him himself his how if in into is it its itself just me more most my
  myself no nor not now of off once only or other our ours ourselves out over own same she should so
  some such than that the their theirs them themselves then there these they this those through to too
  under until up very was we were what when where which while who whom why will with would you your
  yours yourself yourselves`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Splits text into normalised search tokens (lowercase, accent-folded, 2-30 chars,
 * stop words removed). Duplicates are kept so callers can compute frequencies.
 */
export function tokenize(text) {
  return foldAccents(String(text ?? '').toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && token.length <= 30 && !STOP_WORDS.has(token));
}

/**
 * Amazon SNS e-mail subjects must be printable ASCII, start with a letter, digit or
 * punctuation mark and be shorter than 100 characters.
 */
export function toAsciiSubject(value, maxLength = 99) {
  let subject = foldAccents(value)
    .replace(/[‘’]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!subject) subject = 'Blogify';
  if (subject.length > maxLength) subject = `${subject.slice(0, maxLength - 3).trimEnd()}...`;
  return subject;
}
