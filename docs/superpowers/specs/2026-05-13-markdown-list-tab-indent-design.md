# Markdown List Tab Indentation — Design

**Date:** 2026-05-13
**Component:** `src/components/PlannerTab.tsx` (Monaco editor in the planner)

## Problem

In the planner's Monaco editor, pressing `Tab` inside a markdown list item does not create a nested level. The user must hand-indent spaces and manually fix numbering, which is fiddly and inconsistent with VS Code's behavior. `Shift+Tab` has the same gap for outdenting.

## Goal

Match VS Code's markdown.extension behavior for `Tab` / `Shift+Tab` inside lists:

- Tab on a list line indents it one level and renumbers affected ordered groups.
- Shift+Tab outdents one level and renumbers affected ordered groups.
- Standard CommonMark output: `1.`, `2.`, `3.` at every level for ordered; same marker (`-`, `*`, or `+`) preserved across levels for unordered.

Non-goals (deferred):
- Alphabetic / Roman levels (`a.`, `i.`) — not CommonMark; would break `react-markdown` preview.
- Marker cycling (`-` → `*` → `+`) across levels — cosmetic, not standard.
- Following nested children when a parent is indented/outdented.
- Task list (`- [ ]`) special handling — treated as normal unordered.

## Detection

```
ordered    = /^(\s*)(\d+)\.(\s|$)/
unordered  = /^(\s*)([-*+])(\s|$)/
```

A line is a "list line" if it matches either. The `(\s|$)` tail allows empty items (`- ` or `1.` with nothing after).

## Indent / outdent step

**2 spaces**, fixed. Works with `remark-gfm` (the renderer this project uses) at every level, for both ordered and unordered. Marker-aware indent (3 spaces under `1. `) is not implemented — adds parser complexity for a cosmetic gain.

Outdent removes up to 2 leading spaces (clamped to 0 — no negative indent).

## Actions

Two new `editor.addAction` calls in `handleEditorMount` (mirrors the existing `markdown-list-continue` pattern):

| Action ID | Keybinding | Behavior |
|---|---|---|
| `markdown-list-tab` | `Tab` | Indent affected list lines; renumber. Fall through to default `'tab'` if no list line in scope. |
| `markdown-list-shift-tab` | `Shift+Tab` | Outdent affected list lines; renumber. Fall through to default `'outdent'` if no list line in scope. |

### Scope of "affected lines"

- Cursor with no selection (or empty selection): the cursor line, if it is a list line.
- Selection spanning multiple lines: every list line whose line number is in `[startLineNumber, endLineNumber]`. Non-list lines in that range are left untouched.

### Fall-through

If the scope contains zero list lines, the action calls `editor.trigger('keyboard', 'tab', null)` / `'outdent'` and returns. This preserves default Monaco behavior outside lists.

## Renumbering

After indent/outdent edits are applied, we renumber **every ordered group that was touched** — meaning any group containing at least one line whose indent level changed, plus the groups at the *new* indent level adjacent to each moved line.

**Group definition.** Walking line by line from the touched line outward (both directions), a group is a contiguous run of lines such that every line:
1. Matches the ordered regex, AND
2. Has exactly the same leading whitespace prefix.

The run terminates on the first line that fails either condition (including empty lines and unordered lines at any indent).

**Renumber procedure.** Within each affected group, rewrite line numbers in order: `1.`, `2.`, `3.`, ... starting from the topmost line. The existing numbers in the source are discarded — we always normalize.

This single rule covers both cases:
- **Indent:** the line leaves its old group (which shrinks and renumbers) and joins/starts a new group at the deeper indent (renumbered, so the moved line becomes `1.`).
- **Outdent:** symmetric — line leaves the deeper group and joins the shallower one.

Unordered groups are not renumbered (no numbers to update).

## Edit application

All line rewrites in a single `editor.executeEdits('list-indent', [...])` call so the change is one undo unit. Each edit replaces the full line range with the new line text (prefix-adjusted + renumbered).

## Cursor behavior

After indent: cursor and selection columns shift +2 on each affected line.
After outdent: cursor and selection columns shift −2 on each affected line, clamped to column 1.

Monaco's `executeEdits` accepts an optional `endCursorState` array; we pass an adjusted Selection/Position to land the cursor in the visually equivalent spot.

## Edge cases

| Case | Behavior |
|---|---|
| Empty list item `- ` and Tab | Indents to `  - ` (empty sublist). Regex matches via `(\s\|$)`. |
| `1.` alone at end of line | Treated as a list line (the `(\s\|$)` tail in the regex matches EOL). |
| `1.text` with no space after `.` | Treated as not-a-list (regex requires whitespace or EOL after the marker). |
| Cursor mid-marker (e.g., between `1` and `.`) | Line is still indented; cursor column shifts +2. No special handling. |
| Tab on a non-list line (no selection) | Falls through to default Monaco Tab. |
| Shift+Tab on a list line with 0 leading spaces | No-op for that line. If no other line is affected, falls through to default outdent. |
| Multi-line selection mixing lists and prose | Only list lines are indented/outdented. Prose lines untouched. Renumber pass touches only ordered groups overlapping the affected set. |
| Single ordered item indented with no sibling | Becomes `1.` at the new indent (group of size 1, normalized to 1). |

## Out of scope (documented as "won't fix in v1")

1. **Children of a moved item don't follow.** Indenting `2. b` when `   1. b1` exists below leaves `b1` at its original (deeper) indent. The user re-Tabs the children if desired.
2. **Marker-aware indent** (3 spaces under `1.`, 4 under `10.`). Always 2 spaces.
3. **Cross-list-type transitions.** Indenting `- foo` under `1. bar` produces `  - foo`. CommonMark/GFM render this as a sublist of `bar`. We don't convert markers.

## Test plan

Manual checks against the running Tauri app:

1. Single ordered item `1. a`, cursor on line, Tab → `  1. a`, cursor column +2.
2. `1. a / 2. b / 3. c`, cursor on `2. b`, Tab → `1. a /    1. b / 2. c`. (Old group renumbered: c was 3, now 2.)
3. After (2), cursor on `   1. b`, Shift+Tab → restores `1. a / 2. b / 3. c`.
4. `- a / - b / - c`, cursor on `- b`, Tab → `- a /   - b / - c`. No renumber (unordered).
5. Multi-line selection over `1. a / 2. b / 3. c`, Tab → all three indented to `   1. a /    2. b /    3. c`. Single group at new indent renumbered from 1; old group empty.
6. Cursor on prose line outside any list, Tab → inserts tab/spaces per Monaco default (unaffected).
7. Cursor on `- a` at column 0, Shift+Tab → no-op (already at root; default outdent runs and does nothing).

## Implementation sketch

```ts
const LIST_RE = /^(\s*)(\d+\.|[-*+])(\s|$)/;
const ORDERED_RE = /^(\s*)(\d+)\.(\s|$)/;

function isListLine(text: string) { return LIST_RE.test(text); }

function classify(text: string) {
  const m = text.match(LIST_RE);
  if (!m) return null;
  const [, indent, marker] = m;
  const isOrdered = /^\d+\.$/.test(marker);
  return { indent, marker, isOrdered, contentCol: indent.length + marker.length + 1 };
}

// In addAction.run:
// 1. Compute affected line numbers from selection.
// 2. Filter to list lines.
// 3. If none, editor.trigger('keyboard', isShift ? 'outdent' : 'tab', null); return.
// 4. Build edits: for each affected line, new text = (prepend or strip 2 spaces).
// 5. After applying conceptually, walk every touched ordered group and renumber.
// 6. executeEdits with the combined edit set + endCursorState.
```

Total new code: ~120 lines in `PlannerTab.tsx`, split into one shared helper (renumber pass) plus the two action handlers.
