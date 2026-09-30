import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from '@/components/ui/tooltip';
import { axe } from './axe';

describe('Tooltip', () => {
  it('describes its trigger and opens on focus', async () => {
    const { container } = render(
      <Tooltip content="Worst loss across 39 scenarios">
        <button type="button">IM</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'IM' });
    expect(trigger).toHaveAccessibleDescription('Worst loss across 39 scenarios');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('closes on Escape and on blur', async () => {
    render(
      <>
        <Tooltip content="Maintenance margin">
          <button type="button">MM</button>
        </Tooltip>
        <button type="button">Next</button>
      </>,
    );
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toBeVisible();
    await userEvent.tab();
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens after the hover delay', async () => {
    render(
      <Tooltip content="Price −R, vol ×1.4" delay={20}>
        <button type="button">Cell 26</button>
      </Tooltip>,
    );
    await userEvent.hover(screen.getByRole('button'));
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(screen.getByRole('tooltip')).toBeVisible();
  });

  it('can be pinned open and keeps an existing description', () => {
    render(
      <>
        <span id="extra">Updated each block</span>
        <Tooltip content="Equity minus IM" open side="bottom" align="start">
          <button type="button" aria-describedby="extra">
            Free margin
          </button>
        </Tooltip>
      </>,
    );
    expect(screen.getByRole('tooltip')).toBeVisible();
    expect(screen.getByRole('button')).toHaveAccessibleDescription('Updated each block Equity minus IM');
  });
});
