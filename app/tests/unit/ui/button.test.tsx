import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ui/button';
import { axe } from './axe';

describe('Button', () => {
  it('renders every variant with its name and no axe violations', async () => {
    const { container } = render(
      <div>
        <Button variant="primary" lamp>
          Open the app
        </Button>
        <Button variant="secondary">Review</Button>
        <Button variant="ghost">Cancel</Button>
        <Button disabled>Disabled</Button>
        <Button loading>Placing</Button>
      </div>,
    );
    expect(screen.getByRole('button', { name: 'Open the app' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toHaveAttribute('type', 'button');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('activates from the keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Place trade</Button>);
    await userEvent.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('stays focusable but inert while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Placing trade" onClick={onClick}>
        Place trade
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Placing trade' });
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(b).toHaveAttribute('aria-disabled', 'true');
    await userEvent.tab();
    expect(b).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is skipped by Tab when disabled', async () => {
    render(
      <>
        <Button disabled>Off</Button>
        <Button>On</Button>
      </>,
    );
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'On' })).toHaveFocus();
  });
});
