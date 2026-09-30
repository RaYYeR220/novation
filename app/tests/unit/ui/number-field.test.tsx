import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumberField } from '@/components/ui/number-field';
import { axe } from './axe';

describe('NumberField', () => {
  it('labels the input and describes it with the hint', async () => {
    const { container } = render(<NumberField label="Size" unit="contracts" defaultValue="60" hint="Whole contracts, 1 to 500." />);
    const input = screen.getByRole('textbox', { name: 'Size' });
    expect(input).toHaveValue('60');
    expect(input).toHaveAccessibleDescription('Whole contracts, 1 to 500.');
    expect(screen.getByText('contracts')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('marks errors as invalid and reads the message', async () => {
    const { container } = render(
      <NumberField label="Premium" unit="USDG" defaultValue="-4" error="Premium must be above zero." hint="Per contract." />,
    );
    const input = screen.getByRole('textbox', { name: 'Premium' });
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription('Per contract. Premium must be above zero.');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('steps with arrow keys inside min and max', async () => {
    const onValueChange = vi.fn();
    render(<NumberField label="Size" defaultValue="499" step={1} min={1} max={500} onValueChange={onValueChange} />);
    const input = screen.getByRole('textbox', { name: 'Size' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowUp}');
    expect(input).toHaveValue('500');
    await userEvent.keyboard('{ArrowUp}');
    expect(input).toHaveValue('500');
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(input).toHaveValue('490');
    expect(onValueChange).toHaveBeenLastCalledWith('490');
  });

  it('keeps decimals from the step', async () => {
    render(<NumberField label="Premium" defaultValue="1.2" step={0.05} />);
    const input = screen.getByRole('textbox', { name: 'Premium' });
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowUp}');
    expect(input).toHaveValue('1.25');
  });

  it('accepts typing and respects disabled', async () => {
    render(
      <>
        <NumberField label="Size" />
        <NumberField label="Locked" disabled defaultValue="3" />
      </>,
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Size' }), '12.5');
    expect(screen.getByRole('textbox', { name: 'Size' })).toHaveValue('12.5');
    expect(screen.getByRole('textbox', { name: 'Locked' })).toBeDisabled();
  });

  it('flags a busy quote', () => {
    render(<NumberField label="Premium" unit="USDG" busy defaultValue="25.77" />);
    expect(screen.getByRole('textbox', { name: 'Premium' })).toHaveAttribute('aria-busy', 'true');
  });
});
