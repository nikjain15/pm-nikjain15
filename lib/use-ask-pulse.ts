'use client';

import { useCallback, useState } from 'react';
import { Timestamp } from 'firebase/firestore';
import { boardContext, type AgentAction } from './agent';
import { createProject, createTask, deleteTask, setTaskStatus, updateProject } from './data';
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

export function useAskPulse({ actor, tasks, projects }: { actor: Actor; tasks: Task[]; projects: Project[] }) {
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
          body: JSON.stringify({ utterance, context: boardContext(actor.uid, tasks, projects) }),
        });
        if (!res.ok) {
          setPhase('degraded');
          setNote("Pulse can't plan right now. The board still works by hand.");
          return;
        }
        const data = (await res.json()) as { actions: AgentAction[]; reason?: string };
        actions = data.actions ?? [];
        if (actions.length === 0) {
          setPhase('degraded');
          setNote(
            data.reason
              ? "Pulse can't plan right now. The board still works by hand."
              : 'Nothing to do there. Try naming a task or a project on your board.'
          );
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
          } else {
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
          }
        } catch {
          add({ label: 'One step could not be applied', detail: 'nothing changed for it', state: 'done', undo: null });
        }
      }

      setPhase('done');
    },
    [actor, tasks, projects]
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
