'use client';

import { useState } from 'react';
import { useAccountId } from '@/components/app/account-context';
import { LiveEmpty } from '@/components/app/live-empty';
import { LIVE_RPC } from '@/lib/client/chain';
import { RefusalNotice } from '@/components/app/refusal-card';
import { Page, SectionHead } from '@/components/app/section-head';
import { BudgetMeter } from '@/components/charts/budget-meter';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useAgentActions, useAgents, useAsOf, useIsDemo, useSubaccount, useUnderlyings } from '@/lib/client/hooks';
import type { AgentGrant } from '@/lib/client/types';
import { fmtAddress, fmtAgo, fmtNumber } from '@/lib/format';
import { fmtEt } from '@/lib/nyse';
import { explorerTx } from '@/lib/wallet/chains';
import { GrantDialog } from './grant-dialog';

const mcpConfig = (rpc: string, account: number) => `{
  "mcpServers": {
    "novation": {
      "command": "npx",
      "args": ["-y", "@novation/mcp"],
      "env": {
        "NOVATION_RPC_URL": "${rpc}",
        "NOVATION_ACCOUNT_ID": "${account}",
        "NOVATION_AGENT_KEY": "<the agent's private key, never the owner's>"
      }
    }
  }
}`;
const MCP_CONFIG = mcpConfig('https://rpc.mainnet.chain.robinhood.com', 7);

const MCP_TOOLS = [
  ['list_underlyings, get_chain, quote', 'read markets and vault quotes'],
  ['what_if_margin, portfolio, risk_budget', 'the kernel’s margin before signing, and how much budget is left'],
  ['buy_from_vault, fill_rfq', 'trade within the grant'],
  ['explain_refusal', 'turn a reverted transaction into the rule and numbers that refused it'],
] as const;

function GrantRow({ g, asOf, onRevoke, canRevoke = true }: { g: AgentGrant; asOf: number; onRevoke: () => void; canRevoke?: boolean }) {
  const expired = g.expiresAt <= asOf;
  return (
    <li
      data-agent={g.label}
      className="grid gap-s4 border-b border-navy-800 py-s5 lg:grid-cols-[220px_minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-start lg:gap-s6"
    >
      <div className="grid content-start gap-s2">
        <h3 className="text-[24px] leading-none font-normal text-navy-50">{g.label}</h3>
        <p className="text-t12 tabular-nums text-navy-200">{fmtAddress(g.agent)}</p>
        {expired ? (
          <Chip size="sm" lamp="navy-400" lampState="ring" className="justify-self-start">
            Expired
          </Chip>
        ) : (
          <Chip size="sm" lamp="cyan" className="justify-self-start">
            Active
          </Chip>
        )}
      </div>
      <BudgetMeter used={g.used} budget={g.maxWorstLoss} refused={g.lastRefusal?.numbers?.worstLoss} inactive={expired} />
      <dl className="grid content-start gap-s2 text-t13">
        <div className="flex justify-between gap-s3">
          <dt className="text-navy-200">Premium cap per trade</dt>
          <dd className="tabular-nums text-navy-50">{fmtNumber(g.maxPremiumPerTrade)}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-s3">
          <dt className="text-navy-200">May trade</dt>
          <dd className="flex flex-wrap gap-1">
            {g.allowed.map((u) => (
              <Chip key={u} size="sm">
                {u}
              </Chip>
            ))}
          </dd>
        </div>
        <div className="flex justify-between gap-s3">
          <dt className="text-navy-200">{expired ? 'Expired' : 'Expires'}</dt>
          <dd className="text-right tabular-nums text-navy-50">
            {fmtEt(g.expiresAt, { weekday: false })}
            <span className="block text-t12 text-navy-200">{fmtAgo(g.expiresAt, asOf)}</span>
          </dd>
        </div>
      </dl>
      <div className="lg:justify-self-end">
        <Button variant="secondary" size="sm" onClick={onRevoke} disabled={!canRevoke}>
          Revoke {g.label}
        </Button>
      </div>
    </li>
  );
}

function McpSnippet({ config = MCP_CONFIG }: { config?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-s5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="grid min-w-0 content-start gap-s2">
        <div className="flex items-center justify-between gap-s3">
          <p className="text-t13 text-navy-200">MCP client config</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(config).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-control border border-navy-700 bg-navy-950 p-s4 font-mono text-[13px] leading-relaxed text-navy-50" tabIndex={0} aria-label="MCP client config">
          <code>{config}</code>
        </pre>
      </div>
      <div className="grid content-start gap-s3">
        <p className="text-t15 text-pretty text-navy-200">
          The server signs with the agent&apos;s key, so the grant above is the limit: a ticket over budget reverts on chain exactly as it would from any
          wallet. Nothing in the server can lift it.
        </p>
        <dl className="grid gap-s2 text-t13">
          {MCP_TOOLS.map(([k, v]) => (
            <div key={k} className="grid gap-0.5 border-t border-navy-800 pt-s2">
              <dt className="font-medium text-navy-50">{k}</dt>
              <dd className="text-navy-200">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-t12 text-navy-200">The MCP server ships with the SDK; the package is not published yet.</p>
      </div>
    </div>
  );
}

export function AgentsView() {
  const { id, label, owned } = useAccountId();
  const agents = useAgents(id);
  const account = useSubaccount(id);
  const underlyings = useUnderlyings();
  const { data: asOf } = useAsOf();
  const demo = useIsDemo();
  const { toast } = useToast();
  const { grant, revoke } = useAgentActions(id);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<AgentGrant | null>(null);

  const grants = agents.data ?? [];
  if (!demo && (id === 0 || account.isError)) {
    return (
      <Page>
        <LiveEmpty id={id} error={account.isError ? (account.error as Error).message : undefined} />
      </Page>
    );
  }
  const last = grants
    .filter((g) => g.lastRefusal)
    .map((g) => ({ g, r: g.lastRefusal! }))
    .at(0);

  return (
    <Page>
      <section aria-labelledby="grants" className="grid gap-s5">
        <SectionHead
          id="grants"
          title={`Agents on account ${id}`}
          dek="A grant lets a bot trade for this account inside a risk budget: after every trade it signs, the account's worst-case loss (its initial margin) must stay within the budget, and the premium within the per-trade cap. It caps risk, not spending."
          aside={
            <Button variant="primary" lamp onClick={() => setGranting(true)} disabled={!account.data || asOf === undefined || (!demo && !owned.includes(id))}>
              Grant an agent
            </Button>
          }
        />
        {agents.isPending || asOf === undefined ? (
          <Skeleton className="h-40 w-full" />
        ) : grants.length === 0 ? (
          <p className="text-t15 text-navy-200">
            No agent can trade for account {id} ({label(id)}). Grant one to let a bot trade inside a budget the chain enforces.
          </p>
        ) : (
          <ul aria-label="Grants">
            {grants.map((g) => (
              <GrantRow key={g.agent} g={g} asOf={asOf} onRevoke={() => setRevoking(g)} canRevoke={demo || owned.includes(id)} />
            ))}
          </ul>
        )}
        {grants.length > 1 && (
          <p className="text-t13 text-pretty text-navy-200">
            Every grant on one account reads the same worst case: the budget limits what the account may carry while that agent trades.
          </p>
        )}
      </section>

      {last && (
        <section aria-labelledby="last-refusal" className="grid gap-s5">
          <SectionHead id="last-refusal" title="Last refusal" dek={`The last trade an agent on account ${id} tried that the chain turned down.`} />
          <RefusalNotice
            refusal={last.r}
            who={`Account ${id}, signed by ${last.g.label}`}
            agentLabel={last.g.label}
            announce={false}
            level={3}
            className="max-w-[880px]"
            proof={last.r.txHash ? { href: explorerTx(last.r.txHash), label: `Transaction ${fmtAddress(last.r.txHash)}${demo ? ' (demo hash, not on chain)' : ''}` } : undefined}
          />
        </section>
      )}

      <section aria-labelledby="mcp" className="grid gap-s5">
        <SectionHead id="mcp" title="Connect an agent over MCP" dek="Give an AI agent the Novation tools with the key you granted above." />
        <McpSnippet config={demo ? MCP_CONFIG : mcpConfig(LIVE_RPC, id)} />
      </section>

      {account.data && asOf !== undefined && (
        <GrantDialog
          open={granting}
          onOpenChange={setGranting}
          accountId={id}
          owner={account.data.owner}
          worstNow={account.data.state.im}
          underlyings={(underlyings.data ?? []).map((u) => u.symbol)}
          asOf={asOf}
          busy={grant.isPending}
          onGrant={(g) =>
            grant.mutate(g, {
              onSuccess: () => {
                setGranting(false);
                toast({
                  tone: 'done',
                  title: `${g.label} granted`,
                  description: `Budget ${fmtNumber(g.maxWorstLoss)} USDG, premium cap ${fmtNumber(g.maxPremiumPerTrade)}.${demo ? ' Demo: kept in this browser session, nothing sent to a chain.' : ''}`,
                });
              },
              onError: (e) => toast({ tone: 'refused', title: 'Grant refused', description: (e as Error).message }),
            })
          }
        />
      )}

      <Dialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        dismissible={false}
        size="sm"
        title={revoking ? `Revoke ${revoking.label}?` : 'Revoke'}
        description={
          revoking
            ? `${revoking.label} loses access at once: any trade it signs from now reverts NotAuthorized. Positions it opened stay with account ${id}.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)} data-autofocus="">
              Keep it
            </Button>
            <Button
              variant="primary"
              loading={revoke.isPending}
              onClick={() => {
                const g = revoking;
                if (!g) return;
                revoke.mutate(g.agent, {
                  onSuccess: () => {
                    setRevoking(null);
                    toast({
                      tone: 'done',
                      title: `${g.label} revoked`,
                      description: demo ? 'Demo: removed for this browser session, nothing sent to a chain.' : undefined,
                    });
                  },
                });
              }}
            >
              Revoke {revoking?.label}
            </Button>
          </>
        }
      />
    </Page>
  );
}
