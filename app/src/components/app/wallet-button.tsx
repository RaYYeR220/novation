'use client';

import { useId, useState } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Lamp } from '@/components/ui/lamp';
import { fmtAddress } from '@/lib/format';
import { CHAINS } from '@/lib/wallet/chains';
import { cn } from '@/lib/cn';
import { Popover } from './popover';

/** A switch that is drawn but cannot be turned on: the 7702 one-click path is not shipped. */
function ExperimentalToggle() {
  const id = useId();
  return (
    <div className="grid gap-s2 border-t border-navy-700 pt-s3">
      <div className="flex items-center justify-between gap-s3">
        <span id={`${id}-label`} className="flex items-center gap-s2 text-t13 font-medium text-navy-50">
          One-click trading
          <Chip size="sm">Experimental</Chip>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked="false"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-note`}
          disabled
          className="relative h-5 w-9 shrink-0 cursor-not-allowed rounded-full border border-navy-600 bg-navy-900"
        >
          <span aria-hidden="true" className="absolute left-[3px] top-1/2 size-3 -translate-y-1/2 rounded-full border border-navy-400" />
        </button>
      </div>
      <p id={`${id}-note`} className="text-t12 text-navy-200">
        An EIP-7702 smart account (ZeroDev Kernel) would batch approve, deposit and trade into one confirmation. Off in
        this build.
      </p>
    </div>
  );
}

const connectorName = (name: string) => (name === 'Injected' ? 'Browser wallet' : name);

/** Connect through an injected wallet or WalletConnect; once connected, the address and a way out. */
export function WalletButton() {
  const { address, isConnected, chainId, connector } = useAccount();
  const { connect, connectors, isPending, error, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const [copied, setCopied] = useState(false);
  const chain = CHAINS.find((c) => c.id === chainId);

  if (isConnected && address) {
    return (
      <Popover
        label="Wallet"
        trigger={(p) => (
          <Button size="sm" variant="secondary" {...p} aria-label={`Wallet ${address}`}>
            <Lamp tone="navy-200" size={6} />
            <span className="tabular-nums">{fmtAddress(address)}</span>
          </Button>
        )}
      >
        {(close) => (
          <div className="grid gap-s3">
            <div className="grid gap-s1">
              <p className="text-t12 text-navy-200">Connected with {connectorName(connector?.name ?? 'a wallet')}</p>
              <p className="break-all text-t13 tabular-nums text-navy-50">{address}</p>
              <p className="text-t12 text-navy-200">{chain ? chain.name : `Chain ${chainId}`}</p>
            </div>
            <div className="flex gap-s2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(address).then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy address'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  disconnect();
                  close();
                }}
              >
                Disconnect
              </Button>
            </div>
            <ExperimentalToggle />
          </div>
        )}
      </Popover>
    );
  }

  return (
    <Popover
      label="Connect a wallet"
      trigger={(p) => (
        <Button size="sm" variant="secondary" loading={isPending} loadingLabel="Connecting" {...p}>
          Connect wallet
        </Button>
      )}
    >
      {(close) => (
        <div className="grid gap-s3">
          <p className="text-t13 text-navy-200">Sign trades from any EOA. Reading and the what-if work without one.</p>
          <ul className="grid gap-s1">
            {connectors.map((c) => (
              <li key={c.uid}>
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    connect(
                      { connector: c },
                      {
                        onSuccess: () => close(),
                      },
                    );
                  }}
                  className={cn(
                    'flex h-10 w-full items-center justify-between rounded-control border border-navy-700 px-s3 text-left text-t15 text-navy-50',
                    'transition-colors duration-(--duration-fast) ui-hover:border-navy-400 ui-hover:bg-navy-800',
                  )}
                >
                  {connectorName(c.name)}
                  <span className="text-t12 text-navy-200">{c.type === 'walletConnect' ? 'QR code' : 'This browser'}</span>
                </button>
              </li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="flex items-center gap-s2 text-t12 text-loss-1">
              <Lamp tone="loss-2" size={6} />
              {/provider not found/i.test(error.message)
                ? 'No browser wallet found. Install one, or use WalletConnect.'
                : error.message.split('\n')[0]}
            </p>
          )}
          <ExperimentalToggle />
        </div>
      )}
    </Popover>
  );
}
