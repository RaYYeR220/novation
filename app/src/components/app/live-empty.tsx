'use client';

import { Lamp } from '@/components/ui/lamp';

/** Live mode with no account to show: none picked yet, or the number isn't on chain. */
export function LiveEmpty({ id, error }: { id: number; error?: string }) {
  return (
    <section aria-labelledby="live-empty" className="grid max-w-[640px] gap-s3 py-s6">
      <h2 id="live-empty" className="flex items-center gap-s3 text-[28px] leading-tight font-normal text-navy-50">
        <Lamp tone="navy-400" state="ring" size={8} />
        {error ? `Account ${id} could not be read` : 'No subaccount on RH Chain testnet yet'}
      </h2>
      <p className="text-t15 text-pretty text-navy-200">
        {error
          ? error
          : 'Connect a wallet and create a subaccount from the account menu in the top bar, or open any account by its number there.'}
      </p>
      <p className="text-t13 text-navy-200">Get test tokens from the wallet menu once connected: the testnet USDG and stock tokens are mocks anyone can mint.</p>
    </section>
  );
}
