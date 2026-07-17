import { expect, test, type Page } from '@playwright/test';
import { signUp, uniqueEmail } from './helpers';

/**
 * "Ask Pulse" — the client executor, end to end. design-agent.md.
 *
 * The model call (`/api/ask-pulse`) needs ANTHROPIC_API_KEY, which correctly does not exist
 * locally — so this stubs the ROUTE (returns a fixed, already-validated plan) and asserts the
 * half that must work under the rules: the executor runs the real `lib/data` functions under
 * the signed-in user's session, the writes actually land, and undo reverses them. The model's
 * planning is exercised in prod, where the key lives (same split as narration).
 */

const EMULATOR = 'http://127.0.0.1:8080/v1/projects/demo-pulse/databases/(default)/documents';

async function uidForEmail(page: Page, email: string): Promise<string> {
  const res = await page.request.get(`${EMULATOR}/members?pageSize=300`, {
    headers: { Authorization: 'Bearer owner' },
  });
  const body = (await res.json()) as {
    documents?: { fields: { uid: { stringValue: string }; email: { stringValue: string } } }[];
  };
  const me = body.documents?.find((d) => d.fields.email?.stringValue === email);
  expect(me, `no member for ${email}`).toBeTruthy();
  return me!.fields.uid.stringValue;
}

async function seedDoc(page: Page, collection: string, id: string, fields: Record<string, unknown>) {
  const res = await page.request.post(`${EMULATOR}/${collection}?documentId=${id}`, {
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    data: { fields },
  });
  expect(res.ok(), `seed ${collection}/${id} failed`).toBeTruthy();
}

const s = (v: string) => ({ stringValue: v });
const nul = { nullValue: null };

test('Ask Pulse executes a plan on your board, and undo reverses it', async ({ page }) => {
  const email = uniqueEmail('agent');
  await signUp(page, 'Nik Jain', email);
  const uid = await uidForEmail(page, email);

  const proj = `agentproj_${Date.now()}`;
  const task = `agenttask_${Date.now()}`;
  await seedDoc(page, 'projects', proj, {
    name: s('Website'), description: s(''), ownerUid: s(uid), archived: { booleanValue: false },
    createdAt: { timestampValue: new Date().toISOString().replace(/\.\d+/, '') },
  });
  await seedDoc(page, 'tasks', task, {
    projectId: s(proj), title: s('Login screen'), description: s(''), status: s('in_progress'),
    assigneeUid: s(uid), creatorUid: s(uid), dueDate: nul, completedAt: nul,
    createdAt: { timestampValue: new Date().toISOString().replace(/\.\d+/, '') },
    source: s('manual'), evidence: nul, branch: nul, stuckSince: nul,
  });

  // Stub the planner: a fixed, already-validated plan (what validatePlan would return).
  await page.route('**/api/ask-pulse', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        actions: [
          { kind: 'create_task', title: 'Wire the API', projectId: proj, status: 'todo', dueDate: null },
          { kind: 'set_task_status', taskId: task, status: 'done', title: 'Login screen' },
        ],
        dropped: [],
      }),
    })
  );

  await page.goto('/');
  const input = page.getByLabel('Ask Pulse to do something on your board');
  await input.fill('make a task to wire the API and mark the login screen done');
  await page.getByRole('button', { name: 'send' }).click();

  // The progress the user watches.
  await expect(page.getByText('Created Wire the API')).toBeVisible();
  await expect(page.getByText('Moved Login screen → done')).toBeVisible();

  // The writes actually landed, under the user's own session and the rules.
  await expect
    .poll(async () => {
      const res = await page.request.get(`${EMULATOR}/tasks?pageSize=300`, { headers: { Authorization: 'Bearer owner' } });
      const body = (await res.json()) as { documents?: { fields: { title?: { stringValue: string } } }[] };
      return body.documents?.some((d) => d.fields.title?.stringValue === 'Wire the API') ?? false;
    })
    .toBe(true);

  const moved = await page.request.get(`${EMULATOR}/tasks/${task}`, { headers: { Authorization: 'Bearer owner' } });
  expect(((await moved.json()) as { fields: { status: { stringValue: string } } }).fields.status.stringValue).toBe('done');

  // Undo the created task — it leaves the board.
  await page.getByRole('button', { name: 'undo' }).first().click();
  await expect
    .poll(async () => {
      const res = await page.request.get(`${EMULATOR}/tasks?pageSize=300`, { headers: { Authorization: 'Bearer owner' } });
      const body = (await res.json()) as { documents?: { fields: { title?: { stringValue: string } } }[] };
      return body.documents?.some((d) => d.fields.title?.stringValue === 'Wire the API') ?? false;
    })
    .toBe(false);
});
