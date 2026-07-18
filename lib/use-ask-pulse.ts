'use client';

import { useCallback, useState } from 'react';
import { Timestamp } from 'firebase/firestore';
import { boardContext, type AgentAction } from './agent';
import { createProject, createTask, deleteTask, setTaskStatus, setTaskStuck, updateProject, updateTask } from './data';
import type { Project, Task } from './types';

/**
 * "Ask Pulse" — the client executor. The route only PLANS; this runs each action under the
 * user's own Firebase session by calling the same `lib/data` functions a button calls, so
 * `firestore.rules` binds it identically (design-agent.md §0).
 *
 * Slice 1 is own-surface and reversible, so it runs seamlessly — no per-action confirm wall
 * — and every step carries an undo, which is Pulse's own "publish by default, correct by
 * exception" (DESIGN-SPEC §3) applied to the agent. The one thing that would PUBLISH to the
 * cohort (banking a recipe) is deliberately not in this slice; when it lands it pauses first.
 */

type Actor = { uid: string; name: string; photoURL: string | null };

export type StepState = 'running' | 'done' | 'undone';
export type Step = {
  id: number;
  label: string;
  detail: string | null;
  state: StepState;
  undo: (() => Promise<void>) | null;
};

export type Phase = 'idle' | 'planning' | 'running' | 'done' | 'degraded';

const dueFrom = (iso: string | null): Timestamp | null =>
  iso ? Timestamp.fromDate(new Date(`${iso}T00:00:00`)) : null;

export function useAskPulse({
  actor,
  tasks,
  projects,
  canPublish = false,
  onDraftRecipe,
}: {
  actor: Actor;
  tasks: Task[];
  projects: Project[];
  /** Whether the user opted the agent into publishing — gates the draft_recipe tool. */
  canPublish?: boolean;
  /** Called when the agent proposes drafting a recipe; the caller opens the recipe modal. */
  onDraftRecipe?: (taskId: string, title: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [steps, setSteps] = useState<Step[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase('idle');
    setSteps([]);
    setNote(null);
  }, []);

  const run = useCallback(
    async (utterance: string) => {
      setPhase('planning');
      setSteps([]);
      setNote(null);

      let actions: AgentAction[] = [];
      try {
        const res = await fetch('/api/ask-pulse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ utterance, context: boardContext(actor.uid, tasks, projects, canPublish) }),
        });
        if (!res.ok) {
          setPhase('degraded');
          setNote("Pulse can't plan right now. The board still works by hand.");
          return;
        }
        const data = (await res.json()) as { actions: AgentAction[]; reason?: string; dropped?: string[] };
        actions = data.actions ?? [];
        if (actions.length === 0) {
          setPhase('degraded');
          if (data.reason) {
            setNote("Pulse can't plan right now. The board still works by hand.");
          } else if (data.dropped && data.dropped.length > 0) {
            // Say what it couldn't do, in the reason's own words, then how to fix it.
            setNote(`I couldn't do that — ${data.dropped[0]}. Try being specific, like “add a task to fix the login bug”.`);
          } else {
            setNote('Tell me what to do in plain words — like “add a task to fix the login bug”, “move the login card to done”, or “start a project called Marketing”.');
          }
          return;
        }
      } catch {
        setPhase('degraded');
        setNote("Pulse can't plan right now. The board still works by hand.");
        return;
      }

      setPhase('running');
      const createdProjects = new Map<string, string>(); // lower-name -> new id
      let next = 0;
      const add = (s: Omit<Step, 'id'>) => {
        const id = next++;
        setSteps((prev) => [...prev, { ...s, id }]);
        return id;
      };
      const settle = (id: number, patch: Partial<Step>) =>
        setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

      for (const action of actions) {
        try {
          if (action.kind === 'create_project') {
            const id = add({ label: `Creating project ${action.name}`, detail: null, state: 'running', undo: null });
            const projectId = await createProject(actor, { name: action.name, description: '' });
            createdProjects.set(action.name.toLowerCase(), projectId);
            settle(id, {
              label: `Created project ${action.name}`,
              state: 'done',
              undo: async () => void (await updateProject(projectId, { archived: true })),
            });
          } else if (action.kind === 'create_task') {
            const id = add({ label: `Creating ${action.title}`, detail: null, state: 'running', undo: null });
            const projectId = action.projectId.startsWith('pending:')
              ? createdProjects.get(action.projectId.slice('pending:'.length))
              : action.projectId;
            if (!projectId) {
              settle(id, { label: `Skipped ${action.title}`, detail: 'its project was not created', state: 'done', undo: null });
              continue;
            }
            const taskId = await createTask(actor, {
              projectId,
              title: action.title,
              description: '',
              assigneeUid: actor.uid,
              dueDate: dueFrom(action.dueDate),
              status: action.status,
            });
            settle(id, {
              label: `Created ${action.title}`,
              detail: action.dueDate ? `due ${action.dueDate}` : null,
              state: 'done',
              undo: async () => void (await deleteTask(taskId)),
            });
          } else if (action.kind === 'set_task_status') {
            const task = tasks.find((t) => t.id === action.taskId);
            if (!task) continue;
            const prior = task.status;
            const id = add({ label: `Moving ${action.title} → ${action.status}`, detail: null, state: 'running', undo: null });
            await setTaskStatus(actor, task, action.status);
            settle(id, {
              label: `Moved ${action.title} → ${action.status}`,
              state: 'done',
              undo: async () => void (await setTaskStatus(actor, { ...task, status: action.status }, prior)),
            });
          } else if (action.kind === 'edit_task') {
            const task = tasks.find((t) => t.id === action.taskId);
            if (!task) continue;
            const priorTitle = task.title;
            const priorDue = task.dueDate;
            const patch: { title?: string; dueDate?: Timestamp | null } = {};
            if (action.newTitle) patch.title = action.newTitle;
            if (action.clearDue) patch.dueDate = null;
            else if (action.dueDate) patch.dueDate = dueFrom(action.dueDate);
            const id = add({ label: `Editing ${action.title}`, detail: null, state: 'running', undo: null });
            await updateTask(action.taskId, patch);
            settle(id, {
              label: action.newTitle ? `Renamed ${priorTitle} → ${action.newTitle}` : `Updated ${action.title}`,
              state: 'done',
              undo: async () => void (await updateTask(action.taskId, { title: priorTitle, dueDate: priorDue })),
            });
          } else if (action.kind === 'delete_task') {
            const task = tasks.find((t) => t.id === action.taskId);
            if (!task) continue;
            const snapshot = task; // kept so undo can rebuild it (a new id, same content)
            const id = add({ label: `Deleting ${action.title}`, detail: null, state: 'running', undo: null });
            await deleteTask(action.taskId);
            settle(id, {
              label: `Deleted ${action.title}`,
              state: 'done',
              undo: async () =>
                void (await createTask(actor, {
                  projectId: snapshot.projectId,
                  title: snapshot.title,
                  description: snapshot.description,
                  assigneeUid: snapshot.assigneeUid,
                  dueDate: snapshot.dueDate,
                  status: snapshot.status,
                })),
            });
          } else if (action.kind === 'edit_project') {
            const priorName = action.name;
            const patch: { name?: string; archived?: boolean } = {};
            if (action.newName) patch.name = action.newName;
            if (action.archive) patch.archived = true;
            const id = add({ label: `Updating ${action.name}`, detail: null, state: 'running', undo: null });
            await updateProject(action.projectId, patch);
            settle(id, {
              label: action.archive
                ? `Archived ${priorName}`
                : `Renamed ${priorName} → ${action.newName ?? priorName}`,
              state: 'done',
              // The project came from the board unarchived, so undo restores that and the name.
              undo: async () => void (await updateProject(action.projectId, { name: priorName, archived: false })),
            });
          } else if (action.kind === 'mark_stuck') {
            const task = tasks.find((t) => t.id === action.taskId);
            if (!task) continue;
            const prior = !!task.stuckSince;
            const id = add({
              label: action.stuck ? `Asking for help on ${action.title}` : `Clearing the stuck flag on ${action.title}`,
              detail: null,
              state: 'running',
              undo: null,
            });
            await setTaskStuck(action.taskId, action.stuck);
            settle(id, {
              label: action.stuck ? `Asked for help on ${action.title}` : `Cleared the stuck flag on ${action.title}`,
              state: 'done',
              undo: async () => void (await setTaskStuck(action.taskId, prior)),
            });
          } else {
            // draft_recipe — the one action that does NOT write. It hands off to the recipe
            // modal, where the user edits the draft and confirms behind the peer-name gate.
            add({ label: `Drafting a recipe from ${action.title}`, detail: 'edit it, then bank it', state: 'done', undo: null });
            onDraftRecipe?.(action.taskId, action.title);
          }
        } catch {
          add({ label: 'One step could not be applied', detail: 'nothing changed for it', state: 'done', undo: null });
        }
      }

      setPhase('done');
    },
    [actor, tasks, projects, canPublish, onDraftRecipe]
  );

  const undoStep = useCallback(
    async (id: number) => {
      const step = steps.find((s) => s.id === id);
      if (!step?.undo) return;
      try {
        await step.undo();
        setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, state: 'undone', undo: null } : s)));
      } catch {
        /* a failed undo is not worth an alarm — the row stays as it was */
      }
    },
    [steps]
  );

  return { phase, steps, note, run, undoStep, reset };
}
