// src/components/sidebar/TagChip.tsx
//
// Neutral monochrome chip. The previous hash-coloured palette was removed in
// favour of a single muted style; per-project colour selection can land later
// as an explicit picker (persisted column) instead of an auto-derived hash.
//
// `onClick` upgrades the chip to a focusable button — used for click-to-copy
// affordances on the subject row.

const CHIP_STYLE = 'bg-muted text-muted-foreground';

export function TagChip({
  tag,
  className = '',
  onClick,
  title,
}: {
  tag: string;
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}) {
  const base = `inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-mono font-medium ${CHIP_STYLE}`;
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title ?? tag}
        className={`${base} cursor-pointer transition-opacity hover:opacity-80 outline-none focus:outline-none focus-visible:outline-none ${className}`}
      >
        {tag}
      </button>
    );
  }
  return (
    <span
      className={`${base} ${className}`}
      title={title ?? tag}
    >
      {tag}
    </span>
  );
}
