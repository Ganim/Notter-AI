// src/components/dialogs/EditTagDialog.tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { isValidTagShape, isReservedTag } from '@/lib/identifiers';
import { usePlannerStore } from '@/stores/planner-store';
import { Input } from '@/components/ui/input';

export interface EditTagDialogProps {
  open: boolean;
  project: { name: string; tag: string };
  onClose: () => void;
}

export function EditTagDialog({ open, project, onClose }: EditTagDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(project.tag);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  // Accept any case while typing; the canonical form is lowercase, so we
  // validate (and persist) the normalised version. This avoids surfacing a
  // "lowercase only" error mid-typing for users who naturally capitalise.
  const normalized = value.trim().toLowerCase();

  let error: string | null = null;
  if (normalized && !isValidTagShape(normalized)) error = t('tags.edit_invalid_shape');
  else if (normalized && isReservedTag(normalized)) error = t('tags.edit_reserved');

  const canSave = !error && normalized && normalized !== project.tag && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await usePlannerStore.getState().updateProjectTagById(project.name, normalized);
      onClose();
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? '');
      if (msg === 'duplicate_tag') toast.error(t('tags.edit_duplicate'));
      else toast.error(t('tags.edit_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-card text-card-foreground rounded-md shadow-lg p-4 w-80 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-medium">{t('tags.edit_title')}</h2>
        <div className="text-xs text-muted-foreground">
          {t('tags.edit_current')} <code className="font-mono">{project.tag}</code>
        </div>
        <div className="space-y-1">
          <label htmlFor="newTag" className="text-xs block">{t('tags.edit_new_label')}</label>
          <Input
            id="newTag"
            aria-label={t('tags.edit_new_label')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={8}
            className="font-mono"
            autoFocus
          />
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {t('tags.edit_warning', { old: project.tag })}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            className="px-3 py-1 text-sm rounded hover:bg-muted"
            onClick={onClose}
            disabled={saving}
          >
            {t('tags.edit_cancel')}
          </button>
          <button
            type="button"
            disabled={!canSave}
            className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50"
            onClick={handleSave}
          >
            {t('tags.edit_save')}
          </button>
        </div>
      </div>
    </div>
  );
}
