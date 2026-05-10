// src/components/plans/PlanList.tsx
import { useState } from 'react';
import { usePlanStore } from '@/stores/plan-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';

export function PlanList() {
  const { t } = useTranslation();
  const plans = usePlanStore((s) => s.plans);
  const currentPlanId = usePlanStore((s) => s.currentPlanId);
  const createPlan = usePlanStore((s) => s.createPlan);
  const deletePlan = usePlanStore((s) => s.deletePlan);
  const selectPlan = usePlanStore((s) => s.selectPlan);

  const [newTitle, setNewTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const handleCreate = async () => {
    const title = newTitle.trim() || t('plans.untitled');
    await createPlan(title);
    setNewTitle('');
  };

  return (
    <div className="flex flex-col gap-2 p-3 h-full">
      {/* Create new plan */}
      <div className="flex gap-2">
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder={t('plans.new_plan')}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
          className="h-8 text-sm"
        />
        <Button size="sm" onClick={handleCreate} className="shrink-0">
          {t('plans.new_plan')}
        </Button>
      </div>

      {/* Plan list */}
      {plans.length === 0 && (
        <p className="text-sm text-muted-foreground mt-4 text-center">{t('plans.no_plans')}</p>
      )}
      <ul className="flex flex-col gap-1 overflow-y-auto">
        {plans.map((plan) => (
          <li
            key={plan.id}
            className={cn(
              'flex items-center justify-between px-2 py-1.5 rounded cursor-pointer text-sm',
              plan.id === currentPlanId
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-muted',
            )}
          >
            <span
              className="truncate flex-1"
              onClick={() => selectPlan(plan.id)}
              title={plan.title}
            >
              {plan.title}
            </span>
            {confirmDelete === plan.id ? (
              <div className="flex gap-1 ml-2 shrink-0">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-xs"
                  onClick={() => { deletePlan(plan.id); setConfirmDelete(null); }}
                >
                  {t('plans.delete_plan')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => setConfirmDelete(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 ml-1 shrink-0 opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(plan.id); }}
                title={t('plans.delete_confirm')}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
