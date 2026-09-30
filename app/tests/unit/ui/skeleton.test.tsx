import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { axe } from './axe';

describe('Skeleton', () => {
  it('is hidden from assistive tech inside a busy container', async () => {
    const { container } = render(
      <div aria-busy="true">
        <span className="sr-only">Loading positions</span>
        <Skeleton className="h-3 w-24" />
        <Skeleton shape="circle" className="size-3" />
        <SkeletonText lines={3} />
      </div>,
    );
    const blocks = container.querySelectorAll('[data-skeleton]');
    expect(blocks).toHaveLength(5);
    for (const b of blocks) expect(b.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('.rounded-full')).not.toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
