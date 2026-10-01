import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MarginMeter } from '@/components/charts/margin-meter';
import { ScenarioStrip } from '@/components/charts/scenario-strip';
import { refusalCopy, RefusalNotice } from '@/components/app/refusal-card';
import type { AccountState } from '@/lib/client/types';
import { axe } from './axe';

const now: AccountState = {
  cash: 2400,
  mtm: 7921.599641,
  settledValue: 2400,
  deficit: 0,
  equity: 10321.599641,
  im: 656.252198,
  mm: 492.189148,
  worstScenario: 26,
  healthy: true,
  liquidatable: false,
};
const after: AccountState = { ...now, cash: 3945.411608, equity: 10320.82655, im: 1741.603995, mm: 1306.202996, worstScenario: 38 };

describe('MarginMeter', () => {
  it('tables each figure now, after and the change', async () => {
    const { container } = render(<MarginMeter now={now} after={after} />);
    const table = screen.getByRole('table', { name: /Margin now and after/ });
    const im = within(table).getByRole('row', { name: /Initial margin/ });
    expect(within(im).getAllByRole('cell').map((c) => c.textContent)).toEqual(['656.25', '1,741.60', '+1,085.35']);
    const free = within(table).getByRole('row', { name: /Free to trade/ });
    expect(within(free).getAllByRole('cell').map((c) => c.textContent)).toEqual(['9,665.35', '8,579.22', '−1,086.12']);
    expect(screen.getByText(/16\.9% of equity, up from 6\.4%/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws both lanes on one scale; the after lane takes the ticket a frame later', async () => {
    render(<MarginMeter now={now} after={after} />);
    expect(screen.getByRole('meter', { name: 'Now' })).toHaveAttribute('aria-valuemax', '12000');
    await waitFor(() =>
      expect(screen.getByRole('meter', { name: 'After' }).getAttribute('aria-valuetext')).toContain('initial margin 1,741.60'),
    );
    expect(screen.getByText('+1,085.35 IM')).toBeInTheDocument();
  });

  it('says when the ticket takes the account under initial margin', () => {
    render(<MarginMeter now={now} after={{ ...after, equity: 1500 }} />);
    expect(screen.getByText(/Below initial margin after this trade/)).toBeInTheDocument();
  });

  it('without a ticket, the after column is empty', () => {
    render(<MarginMeter now={now} />);
    const im = screen.getByRole('row', { name: /Initial margin/ });
    expect(within(im).getAllByRole('cell')[1]).toHaveTextContent('—');
    expect(screen.getByText(/Pick a bid or an ask/)).toBeInTheDocument();
  });
});

describe('ScenarioStrip', () => {
  const cells = Array.from({ length: 39 }, (_, i) => i - 20);
  it('rings the worst cell and reads it out', async () => {
    const { container } = render(<ScenarioStrip grids={[{ name: 'After', cells }]} range={{ symbol: 'NVDA', value: 0.115476 }} />);
    expect(container.querySelector('[data-worst]')?.getAttribute('data-cell')).toBe('0');
    expect(screen.getByText(/Worst of 39/)).toHaveTextContent('after −20.00 at NVDA −11.5%, vol ×0.7');
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('refusal copy', () => {
  it('states the agent budget breach: post-trade lossIM against the budget, and what the ticket adds', () => {
    const r = {
      code: 'AgentRiskBudgetExceeded',
      message: 'x',
      numbers: { worstLoss: 1762.715506, budget: 1500, used: 596.506189, remaining: 903.493811 },
    };
    const c = refusalCopy(r, 'Account 7, signed by hedge-bot', 'hedge-bot');
    expect(c.reason).toBe("hedge-bot's risk budget can't carry this ticket.");
    expect(c.breach).toEqual({ attempted: { label: 'Worst case after', value: 1762.715506 }, limit: { label: 'Budget', value: 1500 } });
    render(<RefusalNotice refusal={r} who="Account 7, signed by hedge-bot" agentLabel="hedge-bot" />);
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent(
      'Worst case after this trade: 1,762.72 USDG against a 1,500.00 USDG budget (596.51 now; this ticket adds 1,166.21)',
    );
    expect(card).toHaveTextContent('262.72');
    expect(card).toHaveTextContent('Cut the size until initial margin stays at or under 1,500.00 USDG');
  });

  it('names the premium cap and the value-drain cap with their numbers', () => {
    const p = refusalCopy({ code: 'AgentPremiumExceeded', message: 'x', numbers: { premium: 1535.59, cap: 500 } }, 'Account 7', 'hedge-bot');
    expect(p.reason).toBe("The premium is over hedge-bot's per-trade cap.");
    expect(p.breach).toEqual({ attempted: { label: 'Premium', value: 1535.59 }, limit: { label: 'Per-trade cap', value: 500 } });
    const d = refusalCopy({ code: 'AgentValueDrainExceeded', message: 'x', numbers: { loss: 567.75, cap: 500 } }, 'Account 7', 'hedge-bot');
    expect(d.breach?.attempted).toEqual({ label: 'Value given up', value: 567.75 });
    expect(refusalCopy({ code: 'AgentUnderlyingNotAllowed', message: 'x' }, 'Account 7', 'hedge-bot').reason).toBe(
      'hedge-bot may not trade this underlying.',
    );
  });

  it('turns a margin shortfall into the deposit that would clear it', () => {
    const c = refusalCopy({ code: 'InsufficientMargin', message: 'x', numbers: { im: 3120.5, equity: 2890 } }, 'Account 12');
    expect(c.breach?.gapLabel).toBe('Short by');
    expect(c.hint).toBe('Deposit 230.50 USDG, or cut the size until margin fits inside equity.');
  });

  it('falls back to the contract message for codes it does not know', () => {
    expect(refusalCopy({ code: 'OpenInterestCap', message: 'Open interest is at its cap.' }, 'Account 7').reason).toBe(
      'Open interest is at its cap.',
    );
  });
});
