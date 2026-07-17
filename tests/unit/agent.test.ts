import { describe, expect, it } from 'vitest';
import { boardContext, validatePlan, type BoardContext, type RawToolCall } from '@/lib/agent';
import type { Project, Task } from '@/lib/types';

const ctx: BoardContext = {
  uid: 'me',
  tasks: [
    { id: 't_login', title: 'Login screen', status: 'in_progress', mine: true },
    { id: 't_cors', title: 'Fix CORS', status: 'todo', mine: true },
  ],
  projects: [{ id: 'p_web', name: 'Website' }],
};

describe('validatePlan — the injection backstop', () => {
  it('accepts a create_task under an existing project', () => {
    const raw: RawToolCall[] = [
      { name: 'create_task', input: { title: 'Wire the API', project: 'Website', status: 'todo' } },
    ];
    const { actions, dropped } = validatePlan(raw, ctx);
    expect(dropped).toEqual([]);
    expect(actions).toEqual([
      { kind: 'create_task', title: 'Wire the API', projectId: 'p_web', status: 'todo', dueDate: null },
    ]);
  });

  it('drops a create_task for a project that does not exist', () => {
    const raw: RawToolCall[] = [{ name: 'create_task', input: { title: 'X', project: 'Nope' } }];
    const { actions, dropped } = validatePlan(raw, ctx);
    expect(actions).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it('accepts moving the user OWN task', () => {
    const raw: RawToolCall[] = [{ name: 'set_task_status', input: { task: 'Login screen', status: 'done' } }];
    const { actions } = validatePlan(raw, ctx);
    expect(actions).toEqual([{ kind: 'set_task_status', taskId: 't_login', status: 'done', title: 'Login screen' }]);
  });

  it("DROPS a move for a task that isn't the user's own — the injection case", () => {
    // Even if the model, steered by an injected task title, names a real peer card, it is not
    // in ctx (peers are never in ctx), so it resolves to nothing.
    const raw: RawToolCall[] = [{ name: 'set_task_status', input: { task: "Priya's secret card", status: 'done' } }];
    const { actions, dropped } = validatePlan(raw, ctx);
    expect(actions).toEqual([]);
    expect(dropped[0]).toMatch(/isn't yours/);
  });

  it('drops a move with an invalid status', () => {
    const raw: RawToolCall[] = [{ name: 'set_task_status', input: { task: 'Login screen', status: 'shipped' } }];
    expect(validatePlan(raw, ctx).actions).toEqual([]);
  });

  it('lets a task file under a project created earlier in the same plan', () => {
    const raw: RawToolCall[] = [
      { name: 'create_project', input: { name: 'Marketing' } },
      { name: 'create_task', input: { title: 'Landing page', project: 'Marketing' } },
    ];
    const { actions, dropped } = validatePlan(raw, ctx);
    expect(dropped).toEqual([]);
    expect(actions[0]).toEqual({ kind: 'create_project', name: 'Marketing' });
    expect(actions[1]).toMatchObject({ kind: 'create_task', title: 'Landing page', projectId: 'pending:marketing' });
  });

  it('drops an unknown or unsafe action outright', () => {
    const raw: RawToolCall[] = [
      { name: 'delete_everything', input: {} },
      { name: 'send_intro', input: { to: 'priya' } },
    ];
    const { actions, dropped } = validatePlan(raw, ctx);
    expect(actions).toEqual([]);
    expect(dropped).toHaveLength(2);
  });

  it('bounds title length (no unbounded injected payload)', () => {
    const raw: RawToolCall[] = [{ name: 'create_task', input: { title: 'x'.repeat(200), project: 'Website' } }];
    expect(validatePlan(raw, ctx).actions).toEqual([]);
  });
});

describe('boardContext — only the user own items, no peers, no timestamps', () => {
  const base = { projectId: 'p1', description: '', createdAt: null as never, completedAt: null, source: 'manual' as const, evidence: null, branch: null, stuckSince: null, dueDate: null };
  const tasks: Task[] = [
    { id: 'a', title: 'Mine', status: 'todo', creatorUid: 'me', assigneeUid: 'me', ...base },
    { id: 'b', title: 'Assigned to me', status: 'todo', creatorUid: 'peer', assigneeUid: 'me', ...base },
    { id: 'c', title: 'A peer card', status: 'todo', creatorUid: 'peer', assigneeUid: 'peer', ...base },
  ];
  const projects: Project[] = [
    { id: 'p1', name: 'Live', description: '', ownerUid: 'x', archived: false, createdAt: null as never },
    { id: 'p2', name: 'Archived', description: '', ownerUid: 'x', archived: true, createdAt: null as never },
  ];

  it('includes my own and assigned-to-me tasks, excludes peer-only cards', () => {
    const c = boardContext('me', tasks, projects);
    expect(c.tasks.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('excludes archived projects', () => {
    expect(boardContext('me', tasks, projects).projects.map((p) => p.id)).toEqual(['p1']);
  });
});
