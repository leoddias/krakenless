import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Vitest runs without globals here, so Testing Library's automatic cleanup
 * never registers itself. Without this every render leaks into the next test in
 * the file, and queries start finding elements from a previous case — which
 * fails in confusing ways or, worse, passes for the wrong reason.
 */
afterEach(() => {
  cleanup();
});
