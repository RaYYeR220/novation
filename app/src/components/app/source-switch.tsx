'use client';

import { Segment, SegmentedControl } from '@/components/ui/segmented-control';
import { useDataSource, type DataSource } from '@/lib/client/source';

/** Demo snapshot or live testnet. Remembered in the URL (?data=live) and in this browser. */
export function SourceSwitch({ className }: { className?: string }) {
  const [source, setSource] = useDataSource();
  return (
    <SegmentedControl legend="Data source" size="sm" value={source} onValueChange={(v) => setSource(v as DataSource)} className={className}>
      <Segment value="demo">Demo snapshot</Segment>
      <Segment value="live">Live testnet</Segment>
    </SegmentedControl>
  );
}
