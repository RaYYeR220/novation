import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Lamp } from '@/components/ui/lamp';
import { Meter } from '@/components/ui/meter';
import { NumberField } from '@/components/ui/number-field';
import { Panel } from '@/components/ui/panel';
import { RefusalCard } from '@/components/ui/refusal-card';
import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { fmtNumber, fmtSigned, fmtUsd } from '@/lib/format';
import { worstCell } from '@/lib/scenario';
import type { Refusal, Session } from '@/lib/client/types';
import account7 from '@/fixtures/account7.json';
import agents from '@/fixtures/agents.json';
import protocol from '@/fixtures/protocol.json';
import refusals from '@/fixtures/refusals.json';
import whatifs from '@/fixtures/whatifs.json';
import {
  ChainTable,
  DialogDemo,
  DialogPreview,
  LiveSessionSwitch,
  PositionsTable,
  TableStates,
  ToastDemo,
} from './demos';

export const metadata: Metadata = {
  title: 'Novation design system',
  robots: { index: false, follow: false },
};

/* ---------- data, all from fixtures ---------- */

const MM_RATIO = 0.75; // maintenance = 0.75 × initial, as in the kernel reference
const acct = account7.account.state;
const ticket = whatifs[0]!;
const after = ticket.quote.after;
const imWeekend = account7.summary.im_weekend;
const worst = worstCell(account7.grids.REGULAR.cells);
const hedgeBot = agents['7'][0]!;
const refusalList = refusals as (Refusal & { txHash?: string })[];
const budgetRefusal = refusalList.find((r) => r.code === 'AgentRiskBudgetExceeded');
const marginRefusal = refusalList.find((r) => r.code === 'InsufficientMargin');
const haltRefusal = refusalList.find((r) => r.code === 'OpeningNotAllowed');
const ticketRefusal = ticket.quote.refusal;

/* ---------- page furniture ---------- */

const SECTIONS = [
  ['foundations', 'Foundations'],
  ['button', 'Button'],
  ['segmented', 'Segmented control'],
  ['tabs', 'Tabs'],
  ['number-field', 'Number field'],
  ['stat', 'Stat'],
  ['chip', 'Chip'],
  ['tooltip', 'Tooltip'],
  ['panel', 'Panel'],
  ['data-table', 'Data table'],
  ['meter', 'Meter'],
  ['refusal', 'Refusal card'],
  ['toast', 'Toast'],
  ['dialog', 'Dialog'],
  ['skeleton', 'Skeleton'],
] as const;

function Specimen({
  id,
  name,
  file,
  source,
  children,
  summary,
}: {
  id: string;
  name: string;
  file?: string;
  source?: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-s6 border-t border-navy-700 pt-s7 pb-s8 max-sm:pt-s6 max-sm:pb-s7">
      <div className="grid gap-s2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-baseline">
        <h2 id={`${id}-h`} className="text-display-4 font-normal max-sm:text-[30px]">
          {name}
        </h2>
        {(file || source) && (
          <p className="text-t12 text-navy-200">
            {file}
            {file && source ? <span className="px-s2 text-navy-400">/</span> : null}
            {source && <span>data {source}</span>}
          </p>
        )}
      </div>
      <p className="mt-s3 max-w-[64ch] text-t15 text-navy-200">{summary}</p>
      <div className="mt-s6 grid gap-s6">{children}</div>
    </section>
  );
}

/** A row of state cells separated by hairlines. */
function States({
  label,
  children,
  cols = 6,
  stack = false,
}: {
  label?: string;
  children: ReactNode;
  cols?: 3 | 4 | 5 | 6;
  /** One cell per row on phones, for wide specimens. */
  stack?: boolean;
}) {
  return (
    <div className="grid gap-s3">
      {label && <h3 className="font-text text-t13 font-medium tracking-normal text-navy-50">{label}</h3>}
      <div
        className={cn(
          'grid border-t border-l border-navy-800',
          stack ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2',
          cols === 3 && 'md:grid-cols-3',
          cols === 4 && 'md:grid-cols-4',
          cols === 5 && 'md:grid-cols-3 xl:grid-cols-5',
          cols === 6 && 'md:grid-cols-3 xl:grid-cols-6',
        )}
      >
        {children}
      </div>
    </div>
  );
}

function State({ name, children, className }: { name: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-s3 border-r border-b border-navy-800 p-s4 max-sm:p-s3', className)}>
      <p className="text-t12 text-navy-200">{name}</p>
      <div className="flex min-h-10 min-w-0 items-center">{children}</div>
    </div>
  );
}

const NAVY = [
  ['navy-950', '#030E29', 'bg-navy-950', 'Wells, readouts'],
  ['navy-900', '#05163D', 'bg-navy-900', 'Ground'],
  ['navy-800', '#0A2257', 'bg-navy-800', 'Tracks, hover fill'],
  ['navy-700', '#12306F', 'bg-navy-700', 'Hairlines'],
  ['navy-600', '#1B418C', 'bg-navy-600', 'Control edges'],
  ['navy-400', '#4A6FB5', 'bg-navy-400', 'Marks, not text'],
  ['navy-200', '#A9BCE0', 'bg-navy-200', 'Secondary text'],
  ['navy-50', '#EEF3FB', 'bg-navy-50', 'Text, primary fill'],
] as const;

const RAMP = [
  ['loss-3', '#FF4400', 'bg-loss-3'],
  ['loss-2', '#FF7A3D', 'bg-loss-2'],
  ['loss-1', '#FFB68A', 'bg-loss-1'],
  ['zero', '#9FB3D9', 'bg-zero'],
  ['gain-1', '#DDEFAE', 'bg-gain-1'],
  ['gain-2', '#C7E36C', 'bg-gain-2'],
  ['gain-3', '#9DC93B', 'bg-gain-3'],
] as const;

const SESSIONS: Session[] = ['REGULAR', 'EXTENDED', 'WEEKEND', 'HOLIDAY', 'HALTED'];

const triggerClass =
  'rounded-control text-t13 text-navy-50 underline decoration-navy-400 decoration-dotted underline-offset-4';

export default function SystemPage() {
  return (
    <div className="min-h-dvh overflow-x-clip">
      <header className="border-b border-navy-700">
        <div className="mx-auto flex h-16 max-w-(--page-max) items-center justify-between gap-s4 px-s6 max-sm:px-s4">
          <Link href="/" className="flex items-center gap-2.5 rounded-control font-display text-[22px] font-bold tracking-[-0.01em]">
            <span
              aria-hidden="true"
              className="relative size-3 rounded-full border-2 border-navy-50 after:absolute after:inset-0.5 after:rounded-full after:bg-navy-50"
            />
            Novation
          </Link>
          <p className="text-t13 text-navy-200">Design system. Internal, not indexed.</p>
        </div>
      </header>

      <div className="mx-auto grid max-w-(--page-max) gap-x-s8 px-s6 max-sm:px-s4 lg:grid-cols-[176px_minmax(0,1fr)]">
        <nav aria-label="Primitives" className="hidden lg:block">
          <ul className="sticky top-0 grid gap-1 py-s7 text-t13">
            {SECTIONS.map(([id, name]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded-control py-1 text-navy-200 transition-colors duration-(--duration-fast) ui-hover:text-navy-50"
                >
                  {name}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0">
          {/* ---------- intro ---------- */}
          <div className="grid gap-s5 pt-s8 pb-s8 max-sm:pt-s6 max-sm:pb-s7">
            <h1 className="max-w-[18ch] text-display-2 font-normal text-balance max-md:text-display-3 max-sm:text-[38px] max-sm:leading-[1.05]">
              Every part, in every state.
            </h1>
            <p className="max-w-[62ch] text-t17 text-navy-200">
              The primitives the Novation app is built from, on the Clearing Crown tokens. Hover, focus and active are
              pinned with a data attribute so they sit side by side; everything is also live, so tab through it.
            </p>
            <ul className="mt-s2 grid gap-s3 text-t13 text-navy-200 md:grid-cols-3 md:gap-s5">
              <li className="flex items-start gap-s3">
                <Lamp tone="cyan" className="mt-1.5" />
                <span>
                  <span className="font-medium text-navy-50">Cyan</span> marks focus, the thing you can act on, and the
                  IM datum. Nothing else.
                </span>
              </li>
              <li className="flex items-start gap-s3">
                <Lamp tone="gain-2" className="mt-1.5" />
                <span>
                  <span className="font-medium text-navy-50">USDG lime</span> is for gains and data only, never for
                  buttons or success.
                </span>
              </li>
              <li className="flex items-start gap-s3">
                <Lamp tone="loss-3" className="mt-1.5" />
                <span>
                  <span className="font-medium text-navy-50">The loss ramp</span> marks refusals and breaches, from
                  peach to signal orange.
                </span>
              </li>
            </ul>
          </div>

          {/* ---------- foundations ---------- */}
          <Specimen
            id="foundations"
            name="Foundations"
            file="styles/tokens.css"
            summary="Navy carries every surface and line. Depth is one navy step, never a shadow. The data ramp diverges from a blue-grey zero; the page itself never uses it for decoration."
          >
            <div className="grid gap-s3">
              <h3 className="font-text text-t13 font-medium tracking-normal">Navy</h3>
              <ul className="grid grid-cols-2 gap-px border border-navy-800 bg-navy-800 sm:grid-cols-4 xl:grid-cols-8">
                {NAVY.map(([name, hex, cls, use]) => (
                  <li key={name} className="grid gap-s2 bg-navy-900 p-s3">
                    <span aria-hidden="true" className={cn('h-12 rounded-control border border-navy-700', cls)} />
                    <span className="text-t12 font-medium">{name}</span>
                    <span className="text-t12 text-navy-200">
                      {hex}
                      <br />
                      {use}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid gap-s5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div className="grid content-start gap-s3">
                <h3 className="font-text text-t13 font-medium tracking-normal">Cyan</h3>
                <div className="grid grid-cols-[48px_1fr] items-center gap-s3">
                  <span aria-hidden="true" className="h-12 rounded-control bg-cyan" />
                  <span className="text-t12 text-navy-200">
                    <span className="font-medium text-navy-50">cyan</span> #10E1FF
                    <br />
                    Focus ring, selected lamp, IM datum
                  </span>
                </div>
              </div>
              <div className="grid content-start gap-s3">
                <h3 className="font-text text-t13 font-medium tracking-normal">Data ramp</h3>
                <ul className="grid grid-cols-7 gap-0.5">
                  {RAMP.map(([name, hex, cls]) => (
                    <li key={name} className="grid min-w-0 gap-s2">
                      <span aria-hidden="true" className={cn('h-12', cls)} />
                      <span className="truncate text-t12 font-medium">{name}</span>
                      <span className="truncate text-t12 text-navy-200 max-sm:hidden">{hex}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="grid gap-s5 border-t border-navy-800 pt-s5 lg:grid-cols-2">
              <div className="grid content-start gap-s4">
                <h3 className="font-text text-t13 font-medium tracking-normal">Zodiak, display only</h3>
                <p className="font-display text-display-3 tracking-[-0.02em] max-sm:text-[34px] max-sm:leading-[1.06]">
                  The other side of every trade.
                </p>
                <p className="font-display text-display-4 tracking-[-0.02em] max-sm:text-[26px]">Refused before it exists.</p>
                <p className="text-t12 text-navy-200">48 / 1.04 and 36 / 1.08, tracking −0.02em. Headings, dialog titles, refusal reasons.</p>
              </div>
              <div className="grid content-start gap-s4">
                <h3 className="font-text text-t13 font-medium tracking-normal">Switzer, text and numbers</h3>
                <dl className="grid grid-cols-[48px_1fr_auto] items-baseline gap-x-s4 gap-y-s2">
                  {(
                    [
                      ['t20', 'text-t20', 'Equity', acct.equity],
                      ['t17', 'text-t17', 'Worst case', budgetRefusal!.numbers!.worstLoss!],
                      ['t15', 'text-t15', 'Budget', budgetRefusal!.numbers!.budget!],
                      ['t13', 'text-t13', 'Premium', ticket.premium],
                      ['t12', 'text-t12', 'Fee', ticket.quote.fee],
                    ] as const
                  ).map(([k, cls, label, n]) => (
                    <div key={k} className="contents">
                      <dt className="text-t12 text-navy-200">{k}</dt>
                      <dd className={cls}>{label}</dd>
                      <dd className={cn(cls, 'text-right font-medium tabular-nums')}>{fmtNumber(n)}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-t12 text-navy-200">Tabular figures everywhere, so columns line up and live values hold still.</p>
              </div>
            </div>
          </Specimen>

          {/* ---------- button ---------- */}
          <Specimen
            id="button"
            name="Button"
            file="components/ui/button.tsx"
            summary="Primary is the one light object on a navy surface: use it once per view. Secondary is a hairline, ghost is text. Loading keeps focus and width and blocks a second submit."
          >
            {(['primary', 'secondary', 'ghost'] as const).map((v) => {
              const label = v === 'primary' ? 'Place trade' : v === 'secondary' ? 'Review ticket' : 'Cancel';
              return (
                <States key={v} label={v[0]!.toUpperCase() + v.slice(1)}>
                  <State name="Default">
                    <Button variant={v}>{label}</Button>
                  </State>
                  <State name="Hover">
                    <Button variant={v} data-force="hover">
                      {label}
                    </Button>
                  </State>
                  <State name="Focus visible">
                    <Button variant={v} data-force="focus">
                      {label}
                    </Button>
                  </State>
                  <State name="Active">
                    <Button variant={v} data-force="active">
                      {label}
                    </Button>
                  </State>
                  <State name="Disabled">
                    <Button variant={v} disabled>
                      {label}
                    </Button>
                  </State>
                  <State name="Loading">
                    <Button variant={v} loading loadingLabel={v === 'primary' ? 'Placing' : undefined}>
                      {label}
                    </Button>
                  </State>
                </States>
              );
            })}
            <States label="Sizes and the lamp" cols={3}>
              <State name="Small, 32">
                <Button size="sm">Resize to fit</Button>
              </State>
              <State name="Medium, 40">
                <Button variant="primary" lamp>
                  Connect wallet
                </Button>
              </State>
              <State name="Large, 52: the landing CTA">
                <Button variant="primary" size="lg" lamp>
                  Open the app
                </Button>
              </State>
            </States>
          </Specimen>

          {/* ---------- segmented ---------- */}
          <Specimen
            id="segmented"
            name="Segmented control"
            file="components/ui/segmented-control.tsx"
            source="fixtures/account7.json"
            summary="The session switch from the Crown dock. Native radios underneath: Tab lands on the chosen segment, arrows move and select. The chosen segment lights its lamp cyan."
          >
            <States cols={4} stack>
              <State name="Default">
                <SegmentedControl legend="Session, default" defaultValue="REGULAR">
                  <Segment value="REGULAR">Regular</Segment>
                  <Segment value="WEEKEND">Weekend</Segment>
                </SegmentedControl>
              </State>
              <State name="Hover on Weekend">
                <SegmentedControl legend="Session, hover" defaultValue="REGULAR">
                  <Segment value="REGULAR">Regular</Segment>
                  <Segment value="WEEKEND" data-force="hover">
                    Weekend
                  </Segment>
                </SegmentedControl>
              </State>
              <State name="Focus visible">
                <SegmentedControl legend="Session, focus" defaultValue="WEEKEND">
                  <Segment value="REGULAR">Regular</Segment>
                  <Segment value="WEEKEND" data-force="focus">
                    Weekend
                  </Segment>
                </SegmentedControl>
              </State>
              <State name="One option disabled">
                <SegmentedControl legend="Session, holiday unavailable" defaultValue="REGULAR">
                  <Segment value="REGULAR">Regular</Segment>
                  <Segment value="HOLIDAY" disabled>
                    Holiday
                  </Segment>
                </SegmentedControl>
              </State>
              <State name="Disabled">
                <SegmentedControl legend="Session, disabled" defaultValue="REGULAR" disabled>
                  <Segment value="REGULAR">Regular</Segment>
                  <Segment value="WEEKEND">Weekend</Segment>
                </SegmentedControl>
              </State>
              <State name="Small">
                <SegmentedControl legend="Vol shock, small" defaultValue="1.0" size="sm">
                  <Segment value="0.7">×0.7</Segment>
                  <Segment value="1.0">×1.0</Segment>
                  <Segment value="1.4">×1.4</Segment>
                </SegmentedControl>
              </State>
              <State name="Live" className="sm:col-span-2">
                <LiveSessionSwitch />
              </State>
            </States>
          </Specimen>

          {/* ---------- tabs ---------- */}
          <Specimen
            id="tabs"
            name="Tabs"
            file="components/ui/tabs.tsx"
            summary="For switching views of one thing. One tab stop; arrows, Home and End move between tabs and skip disabled ones. The selected tab carries a 2px rule on the hairline."
          >
            <States cols={3} stack>
              <State name="Hover on History">
                <Tabs defaultValue="positions">
                  <TabList aria-label="Portfolio, hover">
                    <Tab value="positions" count={4}>
                      Positions
                    </Tab>
                    <Tab value="history" data-force="hover">
                      History
                    </Tab>
                  </TabList>
                </Tabs>
              </State>
              <State name="Focus visible">
                <Tabs defaultValue="positions">
                  <TabList aria-label="Portfolio, focus">
                    <Tab value="positions" count={4} data-force="focus">
                      Positions
                    </Tab>
                    <Tab value="history">History</Tab>
                  </TabList>
                </Tabs>
              </State>
              <State name="Disabled tab">
                <Tabs defaultValue="positions">
                  <TabList aria-label="Portfolio, disabled tab">
                    <Tab value="positions" count={4}>
                      Positions
                    </Tab>
                    <Tab value="agents" disabled>
                      Agents
                    </Tab>
                  </TabList>
                </Tabs>
              </State>
            </States>
            <Panel title="Live" level={3} padding="md">
              <Tabs defaultValue="positions">
                <TabList aria-label="Account 7">
                  <Tab value="positions" count={account7.account.positions.length}>
                    Positions
                  </Tab>
                  <Tab value="margin">Margin</Tab>
                  <Tab value="agents" count={agents['7'].length}>
                    Agents
                  </Tab>
                </TabList>
                <TabPanel value="positions" className="text-t15 text-navy-200">
                  Four open series across NVDA, TSLA and SPY, marked at the last kernel run.
                </TabPanel>
                <TabPanel value="margin" className="text-t15 text-navy-200">
                  Initial margin {fmtNumber(acct.im)} USDG against equity of {fmtNumber(acct.equity)} USDG.
                </TabPanel>
                <TabPanel value="agents" className="text-t15 text-navy-200">
                  {hedgeBot.label} has used {fmtNumber(hedgeBot.used)} of a {fmtNumber(hedgeBot.maxWorstLoss)} USDG
                  worst-loss budget.
                </TabPanel>
              </Tabs>
            </Panel>
          </Specimen>

          {/* ---------- number field ---------- */}
          <Specimen
            id="number-field"
            name="Number field"
            file="components/ui/number-field.tsx"
            summary="Numbers right-aligned and tabular, the unit inside the field. Arrow keys step (Shift for ten steps). Errors say what is wrong and what fits, next to the field."
          >
            <States cols={4} stack>
              <State name="Empty">
                <NumberField label="Size" unit="contracts" placeholder="0" className="w-full" />
              </State>
              <State name="Filled">
                <NumberField label="Size" unit="contracts" defaultValue="60" step={1} min={1} className="w-full" />
              </State>
              <State name="Hover">
                <NumberField label="Size" unit="contracts" defaultValue="60" data-force="hover" className="w-full" />
              </State>
              <State name="Focus visible">
                <NumberField label="Size" unit="contracts" defaultValue="60" data-force="focus" className="w-full" />
              </State>
              <State name="Error">
                <NumberField
                  label="Size"
                  unit="contracts"
                  defaultValue="60"
                  error={`Over hedge-bot's ${fmtNumber(hedgeBot.maxWorstLoss)} USDG budget.`}
                  className="w-full"
                />
              </State>
              <State name="Hint">
                <NumberField
                  label="Limit premium"
                  unit="USDG"
                  defaultValue="25.77"
                  step={0.01}
                  hint="Per contract. Mark is 25.77."
                  className="w-full"
                />
              </State>
              <State name="Quoting">
                <NumberField label="Premium" unit="USDG" defaultValue={fmtNumber(ticket.premium)} busy readOnly className="w-full" />
              </State>
              <State name="Disabled">
                <NumberField label="Size" unit="contracts" defaultValue="60" disabled className="w-full" />
              </State>
            </States>
          </Specimen>

          {/* ---------- stat ---------- */}
          <Specimen
            id="stat"
            name="Stat"
            file="components/ui/stat.tsx"
            source="fixtures/account7.json, whatifs.json, protocol.json"
            summary="A labelled figure with an optional change. The change is coloured by whether it is good news, not by its sign: margin going up is a loss-tone change."
          >
            <div className="grid gap-s6 border-y border-navy-800 py-s5 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
              <Stat
                size="lg"
                label="Equity, account 7"
                value={fmtNumber(acct.equity)}
                unit="USDG"
                delta={{ value: after.equity - acct.equity, text: fmtSigned(after.equity - acct.equity), label: 'if the ticket clears' }}
              />
              <Stat
                label="Initial margin"
                value={fmtNumber(acct.im)}
                unit="USDG"
                delta={{ value: after.im - acct.im, text: fmtSigned(after.im - acct.im), label: 'if the ticket clears', good: 'down' }}
              />
              <Stat
                label="Cash"
                value={fmtNumber(acct.cash)}
                unit="USDG"
                delta={{ value: after.cash - acct.cash, text: fmtSigned(after.cash - acct.cash), label: 'premium in' }}
              />
              <Stat
                label="Deficit"
                value={fmtNumber(acct.deficit)}
                unit="USDG"
                delta={{ value: after.deficit - acct.deficit, text: fmtNumber(after.deficit - acct.deficit), label: 'if the ticket clears' }}
              />
            </div>
            <div className="grid grid-cols-2 gap-s6 md:grid-cols-4">
              <Stat size="sm" label="Open interest" value={fmtUsd(protocol.openInterestUsd, 0)} footnote="All underlyings" />
              <Stat size="sm" label="Insurance fund" value={fmtUsd(protocol.insuranceFundUsd, 0)} />
              <Stat size="sm" label="TSLA put-write, 7-day APY" value={null} footnote="No vault listed yet" />
              <Stat size="sm" label="Liquidations, 7 days" value="0" loading />
            </div>
          </Specimen>

          {/* ---------- chip ---------- */}
          <Specimen
            id="chip"
            name="Chip"
            file="components/ui/chip.tsx"
            summary="Session state as a lamp and a word. Open sessions are lit; a holiday is an unlit ring; a halt takes the hottest loss step and a faint edge. The word always carries the meaning, the lamp only confirms it."
          >
            <States cols={5}>
              {SESSIONS.map((s) => (
                <State key={s} name={s[0] + s.slice(1).toLowerCase()}>
                  <Chip session={s} />
                </State>
              ))}
            </States>
            <States label="Small, and free text" cols={4}>
              <State name="Small session">
                <Chip session="WEEKEND" size="sm" />
              </State>
              <State name="Neutral">
                <Chip lamp="navy-200">Stylus kernel</Chip>
              </State>
              <State name="Data">
                <Chip lamp="gain-2">Vault live</Chip>
              </State>
              <State name="No lamp">
                <Chip>Epoch 14</Chip>
              </State>
            </States>
          </Specimen>

          {/* ---------- tooltip ---------- */}
          <Specimen
            id="tooltip"
            name="Tooltip"
            file="components/ui/tooltip.tsx"
            source="fixtures/account7.json"
            summary="A hairline callout on a leader line, the way a drawing labels a part. Opens on hover after 300 ms and on focus at once, stays while you read it, and Escape closes it."
          >
            <States cols={3} stack>
              <State name="Pinned, top">
                <div className="flex w-full justify-center pt-[64px] pb-s2">
                  <Tooltip
                    open
                    content={
                      <>
                        Worst of 39: price −R, vol ×1.4{' '}
                        <b className="font-semibold whitespace-nowrap tabular-nums text-navy-50">{fmtNumber(worst.pnl)} USDG</b>
                      </>
                    }
                  >
                    <button type="button" className={triggerClass}>
                      Scenario {worst.index}
                    </button>
                  </Tooltip>
                </div>
              </State>
              <State name="Pinned, bottom start">
                <div className="pb-[92px]">
                  <Tooltip
                    open
                    side="bottom"
                    align="start"
                    content="Initial margin: the worst loss across 39 stress scenarios, widened for the current session."
                  >
                    <button type="button" className={triggerClass}>
                      IM
                    </button>
                  </Tooltip>
                </div>
              </State>
              <State name="Live: hover or focus">
                <Tooltip content="Equity minus initial margin. New trades draw on this.">
                  <Button variant="secondary" size="sm">
                    Free margin {fmtNumber(acct.equity - acct.im)}
                  </Button>
                </Tooltip>
              </State>
            </States>
          </Specimen>

          {/* ---------- panel ---------- */}
          <Specimen
            id="panel"
            name="Panel"
            file="components/ui/panel.tsx"
            summary="A 1px navy-700 hairline at radius 4. No shadow: depth comes from one navy step. Inset sinks a readout into a well; raised lifts a group one step."
          >
            <div className="grid gap-s5 md:grid-cols-2 xl:grid-cols-4">
              <Panel title="Margin" meta={<Chip session="REGULAR" size="sm" />} footer="Kernel reference, account 7">
                <Stat label="Initial margin" value={fmtNumber(acct.im)} unit="USDG" />
              </Panel>
              <Panel title="Worst case" tone="inset" meta="39 scenarios">
                <Stat label={`Scenario ${worst.index}`} value={fmtNumber(worst.pnl)} unit="USDG" />
              </Panel>
              <Panel title={hedgeBot.label} tone="raised" meta="Agent">
                <Stat
                  label="Worst-loss budget used"
                  value={fmtNumber(hedgeBot.used)}
                  unit="USDG"
                  footnote={`of ${fmtNumber(hedgeBot.maxWorstLoss)} USDG`}
                />
              </Panel>
              <Panel>
                <p className="text-t15 text-navy-200">No header, just the hairline and the padding.</p>
              </Panel>
            </div>
          </Specimen>

          {/* ---------- data table ---------- */}
          <Specimen
            id="data-table"
            name="Data table"
            file="components/ui/data-table.tsx"
            source="fixtures/account7.json, chains.json"
            summary="36px rows, tabular numbers aligned right with their headers, a head that stays put while the body scrolls. Rows that open something take focus: arrows move, Enter opens. The open row carries a cyan edge."
          >
            <div className="grid gap-s5 xl:grid-cols-2">
              <div className="grid content-start gap-s3">
                <h3 className="font-text text-t13 font-medium tracking-normal">Row states: current, hover, focus visible</h3>
                <PositionsTable current="5" forceRow={{ key: '126', state: 'hover' }} caption="Open positions, pinned states" />
                <PositionsTable forceRow={{ key: '2', state: 'focus' }} caption="Open positions, focus pinned" />
              </div>
              <ChainTable />
            </div>
            <TableStates />
          </Specimen>

          {/* ---------- meter ---------- */}
          <Specimen
            id="meter"
            name="Meter"
            file="components/ui/meter.tsx"
            source="fixtures/account7.json, whatifs.json, refusals.json"
            summary="Equity on a hairline scale with two datums: IM in cyan, MM in peach. The scale under MM is hatched so the liquidation zone reads without colour. The fill and the status line change with the zone the value sits in."
          >
            <div className="grid gap-x-s7 gap-y-s6 md:grid-cols-2">
              <Meter label="Account 7, regular session" value={acct.equity} im={acct.im} mm={acct.mm} />
              <Meter label="Account 7, weekend session" value={acct.equity} im={imWeekend} mm={imWeekend * MM_RATIO} />
              <Meter
                label="Account 7 if the ticket clears"
                value={after.equity}
                im={after.im}
                mm={after.mm}
                max={12000}
              />
              <Meter
                label="Account 12, refused ticket"
                value={marginRefusal!.numbers!.equity!}
                im={marginRefusal!.numbers!.im!}
                mm={marginRefusal!.numbers!.im! * MM_RATIO}
              />
              <Meter
                label="Illustrative: account 12 after a further 680.00 loss"
                value={marginRefusal!.numbers!.equity! - 680}
                im={marginRefusal!.numbers!.im!}
                mm={marginRefusal!.numbers!.im! * MM_RATIO}
              />
              <Meter label="Loading" value={0} im={0} mm={0} loading />
            </div>
          </Specimen>

          {/* ---------- refusal card ---------- */}
          <Specimen
            id="refusal"
            name="Refusal card"
            file="components/ui/refusal-card.tsx"
            source="fixtures/refusals.json, whatifs.json"
            summary="What the kernel says when it refuses: the rule, in plain words, the two numbers that crossed, by how much, and what would have cleared. The thread runs to the limit in navy and keeps going in orange."
          >
            <div className="grid items-start gap-s5 lg:grid-cols-2">
              <RefusalCard
                code={budgetRefusal!.code}
                reason="This trade's worst case is bigger than hedge-bot's risk budget."
                context="Account 7, agent hedge-bot. Refused before it reached the book."
                breach={{
                  attempted: { label: 'Worst-case loss', value: budgetRefusal!.numbers!.worstLoss! },
                  limit: { label: 'Budget', value: budgetRefusal!.numbers!.budget! },
                }}
                hint={`Keep the trade's worst case at or under ${fmtNumber(budgetRefusal!.numbers!.budget!)} USDG, or ask the owner to raise the budget.`}
                proof={{ href: `https://sepolia.arbiscan.io/tx/${budgetRefusal!.txHash}`, label: 'View transaction' }}
              />
              <RefusalCard
                code={marginRefusal!.code}
                reason="Initial margin after this trade is more than the account's equity."
                context="Account 12. The kernel priced the book across 39 scenarios after the trade."
                breach={{
                  attempted: { label: 'Margin required', value: marginRefusal!.numbers!.im! },
                  limit: { label: 'Equity', value: marginRefusal!.numbers!.equity! },
                  gapLabel: 'Short by',
                }}
                hint={`Deposit ${fmtNumber(marginRefusal!.numbers!.im! - marginRefusal!.numbers!.equity!)} USDG, or cut the size until margin fits inside equity.`}
                action={
                  <Button size="sm" data-force="focus">
                    Deposit USDG
                  </Button>
                }
              />
              {ticketRefusal && (
                <RefusalCard
                  code={ticketRefusal.code}
                  reason="The ticket's worst case is bigger than hedge-bot's risk budget."
                  context="Account 7, hedge-bot, selling 60 NVDA 200 calls."
                  breach={{
                    attempted: { label: 'Worst-case loss', value: ticketRefusal.numbers.worstLoss },
                    limit: { label: 'Budget', value: ticketRefusal.numbers.budget },
                  }}
                  hint={`Shrink the ticket until its worst case is at or under ${fmtNumber(ticketRefusal.numbers.budget)} USDG, or trade from the owner wallet.`}
                  action={<Button size="sm">Edit ticket</Button>}
                />
              )}
              <RefusalCard
                code={haltRefusal!.code}
                reason="Opening trades are closed while the session is halted."
                context={
                  <span className="inline-flex flex-wrap items-center gap-s2">
                    Account 1 <Chip session="HALTED" size="sm" />
                  </span>
                }
                hint="Closing trades still clear. Opening resumes when the session reopens."
              />
            </div>
          </Specimen>

          {/* ---------- toast ---------- */}
          <Specimen
            id="toast"
            name="Toast"
            file="components/ui/toast.tsx"
            summary="Short news about something you did. A polite live list; refusals are announced at once. The done mark is a drawn check, not lime: lime stays with gains."
          >
            <ToastDemo />
          </Specimen>

          {/* ---------- dialog ---------- */}
          <Specimen
            id="dialog"
            name="Dialog"
            file="components/ui/dialog.tsx"
            source="fixtures/agents.json"
            summary="For a decision that needs an answer before anything else happens. The title asks the question; the buttons repeat its verb."
          >
            <div className="grid gap-s6 lg:grid-cols-[minmax(0,560px)_1fr]">
              <DialogPreview />
              <DialogDemo />
            </div>
          </Specimen>

          {/* ---------- skeleton ---------- */}
          <Specimen
            id="skeleton"
            name="Skeleton"
            file="components/ui/skeleton.tsx"
            summary="Placeholders in the shape of what is coming, with a slow sweep that stops under reduced motion. The loading container carries aria-busy and says what is loading."
          >
            <States cols={4}>
              <State name="Bar and circle">
                <span className="flex items-center gap-s3" aria-hidden="true">
                  <Skeleton shape="circle" className="size-3" />
                  <Skeleton className="h-3 w-28" />
                </span>
              </State>
              <State name="Text">
                <SkeletonText lines={3} className="w-full" />
              </State>
              <State name="Stat">
                <Stat label="Equity" value="0" loading />
              </State>
              <State name="Chip">
                <Skeleton className="h-7 w-24 rounded-control" />
              </State>
            </States>
          </Specimen>

          <footer className="border-t border-navy-700 py-s6 text-t13 text-navy-200">
            Stock tokens are not available to US persons.
          </footer>
        </main>
      </div>
    </div>
  );
}
