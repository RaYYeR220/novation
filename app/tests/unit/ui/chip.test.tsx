import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chip, SESSION_LAMP } from '@/components/ui/chip';
import type { Session } from '@/lib/client/types';
import { axe } from './axe';

const SESSIONS: Session[] = ['REGULAR', 'EXTENDED', 'WEEKEND', 'HOLIDAY', 'HALTED'];

describe('Chip', () => {
  it('names each session for assistive tech', async () => {
    const { container } = render(
      <div>
        {SESSIONS.map((s) => (
          <Chip key={s} session={s} />
        ))}
        <Chip lamp="navy-200">Stylus kernel</Chip>
      </div>,
    );
    expect(screen.getByText('Weekend').closest('[data-session]')).toHaveTextContent('Session: Weekend');
    expect(screen.getByText('Stylus kernel')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('maps the lamps from the brief', () => {
    expect(SESSION_LAMP.REGULAR.tone).toBe('cyan');
    expect(SESSION_LAMP.EXTENDED.tone).toBe('navy-200');
    expect(SESSION_LAMP.WEEKEND.tone).toBe('loss-1');
    expect(SESSION_LAMP.HOLIDAY.tone).toBe('navy-400');
    expect(SESSION_LAMP.HALTED.tone).toBe('loss-3');
  });

  it('draws a closed session as an unlit ring', () => {
    const { container } = render(<Chip session="HOLIDAY" />);
    expect(container.querySelector('[data-lamp="ring"]')).not.toBeNull();
  });
});
