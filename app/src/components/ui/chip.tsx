import type { ComponentProps, ReactNode } from 'react';
import type { Session } from '@/lib/client/types';
import { SESSION_LABEL } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Lamp, type LampTone } from './lamp';

/** Session lamps. Open sessions are lit; a holiday is an unlit ring; a halt is the hottest loss step. */
export const SESSION_LAMP: Record<Session, { tone: LampTone; state: 'lit' | 'ring' }> = {
  REGULAR: { tone: 'cyan', state: 'lit' },
  EXTENDED: { tone: 'navy-200', state: 'lit' },
  WEEKEND: { tone: 'loss-1', state: 'lit' },
  HOLIDAY: { tone: 'navy-400', state: 'ring' },
  HALTED: { tone: 'loss-3', state: 'lit' },
};

type ChipBase = Omit<ComponentProps<'span'>, 'children'> & { size?: 'sm' | 'md' };

export type ChipProps = ChipBase &
  (
    | { session: Session; children?: never; lamp?: never; lampState?: never }
    | { session?: never; children: ReactNode; lamp?: LampTone; lampState?: 'lit' | 'ring' }
  );

/** A small status label. Session chips read "Session: Weekend" to assistive tech. */
export function Chip({ session, children, lamp, lampState = 'lit', size = 'md', className, ...rest }: ChipProps) {
  const s = session ? SESSION_LAMP[session] : undefined;
  const halted = session === 'HALTED';
  return (
    <span
      data-session={session}
      className={cn(
        'inline-flex items-center gap-s2 whitespace-nowrap rounded-control border font-medium text-navy-50',
        size === 'md' ? 'h-7 px-2.5 text-t13' : 'h-6 px-s2 text-t12',
        halted ? 'border-loss-3/45 bg-loss-3/8' : 'border-navy-700 bg-navy-950/60',
        className,
      )}
      {...rest}
    >
      {s ? <Lamp tone={s.tone} state={s.state} size={6} /> : lamp ? <Lamp tone={lamp} state={lampState} size={6} /> : null}
      {session ? (
        <>
          <span className="sr-only">Session: </span>
          {SESSION_LABEL[session]}
        </>
      ) : (
        children
      )}
    </span>
  );
}
