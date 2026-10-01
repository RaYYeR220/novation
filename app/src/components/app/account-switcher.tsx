'use client';

import { Button } from '@/components/ui/button';
import { useIsDemo, useSubaccount } from '@/lib/client/hooks';
import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { DEMO_ACCOUNTS, accountLabel, useAccountId } from './account-context';
import { Popover } from './popover';

function AccountOption({ id, selected, onPick }: { id: number; selected: boolean; onPick: () => void }) {
  const { data } = useSubaccount(id);
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
        #{id} <span className="font-normal text-navy-200">{accountLabel(id)}</span>
      </span>
      <span className="col-start-2 text-t12 tabular-nums text-navy-200">
        {data
          ? `Equity ${fmtNumber(data.state.equity)}, IM ${fmtNumber(data.state.im)}, ${data.positions.length} series`
          : 'Loading'}
      </span>
    </label>
  );
}

/** Which subaccount the app acts for. The demo has two: the fixture book and the RFQ maker. */
export function AccountSwitcher({ compact = false }: { compact?: boolean }) {
  const { id, setId } = useAccountId();
  const demo = useIsDemo();
  const accounts = demo ? DEMO_ACCOUNTS.map((a) => a.id) : [id];
  return (
    <Popover
      label="Subaccounts"
      trigger={(p) => (
        <Button size="sm" variant="secondary" {...p} aria-label={`Subaccount ${id}, ${accountLabel(id)}. Change`}>
          <span className="tabular-nums">#{id}</span>
          {!compact && <span className="font-normal text-navy-200">{accountLabel(id)}</span>}
        </Button>
      )}
    >
      {(close) => (
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
        </fieldset>
      )}
    </Popover>
  );
}
