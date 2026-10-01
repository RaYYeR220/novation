import type { Metadata } from 'next';
import account7 from '@/fixtures/account7.json';
import { MockClient } from '@/lib/client/mock';
import { CrownLab, type LabView } from './CrownLab';

export const metadata: Metadata = {
  title: 'Crown lab',
  robots: { index: false, follow: false },
};

type Search = Promise<Record<string, string | string[] | undefined>>;

const VIEWS: readonly LabView[] = ['all', 'hero', 'panel', 'poster'];

/** Dev page: the crown in its hero and panel settings with the account 7 fixtures. `?view=poster` is what scripts/render-poster.ts captures. */
export default async function CrownLabPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const view = VIEWS.find((v) => v === sp.view) ?? 'all';
  const client = new MockClient();
  const [regular, weekend, account] = await Promise.all([
    client.scenarioGrid(7, 'REGULAR'),
    client.scenarioGrid(7, 'WEEKEND'),
    client.account(7),
  ]);
  return (
    <CrownLab
      view={view}
      grids={{ REGULAR: regular, WEEKEND: weekend }}
      ims={{ REGULAR: account7.summary.im_regular, WEEKEND: account7.summary.im_weekend }}
      equity={account.state.equity}
      initialSession={sp.session === 'WEEKEND' ? 'WEEKEND' : 'REGULAR'}
      measure={sp.perf === '1'}
      quality={sp.tier === 'low' ? 'low' : 'auto'}
    />
  );
}
