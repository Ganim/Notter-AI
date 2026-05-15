// Reversible percent-encoding for project/subject names used as filesystem
// path segments. Windows rejects `< > : " | ? * \ /` in file/dir names; we
// also escape `%` so the round-trip is unambiguous. macOS/Linux are stricter
// only on `/` and NUL but we apply the same mapping everywhere so the on-disk
// layout is portable across hosts (multi-device sync).
//
// Files that already exist with safe-only names are untouched — `safeFsName`
// is identity for them.

const ILLEGAL = /[<>:"|?*\\/%\x00-\x1f]/g;
const ENCODED = /%[0-9A-F]{2}/gi;

export function safeFsName(logical: string): string {
  return logical.replace(ILLEGAL, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
}

export function unsafeFsName(disk: string): string {
  return disk.replace(ENCODED, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
}
