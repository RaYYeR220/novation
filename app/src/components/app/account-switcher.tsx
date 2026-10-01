'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { Button } from '@/components/ui/button';
import { useIsDemo, useSubaccount } from '@/lib/client/hooks';
import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { useAccountId } from './account-context';
import { useLiveTx } from './live-tx';
import { Popover } from './popover';

function AccountOption({ id, selected, onPick }: { id: number; selected: boolean; onPick: () => void }) {
  const { data, isError } = useSubaccount(id);
  const { label } = useAccountId();
  return (
    <label
      className={cn(
        'grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-s3 gap-y-0.5 rounded-control border px-s3 py-s2',
        'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-cyan',
        selected ? 'border-navy-400 bg-navy-800' : 'border-navy-700 ui-hover:border-navy-400',
      )}
    >
      <input type="radio" name="subaccount" className="sr-only" checked={selected} onChange={onPick} />
      <span
        aria-hidden="true"
        className={cn('mt-[5px] size-2.5 rounded-full border-[1.5px]', selected ? 'border-cyan bg-cyan' : 'border-navy-400')}
      />
      <span className="text-t15 font-medium text-navy-50">
        #{id} <span className="font-normal text-navy-200">{label(id)}</span>
      </span>
      <span className="col-start-2 text-t12 tabular-nums text-navy-200">
        {data
          ? `Equity ${fmtNumber(data.state.equity)}, IM ${fmtNumber(data.state.im)}, ${data.positions.length} series`
          : isError
            ? 'Not on chain'
            : 'Loading'}
      </span>
    </label>
  );
}

/** Live mode: open any account by number, or create one from the connected wallet. */
function LiveControls({ close }: { close: () => void }) {
  const { setId } = useAccountId();
  const { isConnected } = useAccount();
  const { run, busy } = useLiveTx();
  const [raw, setRaw] = useState('');
  const n = Number(raw);
  const valid = Number.isInteger(n) && n > 0;
  return (
    <div className="grid gap-s3 border-t border-navy-700 pt-s3">
      <form
        className="flex items-end gap-s2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setId(n);
          close();
        }}
      >
        <label className="grid flex-1 gap-1 text-t12 text-navy-200">
          View account number
          <input
            inputMode="numeric"
            value={raw}
            onChange={(e) => setRaw(e.target.value.replace(/[^0-9]/g, ''))}
            className="h-8 rounded-control border border-navy-600 bg-navy-900 px-s2 text-t13 tabular-nums text-navy-50 focus-visible:outline-2 focus-visible:outline-cyan"
          />
        </label>
        <Button size="sm" variant="secondary" type="submit" disabled={!valid}>
          View
        </Button>
      </form>
      <div className="grid gap-s1">
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          loadingLabel="Creating"
          disabled={!isConnected}
          onClick={async () => {
            const r = await run('Create subaccount', (c) => c.createSubaccount());
            if (r.ok) {
              setId(r.value.id);
              close();
            }
          }}
        >
          Create a subaccount
        </Button>
        <p className="text-t12 text-navy-200">{isConnected ? 'One transaction from the connected wallet.' : 'Connect a wallet to create one.'}</p>
      </div>
    </div>
  );
}

/** Which subaccount the app acts for. The demo has three: the fixture book, the RFQ maker and the short book under liquidation. */
export function AccountSwitcher({ compact = false }: { compact?: boolean }) {
  const { id, setId, accounts, label } = useAccountId();
  const demo = useIsDemo();
  const name = id > 0 ? label(id) : 'No account';
  return (
    <Popover
      label="Subaccounts"
      trigger={(p) => (
        <Button size="sm" variant="secondary" {...p} aria-label={`Subaccount ${id > 0 ? id : 'none'}, ${name}. Change`}>
          <span className="tabular-nums">{id > 0 ? `#${id}` : '#—'}</span>
          {!compact && <span className="font-normal text-navy-200">{name}</span>}
        </Button>
      )}
    >
      {(close) => (
        <div className="grid gap-s3">
          <fieldset className="m-0 grid gap-s2 border-0 p-0">
            <legend className="mb-s2 text-t13 text-navy-200">Subaccount</legend>
            {accounts.map((a) => (
              <AccountOption
                key={a}
                id={a}
                selected={a === id}
                onPick={() => {
                  setId(a);
                  close();
                }}
              />
            ))}
            {accounts.length === 0 && <p className="text-t13 text-navy-200">No subaccount yet.</p>}
          </fieldset>
          {!demo && <LiveControls close={close} />}
        </div>
      )}
    </Popover>
  );
}
