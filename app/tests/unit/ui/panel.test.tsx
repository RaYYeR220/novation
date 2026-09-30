import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel } from '@/components/ui/panel';
import { axe } from './axe';

describe('Panel', () => {
  it('is a region named by its title', async () => {
    const { container } = render(
      <Panel title="Margin" meta="As of block 1,204" footer="Source: kernel reference">
        <p>Body</p>
      </Panel>,
    );
    expect(screen.getByRole('region', { name: 'Margin' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Margin' })).toBeInTheDocument();
    expect(screen.getByText('Source: kernel reference')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('uses the requested heading level and draws a hairline, not a shadow', () => {
    const { container } = render(
      <Panel title="Positions" level={3} tone="inset">
        x
      </Panel>,
    );
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('border-navy-700');
    expect(el.className).not.toMatch(/shadow/);
  });

  it('renders without a header', () => {
    const { container } = render(<Panel>plain</Panel>);
    expect(container.querySelector('header')).toBeNull();
  });
});
