import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/schema';
import { createStore } from './store';
import {
  liveStoreCount,
  publishConfig,
  registerStore,
  resetStoreRegistry,
} from './stores';

beforeEach(() => {
  resetStoreRegistry();
});

describe('the store registry', () => {
  it('hands new settings to every open repository', () => {
    // One tab changing a setting must not leave the others on the old one:
    // that reads as the setting not working.
    const first = createStore();
    const second = createStore();
    registerStore(first);
    registerStore(second);

    publishConfig({ ...defaultConfig(), remoteAvatars: true });

    expect(first.getState().config.remoteAvatars).toBe(true);
    expect(second.getState().config.remoteAvatars).toBe(true);
  });

  it('stops writing to a store once it is gone', () => {
    const closed = createStore();
    const unregister = registerStore(closed);
    unregister();

    publishConfig({ ...defaultConfig(), remoteAvatars: true });

    expect(closed.getState().config.remoteAvatars).toBe(false);
    expect(liveStoreCount()).toBe(0);
  });

  it('registers a store only once, however many times it asks', () => {
    const store = createStore();
    registerStore(store);
    registerStore(store);
    expect(liveStoreCount()).toBe(1);
  });

  it('publishing with nothing open is not an error', () => {
    expect(() => {
      publishConfig(defaultConfig());
    }).not.toThrow();
  });
});
