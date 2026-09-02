import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkForUpdate = vi.fn();
vi.mock('./check', () => ({ checkForUpdate }));

const { startUpdateChecks, UPDATE_CHECK_INTERVAL_MS, FIRST_UPDATE_CHECK_DELAY_MS } =
  await import('./schedule');

const offer = (version: string) => ({
  kind: 'portable' as const,
  version,
  notes: '',
  apply: vi.fn(),
});

/** Lets the promise chain inside a tick settle before time moves again. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  checkForUpdate.mockReset();
  checkForUpdate.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startUpdateChecks', () => {
  it('asks for nothing until the first delay has passed', async () => {
    startUpdateChecks(vi.fn());

    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS - 1);
    expect(checkForUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });

  it('keeps checking every hour while the app is open', async () => {
    startUpdateChecks(vi.fn());

    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(checkForUpdate).toHaveBeenCalledTimes(5);
  });

  it('reports what it finds', async () => {
    const onFound = vi.fn();
    checkForUpdate.mockResolvedValue(offer('0.1.11'));

    startUpdateChecks(onFound, { firstDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(10);

    expect(onFound).toHaveBeenCalledWith(expect.objectContaining({ version: '0.1.11' }));
  });

  it('says nothing when there is nothing to say', async () => {
    const onFound = vi.fn();

    startUpdateChecks(onFound, { firstDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(checkForUpdate).toHaveBeenCalled();
    expect(onFound).not.toHaveBeenCalled();
  });

  it('reports the same version again on the next tick, leaving the decision to the caller', async () => {
    const onFound = vi.fn();
    checkForUpdate.mockResolvedValue(offer('0.1.11'));

    startUpdateChecks(onFound, { firstDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);

    expect(onFound).toHaveBeenCalledTimes(2);
  });

  it('waits out the whole gap between checks rather than catching up', async () => {
    // A check that takes longer than the interval must not be followed
    // immediately by the next one.
    let release = (): void => {};
    checkForUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );

    startUpdateChecks(vi.fn(), { firstDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    // Well past several intervals, but the first check has not come back.
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    release();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps the schedule alive after a check that throws', async () => {
    checkForUpdate.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(null);

    startUpdateChecks(vi.fn(), { firstDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);

    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('stops checking once stopped', async () => {
    const handle = startUpdateChecks(vi.fn(), { firstDelayMs: 10, intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(10);
    handle.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not report a check that lands after it was stopped', async () => {
    const onFound = vi.fn();
    let release = (): void => {};
    checkForUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(offer('0.1.11'));
        }),
    );

    const handle = startUpdateChecks(onFound, { firstDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    handle.stop();
    release();
    await settle();

    expect(onFound).not.toHaveBeenCalled();
  });

  it('never waits longer than the interval for the first check', async () => {
    startUpdateChecks(vi.fn(), { firstDelayMs: 10_000, intervalMs: 50 });

    await vi.advanceTimersByTimeAsync(50);

    expect(checkForUpdate).toHaveBeenCalled();
  });
});
