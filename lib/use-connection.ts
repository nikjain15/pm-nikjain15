'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Connection } from './connections';

/**
 * "Pulse spotted a connection" — the client side. Sends your own work (your board's task
 * titles) to /api/connections, which matches it against the cohort's PUBLIC PRs and returns
 * at most one suggestion. Read-only: nothing is written, nothing is published; the only thing
 * that comes back is a public PR title of someone working on a related thing.
 */
export function useConnection({
  handle,
  workHints,
}: {
  /** Your GitHub handle, so the match never suggests you to yourself. */
  handle: string | null;
  /** Your own work — your board's open task titles. */
  workHints: string[];
}): Connection | null {
  const signature = useMemo(() => `${handle ?? ''}::${workHints.join('¦')}`, [handle, workHints]);
  const [connection, setConnection] = useState<Connection | null>(null);

  useEffect(() => {
    if (workHints.length === 0) {
      setConnection(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle, workHints }),
        });
        if (res.ok) {
          const data = (await res.json()) as { connection: Connection | null };
          if (!cancelled) setConnection(data.connection ?? null);
        }
      } catch {
        // No connectivity, no suggestion — never an error on Home.
      }
    })();
    return () => {
      cancelled = true;
    };
    // signature captures handle + work; workHints identity is deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return connection;
}
