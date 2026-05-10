// src/lib/plans/slug.ts
//
// Zero-dep slugify for default export filenames. Avoids pulling in `slugify`
// (1.6.9) for one cosmetic feature. If we ever need richer rules (collation,
// language-specific transliteration), swap to the npm package then.

const MAX_LEN = 64;

export function slugifyTitle(input: string): string {
  if (!input) return 'untitled';
  // Decompose accented chars then strip the combining marks
  const noAccents = input.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const lower = noAccents.toLowerCase();
  // Replace any non-alphanumeric run with a single dash
  const dashed = lower.replace(/[^a-z0-9]+/g, '-');
  // Trim leading/trailing dashes
  const trimmed = dashed.replace(/^-+|-+$/g, '');
  if (!trimmed) return 'untitled';
  return trimmed.length > MAX_LEN ? trimmed.slice(0, MAX_LEN).replace(/-+$/, '') : trimmed;
}
