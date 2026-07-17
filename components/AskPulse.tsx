'use client';

import { useState } from 'react';
import { useAskPulse } from '@/lib/use-ask-pulse';
import type { Project, Task } from '@/lib/types';

type Actor = { uid: string; name: string; photoURL: string | null };

/**
 * "Ask Pulse" — type an instruction, watch it happen. design-agent.md.
 *
 * The register follows VOICE: plain, verb-first, no exclamation, no emoji. Own-board actions
 * run seamlessly and each carries a quiet undo — the seam where an action would PUBLISH to the
 * cohort (banking a recipe) is not in this slice and will pause when it lands. The input is
 * the only affordance; a tool nobody typed into does nothing, so it never nags.
 */
export function AskPulse({ actor, tasks, projects }: { actor: Actor; tasks: Task[]; projects: Project[] }) {
  const { phase, steps, note, run, undoStep, reset } = useAskPulse({ actor, tasks, projects });
  const [text, setText] = useState('');

  const busy = phase === 'planning' || phase === 'running';

  const submit = () => {
    const utterance = text.trim();
    if (!utterance || busy) return;
    setText('');
    void run(utterance);
  };

  return (
    <section className="mt-8">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
        <span aria-hidden className="text-sm text-zinc-500">
          ask
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={busy}
          placeholder="tell Pulse what to do — make a task, move a card, start a project"
          aria-label="Ask Pulse to do something on your board"
          className="min-h-11 flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-60"
        />
        <button
          onClick={submit}
          disabled={busy || text.trim().length === 0}
          className="min-h-11 rounded px-2 text-sm text-zinc-300 transition-colors hover:text-white disabled:opacity-40"
        >
          {busy ? 'working…' : 'send'}
        </button>
      </div>

      {phase === 'planning' && (
        <p className="pulse-row-in mt-3 text-sm text-zinc-400">Pulse is reading your board…</p>
      )}

      {(phase === 'running' || phase === 'done') && steps.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {steps.map((s) => (
            <div
              key={s.id}
              className="pulse-row-in flex items-center gap-3 rounded-lg bg-zinc-900 px-3 py-2 text-sm"
            >
              <span
                aria-hidden
                className={
                  s.state === 'running'
                    ? 'text-zinc-500'
                    : s.state === 'undone'
                      ? 'text-zinc-600'
                      : 'text-emerald-400'
                }
              >
                {s.state === 'running' ? '…' : s.state === 'undone' ? '—' : '✓'}
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
          {phase === 'done' && (
            <button
              onClick={reset}
              className="mt-1 self-start text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-400"
            >
              clear
            </button>
          )}
        </div>
      )}

      {phase === 'degraded' && note && <p className="pulse-row-in mt-3 text-sm text-zinc-400">{note}</p>}
    </section>
  );
}
