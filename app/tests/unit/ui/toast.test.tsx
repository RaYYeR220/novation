import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toast, ToastProvider, useToast, type ToastData } from '@/components/ui/toast';
import { axe } from './axe';

function Trigger({ data }: { data: ToastData }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast(data)}>
      Notify
    </button>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Toast', () => {
  it('renders each tone', async () => {
    const { container } = render(
      <div>
        <Toast title="Trade cleared" description="Sold 60 NVDA 200 calls." tone="done" />
        <Toast title="Refused" description="AgentRiskBudgetExceeded" tone="refused" />
        <Toast title="Submitting trade" tone="pending" />
        <Toast title="Session changed" tone="neutral" onDismiss={() => {}} />
      </div>,
    );
    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('queues into a polite live list and dismisses', async () => {
    const { container } = render(
      <ToastProvider>
        <Trigger data={{ title: 'Trade cleared', tone: 'done', duration: 0 }} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Notify' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region.querySelector('ol')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Trade cleared')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Trade cleared')).toBeNull();
  });

  it('announces refusals assertively', async () => {
    render(
      <ToastProvider>
        <Trigger data={{ title: 'Trade refused', tone: 'refused' }} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Notify' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Trade refused');
  });

  it('leaves on its own after the duration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <Trigger data={{ title: 'Session changed', duration: 1000 }} />
      </ToastProvider>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Notify' }).click();
    });
    expect(screen.getByText('Session changed')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText('Session changed')).toBeNull();
  });

  it('closes a focused toast with Escape', async () => {
    render(
      <ToastProvider>
        <Trigger data={{ title: 'Trade cleared', duration: 0 }} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Notify' }));
    screen.getByRole('button', { name: 'Dismiss notification' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('Trade cleared')).toBeNull();
  });
});
