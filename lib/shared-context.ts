import { type Firestore } from 'firebase-admin/firestore';
import {
  BUS,
  canTransition,
  contextKey,
  isValidHandle,
  newAgentTask,
  type AgentTask,
  type AgentTaskStatus,
  type SharedActivity,
  type SharedMemoryNote,
} from './shared-context-contract';

/**
 * Pulse's admin adapter over the shared-context contract — the thin read/write against the bus
 * Firestore. Every cohort app implements the same handful of operations against the same paths, so
 * the suite converges on one shared brain. Everything is keyed by the GitHub handle; a caller with
 * no handle simply can't participate in the shared layer (their memory stays app-local).
 *
 * Kept identical in shape to Rally's `lib/shared-context.ts` — only `APP` differs. See
 * lib/shared-context-contract.ts for the paths and lifecycle.
 */
export const APP = 'pulse';

export async function rememberShared(db: Firestore, handle: string, text: string, nowMs: number): Promise<boolean> {
  if (!isValidHandle(handle)) return false;
  const note = text.trim().slice(0, 280);
  if (!note) return false;
  await db.collection(BUS.memory(handle)).add({ app: APP, text: note, createdAt: nowMs } satisfies SharedMemoryNote);
  await db.doc(BUS.context(handle)).set({ handle: contextKey(handle), updatedAt: nowMs }, { merge: true });
  return true;
}

export async function readSharedMemory(db: Firestore, handle: string, limit = 30): Promise<SharedMemoryNote[]> {
  if (!isValidHandle(handle)) return [];
  const snap = await db.collection(BUS.memory(handle)).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.reverse().map((d) => d.data() as SharedMemoryNote);
}

export async function logSharedActivity(
  db: Firestore,
  handle: string,
  kind: string,
  summary: string,
  nowMs: number,
): Promise<void> {
  if (!isValidHandle(handle)) return;
  await db.collection(BUS.activity(handle)).add({ app: APP, kind, summary: summary.slice(0, 280), createdAt: nowMs } satisfies SharedActivity);
}

export async function readSharedActivity(db: Firestore, handle: string, limit = 20): Promise<SharedActivity[]> {
  if (!isValidHandle(handle)) return [];
  const snap = await db.collection(BUS.activity(handle)).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.reverse().map((d) => d.data() as SharedActivity);
}

/**
 * Erase everything the shared bus holds about a person — memory notes AND activity history.
 * The user's right to be forgotten. Returns how many docs were removed. Server-only (Admin).
 */
export async function forgetShared(db: Firestore, handle: string): Promise<number> {
  if (!isValidHandle(handle)) return 0;
  let removed = 0;
  for (const path of [BUS.memory(handle), BUS.activity(handle)]) {
    const snap = await db.collection(path).get();
    for (const d of snap.docs) {
      await d.ref.delete();
      removed += 1;
    }
  }
  await db.doc(BUS.context(handle)).delete().catch(() => {});
  return removed;
}

/** One app's agent asks another app's agent to do work. Returns the new task id. */
export async function dispatchTask(
  db: Firestore,
  input: { toApp: string; handle: string; intent: string; payload?: Record<string, unknown> },
  nowMs: number,
): Promise<string | null> {
  if (!isValidHandle(input.handle)) return null;
  const task = newAgentTask({ fromApp: APP, ...input }, nowMs);
  const ref = await db.collection(BUS.tasks).add(task);
  return ref.id;
}

/**
 * Claim pending tasks addressed to this app, flipping them to `claimed` transactionally. When a
 * `handle` is given, only that person's tasks are claimed — the app runs a task AS the user it
 * targets, so it must act on the right identity's data.
 */
export async function claimTasks(db: Firestore, toApp = APP, handle: string | null = null, limit = 10): Promise<AgentTask[]> {
  const snap = await db.collection(BUS.tasks).where('toApp', '==', toApp).where('status', '==', 'pending').limit(limit * 2).get();
  const key = handle ? contextKey(handle) : null;
  const candidates = key ? snap.docs.filter((d) => (d.data().handle as string) === key) : snap.docs;
  const claimed: AgentTask[] = [];
  for (const doc of candidates.slice(0, limit)) {
    const ok = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if ((fresh.data()?.status as AgentTaskStatus) !== 'pending') return false;
      tx.update(doc.ref, { status: 'claimed', updatedAt: Date.now() });
      return true;
    });
    if (ok) claimed.push({ id: doc.id, ...(doc.data() as AgentTask), status: 'claimed' });
  }
  return claimed;
}

/** Report the outcome of a claimed task. Enforces the legal lifecycle. */
export async function completeTask(db: Firestore, id: string, ok: boolean, result: string): Promise<void> {
  const ref = db.collection(BUS.tasks).doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const from = (snap.data()?.status as AgentTaskStatus) ?? 'pending';
    const to: AgentTaskStatus = ok ? 'done' : 'failed';
    if (!canTransition(from, to)) return;
    tx.update(ref, { status: to, result: result.slice(0, 500), updatedAt: Date.now() });
  });
}
