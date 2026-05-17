// src/components/sidebar/TagChip.tsx
import { tagChipColor } from '@/lib/identifiers';

// 8 chip styles indexed by tagChipColor(tag). Pastel-on-dark / dark-on-light;
// Tailwind handles theme variants. Keeping the palette in this file means a
// designer can re-tune without touching the hash.
//
// NOTE: These classes are safelisted in tailwind.config.js under `safelist`
// so that Tailwind's content scan doesn't purge them (they're constructed
// dynamically via array lookup, not as static string literals in JSX).
const PALETTE: string[] = [
  'bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30',
  'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 ring-fuchsia-500/30',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300 ring-teal-500/30',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30',
];

export function TagChip({ tag, className = '' }: { tag: string; className?: string }) {
  const klass = PALETTE[tagChipColor(tag)] ?? PALETTE[0];
  return (
    <span
      className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-mono font-medium ring-1 ring-inset ${klass} ${className}`}
      title={tag}
    >
      {tag}
    </span>
  );
}
