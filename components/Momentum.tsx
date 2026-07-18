'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Cohort momentum — one element, three lenses on the same week.
 *
 * The rails shape this completely: momentum here is COLLECTIVE, never a ranking. No number
 * counts who hasn't shipped, no bar belongs to a person. What's left to show is continuity
 * (the board hasn't gone quiet), generosity (people figured things out and passed them on),
 * and flow (the week's shape). The three lenses are those three reads:
 *   - current    — the week's shipping as a flowing line
 *   - generosity — help passed between people (the one thing the rails let us count)
 *   - streak     — the collective shipping streak, a continuity thread
 *
 * It auto-rotates so it feels alive, but the person is always in control: hovering or
 * focusing pauses it, the toggle takes over and is remembered, and prefers-reduced-motion
 * turns rotation off entirely (VOICE/DESIGN treat motion as an enhancement, never a
 * requirement). Green is shipping/continuity, sky is help — one accent at a time.
 */

export type MomentumData = {
  /** Ships per day across the last 7 days, oldest → today. Collective counts. */
  shipsByDay: number[];
  /** Consecutive days the cohort shipped at least one thing. */
  streakDays: number;
  /** Recipes banked this week — the cohort figuring things out and writing them down. */
  figuredOut: number;
  /** People helped when stuck this week (intro_made). Generosity. */
  unstuck: number;
  /** Total shipped this week. */
  cohortShipped: number;
};

type Lens = 'current' | 'generosity' | 'streak';
const LENSES: Lens[] = ['current', 'generosity', 'streak'];
const ROTATE_MS = 6000;
const STORAGE_KEY = 'pulse:momentumLens';

const LABEL: Record<Lens, string> = {
  current: 'current',
  generosity: 'generosity',
  streak: 'streak',
};

/** The narrated line for each lens — Pulse's voice: plain, generosity-first, no adjectives
 *  about pace, no exclamation. Facts carry it. */
function caption(lens: Lens, d: MomentumData): string {
  if (lens === 'generosity') {
    if (d.figuredOut === 0 && d.unstuck === 0) {
      return 'When someone figures a thing out here, it gets written down and passed on.';
    }
    const bits = [
      d.figuredOut > 0 ? `${d.figuredOut} ${d.figuredOut === 1 ? 'thing' : 'things'} figured out` : null,
      d.unstuck > 0 ? `${d.unstuck} ${d.unstuck === 1 ? 'person' : 'people'} unstuck` : null,
    ].filter(Boolean);
    return `This week: ${bits.join(', ')}, and passed on.`;
  }
  if (lens === 'streak') {
    if (d.streakDays >= 2) return `${d.streakDays} days, and the board hasn’t gone quiet once.`;
    return 'The cohort ships, and the board keeps itself current.';
  }
  // current
  if (d.streakDays >= 2) return `${d.streakDays} days unbroken — the cohort keeps moving.`;
  if (d.cohortShipped > 0) return `The cohort shipped ${d.cohortShipped} this week, and keeps moving.`;
  return 'The cohort is building — this is the week so far.';
}

/** A smooth-ish polyline for the "current" lens, normalised to the SVG box. */
function currentPath(shipsByDay: number[], w: number, h: number): { line: string; area: string; end: [number, number] } {
  const days = shipsByDay.length > 0 ? shipsByDay : [0];
  const max = Math.max(1, ...days);
  const stepX = days.length > 1 ? w / (days.length - 1) : 0;
  const pad = 6;
  const pts = days.map((v, i) => {
    const x = i * stepX;
    // Higher activity sits higher (smaller y). Keep a floor so a zero day still reads.
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y] as [number, number];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return { line, area, end: pts[pts.length - 1] };
}

/** The remembered lens, if any. SSR-safe (returns null on the server). */
function readSavedLens(): Lens | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved && (LENSES as string[]).includes(saved) ? (saved as Lens) : null;
  } catch {
    return null;
  }
}

export function Momentum({ data }: { data: MomentumData }) {
  // Lazy-initialised from storage rather than restored in an effect: Momentum only ever
  // mounts client-side (Home renders it only once its listeners have data), so there's no
  // server render of it to mismatch, and this keeps the mount free of cascading setState.
  const [lens, setLens] = useState<Lens>(() => readSavedLens() ?? 'current');
  // Once the person picks a lens, stop rotating and stay there.
  const [pinned, setPinned] = useState<boolean>(() => readSavedLens() !== null);
  const [paused, setPaused] = useState(false);

  // Auto-rotate, unless pinned, paused (hover/focus), or motion is unwelcome. The motion
  // preference is read here, where rotation is actually set up.
  useEffect(() => {
    if (pinned || paused) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => {
      setLens((prev) => LENSES[(LENSES.indexOf(prev) + 1) % LENSES.length]);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [pinned, paused]);

  const choose = (next: Lens) => {
    setLens(next);
    setPinned(true);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* no storage — the choice still holds for this visit */
    }
  };

  const W = 520;
  const H = 60;
  const cur = useMemo(() => currentPath(data.shipsByDay, W, H), [data.shipsByDay]);

  return (
    <section
      className="pulse-row-in"
      aria-label="The cohort's momentum this week"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium text-zinc-400">the cohort&rsquo;s momentum</span>
        <span className="flex-1" />
        <div className="inline-flex rounded-full bg-zinc-900 p-0.5" role="tablist" aria-label="Momentum view">
          {LENSES.map((l) => {
            const on = l === lens;
            return (
              <button
                key={l}
                role="tab"
                aria-selected={on}
                onClick={() => choose(l)}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  on ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {LABEL[l]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-[68px]">
        {lens === 'current' && (
          <svg viewBox={`0 0 ${W} ${H + 6}`} className="w-full" role="img" aria-label={caption('current', data)}>
            <path d={cur.area} className="fill-emerald-400/10" />
            <path d={cur.line} className="fill-none stroke-emerald-400" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={cur.end[0]} cy={cur.end[1]} r={8} className="fill-emerald-400/20" />
            <circle cx={cur.end[0]} cy={cur.end[1]} r={4.5} className="fill-emerald-400" />
            <text x={0} y={H + 4} className="fill-zinc-600 text-[10px]">mon</text>
            <text x={W} y={H + 4} textAnchor="end" className="fill-emerald-400 text-[10px]">today</text>
          </svg>
        )}

        {lens === 'generosity' && <GenerosityWeave figuredOut={data.figuredOut} unstuck={data.unstuck} w={W} h={H} />}

        {lens === 'streak' && <StreakThread days={data.streakDays} />}
      </div>

      <div className="mt-2 flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-emerald-950"
        >
          P
        </span>
        <p className="font-[var(--font-voice,serif)] text-[15px] leading-snug text-zinc-100" style={{ fontFamily: 'var(--font-voice, Georgia, serif)' }}>
          {caption(lens, data)}
        </p>
      </div>
    </section>
  );
}

/** Help passed between people — nodes joined by thin arcs. Count-driven but capped, so it
 *  stays a shape, never a scoreboard. Sky = help, distinct from shipping green. */
function GenerosityWeave({ figuredOut, unstuck, w, h }: { figuredOut: number; unstuck: number; w: number; h: number }) {
  const moments = Math.min(6, Math.max(1, figuredOut + unstuck));
  const nodes = Math.min(6, moments + 1);
  const gap = w / (nodes + 1);
  const baseY = h - 14;
  const xs = Array.from({ length: nodes }, (_, i) => (i + 1) * gap);
  return (
    <svg viewBox={`0 0 ${w} ${h + 6}`} className="w-full" role="img" aria-label="Help passed between people this week">
      {xs.slice(0, -1).map((x, i) => {
        const x2 = xs[i + 1];
        const midX = (x + x2) / 2;
        const rise = baseY - Math.min(38, 16 + i * 6);
        return (
          <path
            key={i}
            d={`M${x.toFixed(1)},${baseY} Q${midX.toFixed(1)},${rise.toFixed(1)} ${x2.toFixed(1)},${baseY}`}
            className="fill-none stroke-sky-400"
            strokeWidth={1.5}
            opacity={0.5}
          />
        );
      })}
      {xs.map((x, i) => (
        <circle key={i} cx={x.toFixed(1)} cy={baseY} r={5} className={i % 2 === 0 ? 'fill-sky-400' : 'fill-zinc-700'} />
      ))}
    </svg>
  );
}

/** The continuity thread — a dot per streak day, today emphasised. Blames no one: a gap just
 *  means fewer dots, never a mark against a person. */
function StreakThread({ days }: { days: number }) {
  const shown = Math.min(7, Math.max(1, days));
  const dots = Array.from({ length: shown }, (_, i) => i);
  return (
    <div className="flex h-[52px] items-center gap-2.5 pl-0.5">
      {dots.map((i) => {
        const last = i === dots.length - 1;
        const opacity = 0.4 + (i / Math.max(1, dots.length - 1)) * 0.6;
        return (
          <div key={i} className="flex items-center gap-2.5">
            <span
              className={`rounded-full bg-emerald-400 ${last ? 'h-3.5 w-3.5 ring-4 ring-emerald-400/20' : 'h-2.5 w-2.5'}`}
              style={{ opacity: last ? 1 : opacity }}
            />
            {!last && <span className="h-0.5 w-4 bg-emerald-400" style={{ opacity }} />}
          </div>
        );
      })}
      <span className="ml-1.5 text-[11px] font-medium text-emerald-400">today</span>
    </div>
  );
}
