import { cn } from '@/lib/cn';
import { Ref, SectionHead, TEXT_LINK, WRAP } from './parts';
import { CHECK_LINKS, CONTRACTS, testnetAddress } from './site';

interface Check {
  name: string;
  body: string;
  links: { label: string; href: string }[];
  source?: 'kernel' | 'bench';
}

const CHECKS: Check[] = [
  {
    name: 'Immutable core',
    body: 'The clearinghouse and the kernel cannot be upgraded, and the list of venues is fixed once setup ends. There is no proxy and no admin path to positions or cash; a guardian can only pause new openings.',
    links: [{ label: 'Read the contracts', href: CHECK_LINKS.immutableCore }],
  },
  {
    name: 'Bounded parameters behind a timelock',
    body: 'Risk parameters change only through a timelock, and only inside minimums and maximums written into the contracts.',
    links: [{ label: 'Read the parameter bounds', href: CHECK_LINKS.timelock }],
  },
  {
    name: 'Solvency invariants under test',
    body: 'Unit, fuzz and mutation tests check after every settlement step that the clearinghouse holds every cash balance and every expiry pool. A stateful invariant suite is in progress.',
    links: [{ label: 'Read the tests', href: CHECK_LINKS.invariants }],
  },
  {
    name: 'Bit-exact kernel parity',
    body: 'The Stylus kernel, its Solidity twin and the Python reference compute the same integers. On testnet the deployed kernel and the Solidity reference return byte-identical margin results.',
    links: [
      { label: 'Read the parity tests', href: CHECK_LINKS.parity },
      { label: 'Kernel on testnet', href: testnetAddress(CONTRACTS.kernel) },
    ],
    source: 'kernel',
  },
  {
    name: 'Self-review report',
    body: 'A security self-review with its threat model, and a claims file that marks each claim as reproducible, verified live, modeled or not claimed.',
    links: [{ label: 'Read the report', href: CHECK_LINKS.selfReview }],
  },
];

export function Checked() {
  return (
    <section aria-labelledby="checks">
      <SectionHead id="checks" title="Built to be checked" />
      <ul className={cn(WRAP, 'mt-s8 grid md:mt-s9 md:grid-cols-6')}>
        {CHECKS.map((c) => {
          const links = c.links.filter((l) => l.href);
          return (
            <li key={c.name} className="reveal border-t border-navy-50/10 py-s5 md:col-span-4 md:grid md:grid-cols-4 md:py-s6">
              <p className="text-t17 font-semibold text-navy-50 md:col-span-2 md:pr-s7">
                {c.name}
                {c.source ? <Ref id={c.source} /> : null}
              </p>
              <div className="mt-s2 md:col-span-2 md:mt-0">
                <p className="max-w-[52ch] text-t15 text-navy-200">{c.body}</p>
                {links.length ? (
                  <p className="mt-s3 flex flex-wrap gap-x-s5 gap-y-s2 text-t13 font-medium">
                    {links.map((l) => (
                      <a key={l.label} href={l.href} className={TEXT_LINK}>
                        {l.label}
                      </a>
                    ))}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
