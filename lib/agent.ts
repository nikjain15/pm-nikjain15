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
  | { kind: 'create_project'; name: string }
  // Edit one of the user's own tasks — a new title and/or a new due date. Status changes go
  // through set_task_status (it is the only path that logs task_started / task_shipped).
  | { kind: 'edit_task'; taskId: string; title: string; newTitle: string | null; dueDate: string | null; clearDue: boolean }
  | { kind: 'delete_task'; taskId: string; title: string }
  // Rename or archive one of the user's own projects. Nothing hard-deletes a project (§7).
  | { kind: 'edit_project'; projectId: string; name: string; newName: string | null; archive: boolean }
  // The assignee's own "I'm stuck" — on or off. Only ever the user's OWN task (the rules
  // enforce it too: declaring a PEER stuck is exactly the claim the product refuses).
  | { kind: 'mark_stuck'; taskId: string; title: string; stuck: boolean }
  // The ONE publish action: draft a recipe from the user's own SHIPPED task. It does not
  // write anything on its own — it opens the recipe draft for the user to edit and confirm,
  // behind the peer-name gate. Gated twice: the tool is only offered when the user opted in
  // (canPublish), and validatePlan drops it otherwise.
  | { kind: 'draft_recipe'; taskId: string; title: string };

/** What the model may reference — the user's OWN board, nothing else. Built server-side from
 * the caller's own tasks/projects so the model can resolve "the login task" to a real id it
 * is allowed to touch. Never includes peers, never includes activity timestamps. */
export type BoardContext = {
  uid: string;
  tasks: { id: string; title: string; status: Status; mine: boolean }[];
  projects: { id: string; name: string }[];
  /** Whether the user opted the agent into publishing (drafting recipes). Default false. */
  canPublish: boolean;
};

export const STATUSES: readonly Status[] = ['todo', 'in_progress', 'done'];

/** The tool allowlist handed to the model. A fixed set — there is no dynamic dispatch, and
 * nothing here the user could not do by hand. Kept in sync with `validatePlan` below. */
export const AGENT_TOOLS = [
  {
    name: 'create_task',
    description:
      "Create a task on the user's own board, filed under a project. The project can be one already on the board, OR one you create with create_project earlier in the same response.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, plain words.' },
        project: { type: 'string', description: 'Project name — an existing one, or one you create in this same response.' },
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
  {
    name: 'edit_task',
    description: "Rename one of the user's own tasks or change its due date. To move its status, use set_task_status instead.",
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The exact current title of the task.' },
        new_title: { type: 'string', description: 'A new title, if renaming.' },
        due_date: { type: 'string', description: 'A new ISO date (YYYY-MM-DD), or "none" to clear it.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'delete_task',
    description: "Delete one of the user's own tasks. Use only when the user clearly wants it gone.",
    input_schema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The exact title of the task to delete.' } },
      required: ['task'],
    },
  },
  {
    name: 'edit_project',
    description: "Rename or archive one of the user's own projects. Archiving hides it without deleting.",
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The exact current name of the project.' },
        new_name: { type: 'string', description: 'A new name, if renaming.' },
        archive: { type: 'boolean', description: 'True to archive it.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'mark_stuck',
    description: "Flag one of the user's OWN tasks as stuck (asking for help), or clear that flag.",
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The exact title of the user own task.' },
        stuck: { type: 'boolean', description: 'True to ask for help, false to withdraw.' },
      },
      required: ['task', 'stuck'],
    },
  },
] as const;

/** The one publish tool. Offered to the model ONLY when the user opted in (`canPublish`);
 * validatePlan drops it otherwise, so it can never fire from a plan the user didn't enable. */
export const DRAFT_RECIPE_TOOL = {
  name: 'draft_recipe',
  description:
    "Draft a recipe from one of the user's own SHIPPED (done) tasks so teammates who hit the same thing can steal it. This does NOT post anything — the user edits the draft and confirms.",
  input_schema: {
    type: 'object',
    properties: { task: { type: 'string', description: 'The exact title of a done task of the user.' } },
    required: ['task'],
  },
} as const;

/** The tools handed to the model — the publish tool appears only for an opted-in user. */
export function agentTools(canPublish: boolean) {
  return canPublish ? [...AGENT_TOOLS, DRAFT_RECIPE_TOOL] : AGENT_TOOLS;
}

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

    if (call.name === 'edit_task') {
      const task = taskByTitle.get(typeof input.task === 'string' ? input.task.trim().toLowerCase() : '');
      if (!task) {
        dropped.push(`an edit for a task that isn't yours ("${input.task ?? ''}")`);
        continue;
      }
      const newTitleRaw = typeof input.new_title === 'string' ? input.new_title.trim() : '';
      const newTitle = newTitleRaw && newTitleRaw.length <= 120 ? newTitleRaw : null;
      const dueRaw = typeof input.due_date === 'string' ? input.due_date.trim().toLowerCase() : '';
      const clearDue = dueRaw === 'none' || dueRaw === 'clear';
      const dueDate = clearDue ? null : cleanDate(input.due_date);
      if (!newTitle && !clearDue && !dueDate) {
        dropped.push('an edit with nothing to change');
        continue;
      }
      actions.push({ kind: 'edit_task', taskId: task.id, title: task.title, newTitle, dueDate, clearDue });
      continue;
    }

    if (call.name === 'delete_task') {
      const task = taskByTitle.get(typeof input.task === 'string' ? input.task.trim().toLowerCase() : '');
      if (!task) {
        dropped.push(`a delete for a task that isn't yours ("${input.task ?? ''}")`);
        continue;
      }
      actions.push({ kind: 'delete_task', taskId: task.id, title: task.title });
      continue;
    }

    if (call.name === 'edit_project') {
      const wantName = typeof input.project === 'string' ? input.project.trim().toLowerCase() : '';
      const proj = ctx.projects.find((p) => p.name.trim().toLowerCase() === wantName);
      if (!proj) {
        dropped.push(`an edit for a project that doesn't exist ("${input.project ?? ''}")`);
        continue;
      }
      const newNameRaw = typeof input.new_name === 'string' ? input.new_name.trim() : '';
      const newName = newNameRaw && newNameRaw.length <= 80 ? newNameRaw : null;
      const archive = input.archive === true;
      if (!newName && !archive) {
        dropped.push('a project edit with nothing to change');
        continue;
      }
      actions.push({ kind: 'edit_project', projectId: proj.id, name: proj.name, newName, archive });
      continue;
    }

    if (call.name === 'mark_stuck') {
      const task = taskByTitle.get(typeof input.task === 'string' ? input.task.trim().toLowerCase() : '');
      if (!task) {
        dropped.push(`a stuck flag for a task that isn't yours ("${input.task ?? ''}")`);
        continue;
      }
      actions.push({ kind: 'mark_stuck', taskId: task.id, title: task.title, stuck: input.stuck !== false });
      continue;
    }

    if (call.name === 'draft_recipe') {
      if (!ctx.canPublish) {
        // Defence in depth: the tool isn't even offered when publishing is off, but if a
        // stale client or an injection conjures the call, it dies here.
        dropped.push('a recipe draft, but publishing to the cohort is off in Settings');
        continue;
      }
      const task = taskByTitle.get(typeof input.task === 'string' ? input.task.trim().toLowerCase() : '');
      if (!task) {
        dropped.push(`a recipe draft for a task that isn't yours ("${input.task ?? ''}")`);
        continue;
      }
      if (task.status !== 'done') {
        dropped.push(`a recipe draft for a task that isn't shipped yet ("${task.title}")`);
        continue;
      }
      actions.push({ kind: 'draft_recipe', taskId: task.id, title: task.title });
      continue;
    }

    dropped.push(`an unknown action ("${call.name}")`);
  }

  return { actions, dropped };
}

/** Build the model's view of the board from the full cohort lists — the user's OWN items
 * only, titles and ids, no peers and no timestamps (never an absence signal, §2.5). */
export function boardContext(
  uid: string,
  tasks: Task[],
  projects: Project[],
  canPublish = false
): BoardContext {
  return {
    uid,
    tasks: tasks
      .filter((t) => t.creatorUid === uid || t.assigneeUid === uid)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, mine: true })),
    projects: projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })),
    canPublish,
  };
}
