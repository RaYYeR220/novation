import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Meter, meterState, niceCeil } from '@/components/ui/meter';
import { axe } from './axe';

describe('Meter', () => {
  it('is a named meter with a full text value', async () => {
    const { container } = render(<Meter label="Equity, account 7" value={10321.599641} im={656.252198} mm={492.189148} />);
    const m = screen.getByRole('meter', { name: 'Equity, account 7' });
    expect(m).toHaveAttribute('aria-valuenow', '10321.599641');
    expect(m).toHaveAttribute('aria-valuemin', '0');
    expect(m.getAttribute('aria-valuetext')).toBe(
      '10,321.60 USDG. Initial margin 656.25, maintenance margin 492.19. Above initial margin. New trades can open.',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('derives the state from the datums', () => {
    expect(meterState(10, 5, 4)).toBe('clear');
    expect(meterState(5, 5, 4)).toBe('clear');
    expect(meterState(4.5, 5, 4)).toBe('restricted');
    expect(meterState(3, 5, 4)).toBe('liquidatable');
    render(<Meter label="Equity" value={2890} im={3120.5} mm={2340.375} />);
    expect(screen.getByText(/Opening trades are refused/)).toBeInTheDocument();
  });

  it('places the datums on the scale', () => {
    const { container } = render(<Meter label="Equity" value={50} im={40} mm={30} max={100} />);
    const zone = container.querySelector<HTMLElement>('[data-zone="liquidation"]');
    expect(zone?.style.width).toBe('30%');
    expect(screen.getByText('IM').parentElement?.parentElement?.style.left).toBe('40%');
  });

  it('clamps an out-of-range value', () => {
    render(<Meter label="Equity" value={-120} im={40} mm={30} max={100} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText(/can be liquidated/)).toBeInTheDocument();
  });

  it('rounds the default scale end', () => {
    expect(niceCeil(11870)).toBe(12000);
    expect(niceCeil(3588)).toBe(4000);
    expect(niceCeil(2.3)).toBe(2.5);
    expect(niceCeil(0)).toBe(1);
  });

  it('shows loading without a meter role', async () => {
    const { container } = render(<Meter label="Equity" value={0} im={0} mm={0} loading />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('Loading margin')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
