import type { Status, Task, Project } from './types';

/**
 * "Ask Pulse" — the agent contract and its load-bearing guard. See design-agent.md.
 *
 * The one invariant everything rests on: the agent is a PLANNER with no more power than the
 * signed-in user. The server route (`/api/ask-pulse`) only ever returns proposed actions as
 * data; the client executor runs the matching existing `lib/*` function under the user's own
 * Firebase session, so `firestore.rules` binds the agent exactly as it binds a button. This
 * module holds the parts that must be provable WITHOUT a live model or database: the action
 * shapes, the tool schemas handed to the model, and `validatePlan` — the argument validation
 * that is the real backstop against prompt injection (the model reads attacker-controlled
 * task titles and commit text; its free-text output is untrusted until this passes it).
 *
 * SLICE 1 — own-surface, reversible actions only. No reassigning to a peer, no recipe
 * banking (that publishes; it needs its own peer-name gate), no cross-person anything.
 */

export type AgentAction =
  | { kind: 'create_task'; title: string; projectId: string; status: Status; dueDate: string | null }
  | { kind: 'set_task_status'; taskId: string; status: Status; title: string }
  | { kind: 'create_project'; name: string };

/** What the model may reference — the user's OWN board, nothing else. Built server-side from
 * the caller's own tasks/projects so the model can resolve "the login task" to a real id it
 * is allowed to touch. Never includes peers, never includes activity timestamps. */
export type BoardContext = {
  uid: string;
  tasks: { id: string; title: string; status: Status; mine: boolean }[];
  projects: { id: string; name: string }[];
};

export const STATUSES: readonly Status[] = ['todo', 'in_progress', 'done'];

/** The tool allowlist handed to the model. A fixed set — there is no dynamic dispatch, and
 * nothing here the user could not do by hand. Kept in sync with `validatePlan` below. */
export const AGENT_TOOLS = [
  {
    name: 'create_task',
    description: "Create a task on the user's own board. Use an existing project by name.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, plain words.' },
        project: { type: 'string', description: 'Name of an existing project to file it under.' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
        due_date: { type: 'string', description: 'ISO date (YYYY-MM-DD) or empty.' },
      },
      required: ['title', 'project'],
    },
  },
  {
    name: 'set_task_status',
    description: "Move one of the user's own existing tasks to a new status.",
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The exact title of an existing task of the user.' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
      },
      required: ['task', 'status'],
    },
  },
  {
    name: 'create_project',
    description: "Create a new project on the user's board.",
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project name.' } },
      required: ['name'],
    },
  },
] as const;

/** A raw tool call as the model emits it — untrusted until validated. */
export type RawToolCall = { name: string; input: Record<string, unknown> };

function isStatus(v: unknown): v is Status {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

/** An ISO calendar date, and nothing that could smuggle a query string or path. */
function cleanDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  return v.trim();
}

/**
 * Turn the model's raw tool calls into validated, executable actions — dropping anything the
 * user could not legitimately do to their OWN board. This is the injection backstop (§3):
 * the model's text is untrusted, so every reference is re-resolved against `ctx`, which only
 * contains the user's own tasks and projects.
 *
 * - `set_task_status` may only target a task that is the user's OWN (ctx marks `mine`) and
 *   that actually exists — an injected "move all tasks" can name nothing real, and can never
 *   name a peer's card, because peer cards are not in `ctx`.
 * - `create_task` must file under a project that exists (or one being created in the same
 *   plan); a title is required and length-bounded.
 * - No action can set an assignee: slice 1 assigns to the user only (the lib default), so the
 *   agent has no channel to put work on someone else's board.
 *
 * Returns the actions that passed and the human-readable reasons any were dropped (surfaced
 * quietly, never as an alarm — VOICE rule 7).
 */
export function validatePlan(
  raw: RawToolCall[],
  ctx: BoardContext
): { actions: AgentAction[]; dropped: string[] } {
  const actions: AgentAction[] = [];
  const dropped: string[] = [];

  // Projects the model may file under: existing ones, plus any it creates earlier in the plan.
  const projectByName = new Map(ctx.projects.map((p) => [p.name.trim().toLowerCase(), p.id]));
  const pendingProjects = new Set<string>();

  const taskByTitle = new Map(
    ctx.tasks.filter((t) => t.mine).map((t) => [t.title.trim().toLowerCase(), t])
  );

  for (const call of raw) {
    const input = call.input ?? {};
    if (call.name === 'create_project') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80) {
        dropped.push('a project with no usable name');
        continue;
      }
      actions.push({ kind: 'create_project', name });
      pendingProjects.add(name.toLowerCase());
      continue;
    }

    if (call.name === 'create_task') {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const projectName = typeof input.project === 'string' ? input.project.trim().toLowerCase() : '';
      if (!title || title.length > 120) {
        dropped.push('a task with no usable title');
        continue;
      }
      const projectId = projectByName.get(projectName);
      if (!projectId && !pendingProjects.has(projectName)) {
        dropped.push(`a task for a project that doesn't exist ("${input.project ?? ''}")`);
        continue;
      }
      actions.push({
        kind: 'create_task',
        title,
        // A project created earlier in the plan has no id yet — the executor resolves it by
        // name after creating it. Marked with a sentinel the executor understands.
        projectId: projectId ?? `pending:${projectName}`,
        status: isStatus(input.status) ? input.status : 'todo',
        dueDate: cleanDate(input.due_date),
      });
      continue;
    }

    if (call.name === 'set_task_status') {
      const wantTitle = typeof input.task === 'string' ? input.task.trim().toLowerCase() : '';
      const status = input.status;
      if (!isStatus(status)) {
        dropped.push('a move with no valid status');
        continue;
      }
      const task = taskByTitle.get(wantTitle);
      if (!task) {
        // The single most important drop: the model named a task that is not the user's own,
        // or does not exist. An injected "move everything" resolves to nothing here.
        dropped.push(`a move for a task that isn't yours ("${input.task ?? ''}")`);
        continue;
      }
      actions.push({ kind: 'set_task_status', taskId: task.id, status, title: task.title });
      continue;
    }

    dropped.push(`an unknown action ("${call.name}")`);
  }

  return { actions, dropped };
}

/** Build the model's view of the board from the full cohort lists — the user's OWN items
 * only, titles and ids, no peers and no timestamps (never an absence signal, §2.5). */
export function boardContext(uid: string, tasks: Task[], projects: Project[]): BoardContext {
  return {
    uid,
    tasks: tasks
      .filter((t) => t.creatorUid === uid || t.assigneeUid === uid)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, mine: true })),
    projects: projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })),
  };
}
