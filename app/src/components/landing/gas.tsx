import { Suspense } from 'react';
import { GasChart } from '@/components/charts/GasChart';
import type { GasRow } from '@/lib/client/types';
import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { TX_GAS_CAP, fmtGas, tradeGas } from '@/lib/gas';
import { Fig, Ref, SectionHead, TEXT_LINK, WRAP, srcAttr } from './parts';
import { CONTRACTS, shortAddress, testnetAddress } from './site';

/** eth_estimateGas for margin() on the deployed kernel and its plain Solidity reference, Sep 30, 2026 (docs/gas.md). */
const DEPLOYED = {
  n32: { kernel: 262_876, reference: 22_092_627 },
  n256: { kernel: 1_664_367 },
};

export function Gas({ rows }: { rows: GasRow[] }) {
  const t = tradeGas(rows, 256);
  return (
    <section aria-labelledby="gas" className="relative mt-s10 bg-navy-950 pb-s10">
      <SectionHead id="gas" title="The margin check that outgrows an EVM transaction">
        <p>
          Portfolio margin re-prices every option in the book 39 times. Hand-optimized Solidity pays about <Fig id="bench">92,500</Fig> gas
          per position for that; the Stylus kernel about <Fig id="bench">5,000</Fig>.
          <Ref id="bench" /> A trade runs at least two margin checks. At 256 positions, two checks take{' '}
          <Fig id="bench">{fmtGas(t.solidity)}</Fig> gas in Solidity, over Arbitrum’s <Fig id="bench">{fmtGas(TX_GAS_CAP)}</Fig> per-transaction
          limit, and <Fig id="bench">{fmtGas(t.stylus)}</Fig> on Stylus.
        </p>
      </SectionHead>

      <div className={cn(WRAP, 'reveal mt-s8')}>
        <Suspense>
          <GasChart rows={rows} tradeAt={256} source={srcAttr('bench')} />
        </Suspense>
        <p className="mt-s5 text-t15 font-medium text-navy-50">
          Measured on Robinhood Chain testnet: execution gas of one margin call, same algorithm and integer math in both.
          <Ref id="bench" />
        </p>
      </div>

      <div className={cn(WRAP, 'mt-s8 grid gap-s6 border-t border-navy-50/10 pt-s6 md:grid-cols-6 md:gap-0')} data-source={srcAttr('kernel')}>
        <p className="text-t15 font-semibold text-navy-50 md:col-span-2 md:pr-s7">
          The deployed kernel
          <Ref id="kernel" />
        </p>
        <div className="grid gap-s5 text-t15 text-navy-200 sm:grid-cols-2 md:col-span-4 md:gap-0">
          <p className="sm:pr-s7">
            At 32 positions, a margin call to the deployed Stylus kernel costs{' '}
            <span className="font-semibold text-navy-50">{fmtNumber(DEPLOYED.n32.kernel, 0)}</span> gas as a transaction. The plain Solidity
            reference, which returns the same bytes, costs <span className="font-semibold text-navy-50">{fmtNumber(DEPLOYED.n32.reference, 0)}</span>.
          </p>
          <p className="sm:pr-s7">
            At 256 positions the kernel needs <span className="font-semibold text-navy-50">{fmtNumber(DEPLOYED.n256.kernel, 0)}</span>. The
            reference runs out of gas.
          </p>
          <p className="flex flex-wrap gap-x-s5 gap-y-s2 text-t13 sm:col-span-2 sm:mt-s4">
            <a href={testnetAddress(CONTRACTS.kernel)} className={TEXT_LINK}>
              Kernel {shortAddress(CONTRACTS.kernel)}
            </a>
            <a href={testnetAddress(CONTRACTS.kernelReference)} className={TEXT_LINK}>
              Reference {shortAddress(CONTRACTS.kernelReference)}
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
