import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RefusalCard } from '@/components/ui/refusal-card';
import { Button } from '@/components/ui/button';
import { axe } from './axe';

describe('RefusalCard', () => {
  it('reads as code, reason, numbers and what would pass', async () => {
    const { container } = render(
      <RefusalCard
        code="AgentRiskBudgetExceeded"
        reason="This trade's worst case is bigger than hedge-bot's risk budget."
        breach={{
          attempted: { label: 'Worst-case loss', value: 1612.4 },
          limit: { label: 'Budget', value: 1500 },
        }}
        hint="Keep the trade's worst case at or under 1,500.00 USDG."
        proof={{ href: 'https://sepolia.arbiscan.io/tx/0x7c', label: 'View transaction' }}
        action={<Button size="sm">Resize</Button>}
      />,
    );
    const card = screen.getByRole('article', { name: /risk budget/ });
    expect(card).toHaveAttribute('data-code', 'AgentRiskBudgetExceeded');
    expect(screen.getByText('AgentRiskBudgetExceeded')).toBeInTheDocument();
    expect(screen.getByText('1,612.40')).toBeInTheDocument();
    expect(screen.getAllByText('1,500.00').length).toBeGreaterThan(0);
    expect(screen.getByText('112.40')).toHaveClass('text-loss-1');
    expect(screen.getByText('What would pass')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View transaction (opens in a new tab)' })).toHaveAttribute('rel', 'noreferrer');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws the overshoot past the limit', () => {
    const { container } = render(
      <RefusalCard
        code="InsufficientMargin"
        reason="Initial margin after the trade is more than your equity."
        breach={{ attempted: { label: 'Margin required', value: 3120.5 }, limit: { label: 'Equity', value: 2890 }, gapLabel: 'Short by' }}
      />,
    );
    const over = container.querySelector<HTMLElement>('[data-overshoot]');
    expect(Number.parseFloat(over!.style.width)).toBeGreaterThan(0);
    expect(screen.getByText('Short by')).toBeInTheDocument();
    expect(screen.getByText('230.50')).toBeInTheDocument();
  });

  it('works without numbers and can announce', async () => {
    const { container } = render(
      <RefusalCard
        announce
        code="OpeningNotAllowed"
        reason="Opening trades are closed while NVDA is halted."
        hint="Closing trades still clear."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Opening trades are closed');
    expect(container.querySelector('[data-thread]')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
