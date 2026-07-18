'use client';

import { useEffect, useRef, useState } from 'react';
import { useAskPulse } from '@/lib/use-ask-pulse';
import type { ExtractionResult } from '@/app/api/extract-recipe/route';
import { RecipeModal, type RecipeDraft } from '@/components/RecipeModal';
import type { Member, Project, Task } from '@/lib/types';

type Actor = { uid: string; name: string; photoURL: string | null };

const THIN_NOTE = 'Not enough in the evidence to draft from. Tell it in your words.';

/**
 * "Ask Pulse" — type an instruction, watch it happen. design-agent.md.
 *
 * The register follows VOICE: plain, verb-first, no exclamation, no emoji. Own-board actions
 * run seamlessly and each carries a quiet undo — the seam where an action would PUBLISH to the
 * cohort (banking a recipe) is not in this slice and will pause when it lands. The input is
 * the only affordance; a tool nobody typed into does nothing, so it never nags.
 */
export function AskPulse({
  actor,
  tasks,
  projects,
  members,
  ready,
  canPublish,
}: {
  actor: Actor;
  tasks: Task[];
  projects: Project[];
  members: Member[];
  ready: boolean;
  canPublish: boolean;
}) {
  const [pendingRecipe, setPendingRecipe] = useState<{ taskId: string; title: string } | null>(null);
  const [recipeDraft, setRecipeDraft] = useState<RecipeDraft | null>(null);
  const { phase, steps, note, run, undoStep, reset } = useAskPulse({
    actor,
    tasks,
    projects,
    canPublish,
    onDraftRecipe: (taskId, title) => setPendingRecipe({ taskId, title }),
  });
  const [text, setText] = useState('');

  // When the agent proposes a recipe, fetch a draft from the shipped task's PR (same path as
  // the recipe offer), then open the modal. Any failure lands on an empty draft with a calm
  // note — the modal still works. The peer-name gate + require-one-edit live in the modal.
  useEffect(() => {
    if (!pendingRecipe) return;
    let cancelled = false;
    const task = tasks.find((t) => t.id === pendingRecipe.taskId);
    const prNumber = task?.evidence?.prNumbers?.[0] ?? null;
    (async () => {
      let result: ExtractionResult | null = null;
      if (prNumber !== null) {
        try {
          const res = await fetch('/api/extract-recipe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prNumber, prTitle: pendingRecipe.title }),
          });
          if (res.ok) result = (await res.json()) as ExtractionResult;
        } catch {
          result = null;
        }
      }
      if (cancelled) return;
      setRecipeDraft(
        result && !result.thin
          ? { problem: result.problem, body: result.body, taskId: pendingRecipe.taskId }
          : { problem: '', body: '', taskId: pendingRecipe.taskId, note: THIN_NOTE }
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingRecipe, tasks]);

  const closeRecipe = () => {
    setRecipeDraft(null);
    setPendingRecipe(null);
  };

  // Not until the board has loaded: acting on a board Pulse hasn't read yet would move or
  // miss cards silently. `ready` is the cohort listener's first snapshot.
  const busy = phase === 'planning' || phase === 'running';
  const blocked = busy || !ready;

  const inputRef = useRef<HTMLInputElement>(null);
  // A "why nothing happened" line. The single worst outcome for an agent is a send that
  // vanishes with no trace — it reads as broken. Every early return from submit() now leaves
  // a word behind instead of silence.
  const [hint, setHint] = useState<string | null>(null);

  const submit = () => {
    const utterance = text.trim();
    if (busy) return; // the spinner is already the feedback
    if (!utterance) {
      // Clicked send (or a starter) with an empty box — point them at the box, don't no-op.
      setHint('Tell me what to do — like “add a task to fix the login bug”.');
      inputRef.current?.focus();
      return;
    }
    if (!ready) {
      // The board hasn't loaded yet, so acting would move or miss cards. Say so, out loud,
      // instead of swallowing the send (the old silent return read as "nothing happened").
      setHint('One second — I’m still reading your board. Try that again in a moment.');
      return;
    }
    setHint(null);
    setText('');
    void run(utterance);
  };

  // Starters prefill a working prompt AND focus the box with the cursor at the end, so it's
  // obvious the next move is yours — clicking one and seeing nothing act was a big part of
  // "the agent does nothing".
  const startWith = (prefill: string) => {
    setHint(null);
    setText(prefill);
    const el = inputRef.current;
    if (el) {
      el.focus();
      // After React sets the value, drop the caret at the end.
      requestAnimationFrame(() => el.setSelectionRange(prefill.length, prefill.length));
    }
  };

  return (
    <>
    <section className="mt-8">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
        <span aria-hidden className="text-sm text-zinc-500">
          ask
        </span>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (hint) setHint(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          // Not disabled while the board loads — a disabled box that silently ignores you is
          // the same "nothing happened". Stay typable; submit() explains if it can't act yet.
          disabled={busy}
          placeholder="tell Pulse what to do — make a task, move a card, start a project"
          aria-label="Ask Pulse to do something on your board"
          className="min-h-11 flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-60"
        />
        <button
          onClick={submit}
          // Enabled while the board loads, only disabled mid-run: clicking send before the
          // board is ready now explains itself (submit sets a hint) instead of being a dead,
          // greyed-out control the user reads as "nothing happened".
          disabled={busy || text.trim().length === 0}
          className="min-h-11 rounded px-2 text-sm text-zinc-300 transition-colors hover:text-white disabled:opacity-40"
        >
          {busy ? 'working…' : 'send'}
        </button>
      </div>

      {/* The "why nothing happened" line — a blocked or empty send always leaves a word. */}
      {hint && phase !== 'planning' && phase !== 'running' && (
        <p className="pulse-row-in mt-2 text-xs text-zinc-400">{hint}</p>
      )}

      {/* Still-loading note, only when there's no hint already speaking. */}
      {!ready && phase === 'idle' && !hint && (
        <p className="mt-2 text-xs text-zinc-500">Reading your board…</p>
      )}

      {/* Starters pre-fill a working prompt and focus the box, so the next move is obviously
          yours — see startWith(). They guide toward what the agent can actually do. */}
      {phase === 'idle' && (
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ['add a task', 'add a task to '],
              ['start a project', 'start a project called '],
              ['move a card', 'move '],
            ] as const
          ).map(([label, prefill]) => (
            <button
              key={label}
              onClick={() => startWith(prefill)}
              className="rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-300"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Thinking — a visible, moving indicator, not a faint line. The model call is a couple
          of seconds; the user should see Pulse working, never a dead input. */}
      {phase === 'planning' && (
        <div className="pulse-row-in mt-3 flex items-center gap-2.5 rounded-lg bg-zinc-900 px-3 py-2.5">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 motion-safe:animate-pulse" />
          <span className="text-sm text-zinc-300">Pulse is working out what you need…</span>
        </div>
      )}

      {(phase === 'running' || phase === 'done') && steps.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-zinc-400">
            {phase === 'running'
              ? `Pulse is on it — ${steps.filter((s) => s.state !== 'running').length} of ${steps.length} done`
              : 'Done. Here’s what Pulse did:'}
          </p>
          <div className="flex flex-col gap-1.5">
            {steps.map((s) => (
              <div
                key={s.id}
                className="pulse-row-in flex items-center gap-3 rounded-lg bg-zinc-900 px-3 py-2 text-sm"
              >
                <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {s.state === 'running' ? (
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-zinc-700 border-t-emerald-400 motion-safe:animate-spin" />
                  ) : s.state === 'undone' ? (
                    <span className="text-zinc-600">—</span>
                  ) : (
                    <span className="text-emerald-400">✓</span>
                  )}
                </span>
                <span className={`flex-1 ${s.state === 'undone' ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>
                  {s.label}
                  {s.detail && <span className="text-zinc-500"> · {s.detail}</span>}
                </span>
                {s.undo && s.state === 'done' && (
                  <button
                    onClick={() => void undoStep(s.id)}
                    className="min-h-11 text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-300"
                  >
                    undo
                  </button>
                )}
              </div>
            ))}
          </div>
          {phase === 'done' && (
            <button
              onClick={reset}
              className="mt-2 text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-400"
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Couldn't-plan / nothing-to-do — a clear card, not a line that's easy to miss. */}
      {phase === 'degraded' && note && (
        <div className="pulse-row-in mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-300">
          {note}
        </div>
      )}
    </section>

    {recipeDraft && (
      <RecipeModal
        actor={actor}
        draft={recipeDraft}
        members={members}
        requireEdit
        onClose={closeRecipe}
        onCreated={closeRecipe}
      />
    )}
    </>
  );
}
