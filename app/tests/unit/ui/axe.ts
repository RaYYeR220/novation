import { configureAxe } from 'vitest-axe';

/** Components render outside page landmarks in tests, so the landmark rule is off. Contrast is checked in the browser, not jsdom. */
export const axe = configureAxe({
  rules: {
    region: { enabled: false },
    'color-contrast': { enabled: false },
  },
});
