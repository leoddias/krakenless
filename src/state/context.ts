import { createContext } from 'react';
import type { Store } from './store';

/**
 * Lives in its own module so the provider component and the hooks can each
 * stay in a file that exports only one kind of thing — which is what keeps
 * React Fast Refresh working during development.
 */
export const StoreContext = createContext<Store | null>(null);
