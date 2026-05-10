// src/components/WorkspaceManagerDialog.tsx
//
// Phase J stub — the real dialog is implemented in Phase K. Returning null
// keeps WorkspaceSwitcher's <WorkspaceManagerDialog ... /> usage type-safe
// and lets the Phase J commit ship a self-contained, build-green slice.
// Phase K replaces this body without touching WorkspaceSwitcher.

export function WorkspaceManagerDialog(_props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: 'manage' | 'create';
}) {
  return null;
}
