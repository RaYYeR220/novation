'use client';

import { Chip, SESSION_LAMP } from '@/components/ui/chip';
import { Tooltip } from '@/components/ui/tooltip';
import { useUnderlyings } from '@/lib/client/hooks';
import type { Session } from '@/lib/client/types';
import { SESSION_LABEL } from '@/lib/format';
import { SESSION_MULT } from '@/lib/kernel';

const SESSION_NOTE: Record<Session, string> = {
  REGULAR: 'NYSE hours. Shocks at 1.0×.',
  EXTENDED: 'Outside NYSE hours on a trading day. Shocks widen 1.2×.',
  WEEKEND: 'Market closed for the weekend. Shocks widen 1.75× for the gap.',
  HOLIDAY: 'NYSE holiday. Shocks widen 1.75×.',
  HALTED: 'Halted: only trades that reduce risk clear. Shocks at 2.5×.',
};

/** One chip per underlying: its market session, which sets how wide the kernel shocks it. */
export function SessionChips({ compact = false }: { compact?: boolean }) {
  const { data } = useUnderlyings();
  if (!data) return null;
  return (
    <ul aria-label="Market sessions" className="flex items-center gap-s2">
      {data.map((u) => {
        const s = SESSION_LAMP[u.session];
        return (
          <li key={u.symbol}>
            <Tooltip
              side="bottom"
              content={
                <>
                  <span className="font-medium">
                    {u.symbol}: {SESSION_LABEL[u.session]}
                  </span>
                  <br />
                  <span className="text-navy-200">{u.haltReason ?? SESSION_NOTE[u.session]}</span>
                </>
              }
            >
              <button type="button" className="rounded-control" aria-label={`${u.symbol} session: ${SESSION_LABEL[u.session]}, shocks ${SESSION_MULT[u.session]}×`}>
                <Chip size="sm" lamp={s.tone} lampState={s.state}>
                  {u.symbol}
                  {!compact && <span className="font-normal text-navy-200">{SESSION_LABEL[u.session]}</span>}
                </Chip>
              </button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
