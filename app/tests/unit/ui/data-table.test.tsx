import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, type Column } from '@/components/ui/data-table';
import { axe } from './axe';

interface Row {
  id: string;
  series: string;
  qty: number;
  mark: number;
}

const rows: Row[] = [
  { id: '5', series: 'NVDA 200 call', qty: -40, mark: 25.77 },
  { id: '2', series: 'NVDA 170 put', qty: 10, mark: 0 },
  { id: '126', series: 'TSLA 380 put', qty: -6, mark: 11.74 },
];

const columns: Column<Row>[] = [
  { key: 'series', header: 'Series' },
  { key: 'qty', header: 'Qty', numeric: true },
  { key: 'mark', header: 'Mark', numeric: true, cell: (r) => r.mark.toFixed(2) },
];

describe('DataTable', () => {
  it('is a captioned table with right-aligned numeric columns', async () => {
    const { container } = render(<DataTable caption="Open positions" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const table = screen.getByRole('table', { name: 'Open positions' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
    expect(within(table).getByRole('columnheader', { name: 'Qty' })).toHaveClass('text-right');
    expect(within(table).getByText('25.77')).toHaveClass('text-right');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('moves row focus with arrows and activates with Enter', async () => {
    const onRowActivate = vi.fn();
    const { container } = render(
      <DataTable caption="Open positions" columns={columns} rows={rows} rowKey={(r) => r.id} onRowActivate={onRowActivate} />,
    );
    const bodyRows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    await userEvent.tab();
    expect(bodyRows[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(bodyRows[2]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(bodyRows[0]).toHaveFocus();
    await userEvent.keyboard('{End}{Enter}');
    expect(onRowActivate).toHaveBeenCalledWith(rows[2]);
    expect(bodyRows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('leaves keys and clicks inside nested controls alone', async () => {
    const onRowActivate = vi.fn();
    const onClose = vi.fn();
    const withAction: Column<Row>[] = [
      ...columns,
      {
        key: 'action',
        header: 'Action',
        hideHeader: true,
        cell: (r) => (
          <button type="button" onClick={() => onClose(r.id)}>
            Close {r.series}
          </button>
        ),
      },
    ];
    render(<DataTable caption="Positions" columns={withAction} rows={rows} rowKey={(r) => r.id} onRowActivate={onRowActivate} />);
    const button = screen.getByRole('button', { name: 'Close NVDA 200 call' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onRowActivate).not.toHaveBeenCalled();
    await userEvent.keyboard('{ArrowDown}');
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onRowActivate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('NVDA 170 put'));
    expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
  });

  it('keeps a tab stop when the focused row goes away', async () => {
    const { rerender } = render(
      <DataTable caption="Positions" columns={columns} rows={rows} rowKey={(r) => r.id} onRowActivate={() => {}} />,
    );
    await userEvent.tab();
    await userEvent.keyboard('{End}');
    rerender(
      <DataTable caption="Positions" columns={columns} rows={rows.slice(0, 2)} rowKey={(r) => r.id} onRowActivate={() => {}} />,
    );
    const bodyRows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(bodyRows.filter((r) => r.tabIndex === 0)).toEqual([bodyRows[0]]);
  });

  it('marks the current row', () => {
    render(<DataTable caption="Positions" columns={columns} rows={rows} rowKey={(r) => r.id} currentKey="126" />);
    expect(screen.getByText('TSLA 380 put').closest('tr')).toHaveAttribute('aria-current', 'true');
  });

  it('gives a scrolling table a focusable named region', async () => {
    const { container } = render(
      <DataTable caption="NVDA chain" columns={columns} rows={rows} rowKey={(r) => r.id} maxHeight={120} />,
    );
    const region = screen.getByRole('region', { name: 'NVDA chain' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows loading, empty and error states', async () => {
    const { rerender, container } = render(
      <DataTable caption="Positions" columns={columns} rows={[]} rowKey={(r) => r.id} loading />,
    );
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading positions')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    rerender(<DataTable caption="Positions" columns={columns} rows={[]} rowKey={(r) => r.id} empty="No open positions." />);
    expect(screen.getByText('No open positions.')).toBeInTheDocument();
    rerender(<DataTable caption="Positions" columns={columns} rows={rows} rowKey={(r) => r.id} error="Could not read positions." />);
    expect(screen.getByText('Could not read positions.')).toBeInTheDocument();
    expect(screen.queryByText('NVDA 200 call')).toBeNull();
  });
});
