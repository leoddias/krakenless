import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState, Store } from './store';
import { createStore } from './store';

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({
  store,
  children,
}: {
  store: Store;
  children: ReactNode;
}): ReactNode {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error('useStore must be used inside a StoreProvider');
  }
  return store;
}

/** Subscribes to a slice of state; re-renders only when that slice changes. */
export function useAppState<T>(select: (state: AppState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState()),
  );
}

/** Convenience for tests and for the app entry point. */
export function makeStore(): Store {
  return createStore();
}
