import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { axe } from './axe';

function Harness({ onConfirm = () => {} }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Revoke hedge-bot</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Revoke hedge-bot?"
        description="hedge-bot stops trading for account 7 at once. Its open positions stay."
        footer={
          <>
            <Button data-autofocus onClick={() => setOpen(false)}>
              Keep grant
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onConfirm();
                setOpen(false);
              }}
            >
              Revoke grant
            </Button>
          </>
        }
      />
    </>
  );
}

describe('Dialog', () => {
  it('opens as a named, described dialog and focuses the safe action', async () => {
    const { container } = render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke hedge-bot' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke hedge-bot?' });
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveAccessibleDescription(/stops trading/);
    expect(screen.getByRole('button', { name: 'Keep grant' })).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('closes from the close button and returns focus to the opener', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Revoke hedge-bot' });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('runs the confirm action', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke hedge-bot' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke grant' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('syncs when the browser closes it (Escape)', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke hedge-bot' }));
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    dialog.close();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
