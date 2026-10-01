'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useLiveTx } from '@/components/app/live-tx';
import { RefusalNotice } from '@/components/app/refusal-card';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { NumberField } from '@/components/ui/number-field';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { useWallet } from '@/lib/client/hooks';
import type { Refusal } from '@/lib/client/types';
import { fmtQty } from '@/lib/format';
import { parseAmount } from '@/components/earn/vault-dialogs';

const ASSETS = ['USDG', 'NVDA', 'TSLA', 'AAPL', 'SPY'] as const;

/**
 * Live mode: move tokens between the connected wallet and a subaccount. USDG becomes cash; a stock
 * token becomes collateral (owner only). A withdrawal from an account with positions must leave it
 * above initial margin, and the chain's refusal shows its numbers.
 */
export function FundsDialog({
  mode,
  open,
  onOpenChange,
  accountId,
  held,
}: {
  mode: 'deposit' | 'withdraw';
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accountId: number;
  /** What the account holds, per asset (cash under USDG). */
  held: Record<string, number>;
}) {
  const { address } = useAccount();
  const wallet = useWallet(address);
  const { run, busy } = useLiveTx();
  const [asset, setAsset] = useState<string>('USDG');
  const [raw, setRaw] = useState('');
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  const max = mode === 'deposit' ? (wallet.data?.tokens[asset] ?? 0) : (held[asset] ?? 0);
  const parsed = parseAmount(raw, max, asset, mode === 'deposit' ? 'your wallet holds' : 'the account holds');
  const verb = mode === 'deposit' ? 'Deposit' : 'Withdraw';
  const submit = async () => {
    if (parsed.error) return;
    setRefusal(undefined);
    const r = await run(`${verb} ${fmtQty(parsed.value)} ${asset}`, (c) =>
      mode === 'deposit' ? c.deposit(accountId, asset, parsed.value) : c.withdraw(accountId, asset, parsed.value),
    );
    if (r.ok) {
      onOpenChange(false);
      setRaw('');
    } else if (r.refusal) setRefusal(r.refusal);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setRefusal(undefined);
      }}
      title={`${verb} ${mode === 'deposit' ? 'into' : 'from'} account ${accountId}`}
      description={
        mode === 'deposit'
          ? 'USDG becomes cash; a stock token becomes collateral, valued at spot in the margin.'
          : 'Back to the connected wallet. With positions open, the account must stay above initial margin.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" lamp loading={busy} loadingLabel="Sending" disabled={!address || Boolean(parsed.error)} onClick={() => void submit()}>
            {parsed.error ? verb : `${verb} ${fmtQty(parsed.value)} ${asset}`}
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="grid gap-s4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SegmentedControl legend="Asset" showLegend size="sm" value={asset} onValueChange={setAsset}>
          {ASSETS.map((a) => (
            <Segment key={a} value={a}>
              {a}
            </Segment>
          ))}
        </SegmentedControl>
        <NumberField
          label="Amount"
          unit={asset}
          value={raw}
          onValueChange={setRaw}
          step={1}
          min={0}
          max={max}
          hint={mode === 'deposit' ? `Your wallet: ${fmtQty(max)} ${asset}.` : `In the account: ${fmtQty(max)} ${asset}.`}
          error={raw ? parsed.error : undefined}
          data-autofocus=""
        />
        {!address && <p className="text-t13 text-navy-200">Connect a wallet to sign.</p>}
        {refusal && <RefusalNotice refusal={refusal} who={`Account ${accountId}`} level={4} />}
      </form>
    </Dialog>
  );
}
