import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useBoardStore } from '@/stores/board-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useWindowWidth } from '@/hooks/useWindowWidth';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Plus, Trash2, Send, ChevronDown, ChevronRight, ArrowLeft,
  LayoutDashboard, MessageSquare,
} from 'lucide-react';
import type { BoardTask, TaskStatus, TaskPriority } from '@/types';

/* ── Status / Priority helpers ── */

const STATUS_OPTIONS: TaskStatus[] = ['open', 'in_progress', 'in_review', 'done', 'cancelled', 'stuck'];
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high'];

function statusDotClass(s: TaskStatus) {
  switch (s) {
    case 'open':        return 'w-2.5 h-2.5 rounded-full border-2 border-gray-400 bg-transparent';
    case 'in_progress': return 'w-2.5 h-2.5 rounded-full bg-blue-500';
    case 'in_review':   return 'w-2.5 h-2.5 rounded-full bg-amber-500';
    case 'done':        return 'w-2.5 h-2.5 rounded-full bg-green-500';
    case 'cancelled':   return 'w-2.5 h-2.5 rounded-full bg-red-500';
    case 'stuck':       return 'w-2.5 h-2.5 rounded-full bg-orange-500';
  }
}

function priorityBadgeClass(p: TaskPriority) {
  switch (p) {
    case 'low':    return 'bg-muted text-muted-foreground';
    case 'medium': return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'high':   return 'bg-rose-500/10 text-rose-600 dark:text-rose-400';
  }
}

function statusLabel(s: TaskStatus, t: (k: string) => string) {
  const map: Record<TaskStatus, string> = {
    open: t('board.status_open'),
    in_progress: t('board.status_in_progress'),
    in_review: t('board.status_in_review'),
    done: t('board.status_done'),
    cancelled: t('board.status_cancelled'),
    stuck: t('board.status_stuck'),
  };
  return map[s];
}

function priorityLabel(p: TaskPriority, t: (k: string) => string) {
  const map: Record<TaskPriority, string> = {
    low: t('board.priority_low'),
    medium: t('board.priority_medium'),
    high: t('board.priority_high'),
  };
  return map[p];
}

/* ── Grouped structure ── */

interface TaskGroup {
  projectName: string;
  subjects: { subjectName: string; tasks: BoardTask[] }[];
}

function groupTasks(tasks: BoardTask[]): TaskGroup[] {
  const projectMap = new Map<string, Map<string, BoardTask[]>>();
  for (const task of tasks) {
    if (!projectMap.has(task.projectName)) projectMap.set(task.projectName, new Map());
    const subjectKey = task.subjectName ?? '__general__';
    const subMap = projectMap.get(task.projectName)!;
    if (!subMap.has(subjectKey)) subMap.set(subjectKey, []);
    subMap.get(subjectKey)!.push(task);
  }

  const groups: TaskGroup[] = [];
  for (const [projectName, subMap] of projectMap) {
    const subjects: TaskGroup['subjects'] = [];
    for (const [subjectKey, tasks] of subMap) {
      const sorted = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      subjects.push({ subjectName: subjectKey === '__general__' ? 'General' : subjectKey, tasks: sorted });
    }
    subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
    groups.push({ projectName, subjects });
  }
  groups.sort((a, b) => a.projectName.localeCompare(b.projectName));
  return groups;
}

/* ── Timestamp formatter ── */

function formatTimestamp(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ════════════════════════════════════════════════════════════════════════ */

export function BoardTab() {
  const { t } = useTranslation();
  const {
    tasks, selectedTaskId,
    loadAllBoards, createTask, updateTask, changeStatus, deleteTask,
    addMessage, setSelectedTaskId,
  } = useBoardStore();
  const { projects, loadSubjects } = usePlannerStore();

  const windowWidth = useWindowWidth();
  const isLarge = windowWidth >= 1024;

  /* ── Filters ── */
  const [filterProject, setFilterProject] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterPriority, setFilterPriority] = useState<string>('');

  /* ── Mobile view mode ── */
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  /* ── Create dialog ── */
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProject, setNewProject] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('medium');
  const [availableSubjects, setAvailableSubjects] = useState<string[]>([]);

  /* ── Delete dialog ── */
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  /* ── Detail editing states ── */
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [editDescValue, setEditDescValue] = useState('');

  /* ── Message input ── */
  const [messageInput, setMessageInput] = useState('');

  /* ── Collapsed sections ── */
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [collapsedSubjects, setCollapsedSubjects] = useState<Set<string>>(new Set());

  /* ── Refs ── */
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  /* ── Init ── */
  useEffect(() => { loadAllBoards(); }, [loadAllBoards]);

  /* ── Load subjects when create dialog project changes ── */
  useEffect(() => {
    if (newProject) {
      loadSubjects(newProject).then(() => {
        setAvailableSubjects(usePlannerStore.getState().subjects);
      });
    } else {
      setAvailableSubjects([]);
    }
  }, [newProject, loadSubjects]);

  /* ── Auto-scroll messages ── */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedTaskId, tasks]);

  /* ── Focus title input on edit ── */
  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

  /* ── Derived data ── */
  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (filterProject && t.projectName !== filterProject) return false;
      if (filterStatus && t.status !== filterStatus) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      return true;
    });
  }, [tasks, filterProject, filterStatus, filterPriority]);

  const grouped = useMemo(() => groupTasks(filteredTasks), [filteredTasks]);
  const hasFilters = filterProject !== '' || filterStatus !== '' || filterPriority !== '';

  /* ── Handlers ── */

  function handleSelectTask(id: string) {
    setSelectedTaskId(id);
    setEditingTitle(false);
    setEditingDesc(false);
    setMessageInput('');
    if (!isLarge) setMobileShowDetail(true);
  }

  function handleBack() {
    setMobileShowDetail(false);
  }

  function handleCreateTask() {
    if (!newTitle.trim() || !newProject) return;
    createTask({
      projectName: newProject,
      subjectName: newSubject || null,
      title: newTitle.trim(),
      description: newDescription.trim(),
      status: 'open',
      priority: newPriority,
    });
    toast.success(t('board.task_created'));
    setCreateDialogOpen(false);
    setNewProject('');
    setNewSubject('');
    setNewTitle('');
    setNewDescription('');
    setNewPriority('medium');
  }

  function handleDeleteTask() {
    if (!selectedTask) return;
    deleteTask(selectedTask.id);
    toast.success(t('board.task_deleted'));
    setDeleteDialogOpen(false);
    setMobileShowDetail(false);
  }

  function handleSendMessage() {
    if (!messageInput.trim() || !selectedTaskId) return;
    addMessage(selectedTaskId, messageInput.trim());
    setMessageInput('');
  }

  function handleTitleSave() {
    if (selectedTask && editTitleValue.trim() && editTitleValue.trim() !== selectedTask.title) {
      updateTask(selectedTask.id, { title: editTitleValue.trim() });
    }
    setEditingTitle(false);
  }

  function handleDescSave() {
    if (selectedTask && editDescValue !== selectedTask.description) {
      updateTask(selectedTask.id, { description: editDescValue });
    }
    setEditingDesc(false);
  }

  function clearFilters() {
    setFilterProject('');
    setFilterStatus('');
    setFilterPriority('');
  }

  function toggleProject(name: string) {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  function toggleSubject(key: string) {
    setCollapsedSubjects((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  /* ════════════════════════════════════════════════════════════════════ */
  /* ── Sub-components (rendered inline)                                */
  /* ════════════════════════════════════════════════════════════════════ */

  /* ── Filter bar ── */
  const filterBar = (
    <div className="flex flex-wrap gap-2">
      <select
        value={filterProject}
        onChange={(e) => setFilterProject(e.target.value)}
        className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
      >
        <option value="">{t('board.all_projects')}</option>
        {projects.map((p) => (
          <option key={p.name} value={p.name}>{p.name}</option>
        ))}
      </select>
      <select
        value={filterStatus}
        onChange={(e) => setFilterStatus(e.target.value)}
        className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
      >
        <option value="">{t('board.all_statuses')}</option>
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>{statusLabel(s, t)}</option>
        ))}
      </select>
      <select
        value={filterPriority}
        onChange={(e) => setFilterPriority(e.target.value)}
        className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
      >
        <option value="">{t('board.all_priorities')}</option>
        {PRIORITY_OPTIONS.map((p) => (
          <option key={p} value={p}>{priorityLabel(p, t)}</option>
        ))}
      </select>
    </div>
  );

  /* ── Header ── */
  const header = (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-semibold">{t('board.title')}</h1>
        {filterBar}
      </div>
      <button
        onClick={() => setCreateDialogOpen(true)}
        className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        <Plus size={14} />
        {t('board.new_task')}
      </button>
    </div>
  );

  /* ── Empty state ── */
  function renderEmpty() {
    if (tasks.length === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <LayoutDashboard size={48} className="opacity-20" />
          <p className="text-sm">{t('board.no_tasks')}</p>
          <button
            onClick={() => setCreateDialogOpen(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={14} />
            {t('board.new_task')}
          </button>
        </div>
      );
    }
    if (filteredTasks.length === 0 && hasFilters) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <p className="text-sm">{t('board.no_tasks_filtered')}</p>
          <button
            onClick={clearFilters}
            className="text-xs underline hover:text-foreground"
          >
            Clear filters
          </button>
        </div>
      );
    }
    return null;
  }

  /* ── Task card ── */
  function renderTaskCard(task: BoardTask) {
    const isSelected = task.id === selectedTaskId;
    return (
      <button
        key={task.id}
        onClick={() => handleSelectTask(task.id)}
        className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
          isSelected ? 'bg-accent' : 'hover:bg-accent/50'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`shrink-0 ${statusDotClass(task.status)}`} />
          <span className="text-sm font-medium truncate flex-1">{task.title}</span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${priorityBadgeClass(task.priority)}`}>
            {priorityLabel(task.priority, t)}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1 ml-4.5 text-xs text-muted-foreground">
          <span>{statusLabel(task.status, t)}</span>
          {task.messages.length > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare size={10} />
              {task.messages.length}
            </span>
          )}
        </div>
      </button>
    );
  }

  /* ── Task list (grouped) ── */
  function renderTaskList() {
    const empty = renderEmpty();
    if (empty) return empty;

    return (
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {grouped.map((group) => {
            const projKey = group.projectName;
            const projCollapsed = collapsedProjects.has(projKey);
            return (
              <div key={projKey}>
                <button
                  onClick={() => toggleProject(projKey)}
                  className="flex items-center gap-1 w-full px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                >
                  {projCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  {group.projectName}
                </button>
                {!projCollapsed && group.subjects.map((sub) => {
                  const subKey = `${projKey}::${sub.subjectName}`;
                  const subCollapsed = collapsedSubjects.has(subKey);
                  return (
                    <div key={subKey} className="ml-3">
                      <button
                        onClick={() => toggleSubject(subKey)}
                        className="flex items-center gap-1 w-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {subCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        {sub.subjectName}
                      </button>
                      {!subCollapsed && (
                        <div className="ml-2 space-y-0.5">
                          {sub.tasks.map(renderTaskCard)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    );
  }

  /* ── Detail panel ── */
  function renderDetail() {
    if (!selectedTask) {
      return (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {tasks.length > 0 ? 'Select a task to view details' : ''}
        </div>
      );
    }

    const task = selectedTask;

    return (
      <div className="flex flex-col h-full">
        {/* Back button (mobile) */}
        {!isLarge && (
          <button
            onClick={handleBack}
            className="flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={16} />
            Back
          </button>
        )}

        {/* Top section */}
        <div className="border-b border-border px-4 py-3 space-y-3">
          {/* Title */}
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={editTitleValue}
              onChange={(e) => setEditTitleValue(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTitleSave();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="w-full bg-transparent text-lg font-semibold outline-none border-b border-primary"
            />
          ) : (
            <h2
              className="text-lg font-semibold cursor-pointer hover:text-primary transition-colors"
              onDoubleClick={() => {
                setEditTitleValue(task.title);
                setEditingTitle(true);
              }}
            >
              {task.title}
            </h2>
          )}

          {/* Status + Priority dropdowns */}
          <div className="flex items-center gap-3">
            <select
              value={task.status}
              onChange={(e) => changeStatus(task.id, e.target.value as TaskStatus)}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{statusLabel(s, t)}</option>
              ))}
            </select>
            <select
              value={task.priority}
              onChange={(e) => updateTask(task.id, { priority: e.target.value as TaskPriority })}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>{priorityLabel(p, t)}</option>
              ))}
            </select>
            <button
              onClick={() => setDeleteDialogOpen(true)}
              className="ml-auto p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              title={t('board.delete_task')}
            >
              <Trash2 size={15} />
            </button>
          </div>

          {/* Description */}
          {editingDesc ? (
            <textarea
              value={editDescValue}
              onChange={(e) => setEditDescValue(e.target.value)}
              onBlur={handleDescSave}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingDesc(false);
              }}
              rows={4}
              autoFocus
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground resize-none outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <p
              className={`text-sm cursor-pointer rounded-md px-1 py-0.5 hover:bg-accent/50 transition-colors ${
                task.description ? 'text-foreground' : 'text-muted-foreground italic'
              }`}
              onClick={() => {
                setEditDescValue(task.description);
                setEditingDesc(true);
              }}
            >
              {task.description || t('board.description_placeholder')}
            </p>
          )}

          {/* Project + Subject */}
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>{t('board.project')}: {task.projectName}</span>
            <span>{t('board.subject')}: {task.subjectName ?? t('board.general')}</span>
          </div>
        </div>

        {/* Messages thread */}
        <ScrollArea className="flex-1 px-4 py-2">
          {task.messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center h-full text-sm text-muted-foreground">
              {t('board.no_messages')}
            </div>
          ) : (
            <div className="space-y-3">
              {task.messages.map((msg) => {
                if (msg.type === 'status_change') {
                  const parts = msg.content.split(' → ');
                  const from = parts[0] as TaskStatus;
                  const to = parts[1] as TaskStatus;
                  return (
                    <div key={msg.id} className="text-center text-xs text-muted-foreground italic py-1">
                      {t('board.status_changed', { from: statusLabel(from, t), to: statusLabel(to, t) })}
                    </div>
                  );
                }
                if (msg.type === 'action') {
                  return (
                    <div key={msg.id} className="rounded-md bg-muted/50 px-3 py-2 text-xs font-mono text-muted-foreground">
                      {msg.content}
                    </div>
                  );
                }
                // comment
                return (
                  <div key={msg.id} className="space-y-0.5">
                    <div className="text-xs text-muted-foreground">
                      {msg.author} &middot; {formatTimestamp(msg.timestamp)}
                    </div>
                    <div className="text-sm text-foreground">{msg.content}</div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </ScrollArea>

        {/* Message input */}
        <div className="border-t border-border px-4 py-2 flex gap-2">
          <input
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSendMessage(); }}
            placeholder={t('board.type_message')}
            className="flex-1 h-8 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={handleSendMessage}
            disabled={!messageInput.trim()}
            className="flex items-center justify-center h-8 w-8 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════════════════════════════ */
  /* ── Layout                                                          */
  /* ════════════════════════════════════════════════════════════════════ */

  return (
    <div className="flex flex-col h-full">
      {header}

      {isLarge ? (
        /* Desktop: resizable panels */
        <ResizablePanelGroup orientation="horizontal" className="flex-1">
          <ResizablePanel defaultSize={60} minSize={30}>
            <div className="flex flex-col h-full">
              {renderTaskList()}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={40} minSize={25}>
            <div className="flex flex-col h-full">
              {renderDetail()}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        /* Mobile/Tablet: full-width toggle */
        <div className="flex-1 flex flex-col overflow-hidden">
          {mobileShowDetail && selectedTask ? renderDetail() : renderTaskList()}
        </div>
      )}

      {/* ── Create Task Dialog ── */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('board.create_task')}</DialogTitle>
            <DialogDescription>{t('board.create_task_desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {/* Project */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('board.project')}</label>
              <select
                value={newProject}
                onChange={(e) => { setNewProject(e.target.value); setNewSubject(''); }}
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                <option value="">{t('board.select_project')}</option>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
            {/* Subject */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('board.subject')}</label>
              <select
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                disabled={!newProject}
              >
                <option value="">{t('board.general')}</option>
                {availableSubjects.map((s) => (
                  <option key={s} value={s}>{s.replace('.md', '')}</option>
                ))}
              </select>
            </div>
            {/* Title */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('board.title_label')}</label>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t('board.title_placeholder')}
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            {/* Description */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('board.description_label')}</label>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t('board.description_placeholder')}
                rows={3}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground resize-none outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            {/* Priority */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('board.priority_label')}</label>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>{priorityLabel(p, t)}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={() => setCreateDialogOpen(false)}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              {t('board.cancel')}
            </button>
            <button
              onClick={handleCreateTask}
              disabled={!newTitle.trim() || !newProject}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              {t('board.create_task')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation Dialog ── */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('board.delete_task')}</DialogTitle>
            <DialogDescription>
              {t('board.delete_task_desc', { name: selectedTask?.title ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setDeleteDialogOpen(false)}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              {t('board.cancel')}
            </button>
            <button
              onClick={handleDeleteTask}
              className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              {t('board.delete')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
