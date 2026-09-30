import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { axe } from './axe';

const Example = ({ activation }: { activation?: 'automatic' | 'manual' }) => (
  <Tabs defaultValue="positions" activation={activation}>
    <TabList aria-label="Portfolio">
      <Tab value="positions" count={4}>
        Positions
      </Tab>
      <Tab value="history">History</Tab>
      <Tab value="agents" disabled>
        Agents
      </Tab>
      <Tab value="vaults">Vaults</Tab>
    </TabList>
    <TabPanel value="positions">Four open positions</TabPanel>
    <TabPanel value="history">Trade history</TabPanel>
    <TabPanel value="agents">Agent grants</TabPanel>
    <TabPanel value="vaults">Vault shares</TabPanel>
  </Tabs>
);

describe('Tabs', () => {
  it('wires tabs to panels', async () => {
    const { container } = render(<Example />);
    const tab = screen.getByRole('tab', { name: /Positions/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: /Positions/ });
    expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveTextContent('Four open positions');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('roves with arrows, skips disabled tabs, and wraps', async () => {
    render(<Example />);
    await userEvent.tab();
    expect(screen.getByRole('tab', { name: /Positions/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Vaults' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Positions/ })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Vaults' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Vault shares');
  });

  it('waits for Enter in manual mode', async () => {
    render(<Example activation="manual" />);
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'false');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the tab stop on the first enabled tab when nothing is selected', async () => {
    render(
      <Tabs>
        <TabList aria-label="Views">
          <Tab value="agents" disabled>
            Agents
          </Tab>
          <Tab value="positions">Positions</Tab>
          <Tab value="history">History</Tab>
        </TabList>
      </Tabs>,
    );
    const stops = () => screen.getAllByRole('tab').filter((t) => t.tabIndex === 0);
    expect(stops()).toEqual([screen.getByRole('tab', { name: 'Positions' })]);
    await userEvent.tab();
    expect(screen.getByRole('tab', { name: 'Positions' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
    expect(stops()).toEqual([screen.getByRole('tab', { name: 'History' })]);
  });

  it('keeps one tab stop in the list', async () => {
    render(<Example />);
    const stops = screen.getAllByRole('tab').filter((t) => t.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });
});
