import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { axe } from './axe';

const Switch = (props: { onValueChange?: (v: string) => void; disabled?: boolean }) => (
  <SegmentedControl legend="Market session" defaultValue="REGULAR" {...props}>
    <Segment value="REGULAR">Regular</Segment>
    <Segment value="WEEKEND">Weekend</Segment>
    <Segment value="HOLIDAY" disabled>
      Holiday
    </Segment>
  </SegmentedControl>
);

describe('SegmentedControl', () => {
  it('is a named radio group with the default checked', async () => {
    const { container } = render(<Switch />);
    expect(screen.getByRole('group', { name: 'Market session' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Regular' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Holiday' })).toBeDisabled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('moves the choice with arrow keys and reports it', async () => {
    const onValueChange = vi.fn();
    render(<Switch onValueChange={onValueChange} />);
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'Regular' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Weekend' })).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith('WEEKEND');
  });

  it('selects on click', async () => {
    render(<Switch />);
    await userEvent.click(screen.getByText('Weekend'));
    expect(screen.getByRole('radio', { name: 'Weekend' })).toBeChecked();
  });

  it('disables the whole group', () => {
    render(<Switch disabled />);
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
  });
});
