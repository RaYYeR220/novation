import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stat } from '@/components/ui/stat';
import { axe } from './axe';

describe('Stat', () => {
  it('pairs the label with the value and unit', async () => {
    const { container } = render(<Stat label="Equity" value="10,321.60" unit="USDG" />);
    expect(screen.getByText('Equity').tagName).toBe('DT');
    expect(screen.getByText('10,321.60')).toHaveClass('tabular-nums');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('colours a delta by whether its direction is good', () => {
    const { rerender } = render(
      <Stat label="Initial margin" value="1,741.60" delta={{ value: 1085.35, text: '+1,085.35', label: 'after this trade', good: 'down' }} />,
    );
    expect(screen.getByText('+1,085.35')).toHaveClass('text-loss-1');
    expect(screen.getByText(/up/)).toHaveClass('sr-only');
    rerender(<Stat label="Premium, 7 days" value="$18,450.00" delta={{ value: 12, text: '+12.00' }} />);
    expect(screen.getByText('+12.00')).toHaveClass('text-gain-2');
    rerender(<Stat label="Socialized loss" value="$0.00" delta={{ value: 0, text: '0.00' }} />);
    expect(screen.getByText('0.00')).toHaveClass('text-navy-200');
    expect(screen.getByText(/unchanged/)).toBeInTheDocument();
  });

  it('says when a value is missing or loading', async () => {
    const { container } = render(
      <>
        <Stat label="Vault APY" value={null} />
        <Stat label="Equity" value="0" loading />
      </>,
    );
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
