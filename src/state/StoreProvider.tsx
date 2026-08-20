import type { ReactNode } from 'react';
import { StoreContext } from './context';
import type { Store } from './store';

export function StoreProvider({
  store,
  children,
}: {
  store: Store;
  children: ReactNode;
}): ReactNode {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
