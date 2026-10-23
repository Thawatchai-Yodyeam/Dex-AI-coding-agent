import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RETRIES, TransientApiError, httpError, isRetryableError, retryDelayMs, withRetry } from './retry';
import { AgentAbortError } from './types';

describe('isRetryableError', () => {
  it('retries transient API and network failures only', () => {
    expect(isRetryableError(new TransientApiError('overloaded', 529))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('gemini'), { status: 503 }))).toBe(true);
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false);
    expect(isRetryableError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isRetryableError(new AgentAbortError())).toBe(false);
    expect(isRetryableError(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

describe('httpError', () => {
  it('marks retryable statuses and keeps retry-after', async () => {
    const err = await httpError('API', new Response('busy', { status: 429, headers: { 'retry-after': '7' } }));
    expect(err).toBeInstanceOf(TransientApiError);
    expect((err as TransientApiError).retryAfter).toBe('7');
    expect(err.message).toBe('API [429]: busy');
    expect(await httpError('API', new Response('nope', { status: 401 }))).not.toBeInstanceOf(TransientApiError);
  });
});

describe('retryDelayMs', () => {
  it('honours retry-after seconds with a cap', () => {
    expect(retryDelayMs(0, '3')).toBe(3000);
    expect(retryDelayMs(0, '9999')).toBe(60_000);
  });

  it('backs off exponentially with jitter', () => {
    expect(retryDelayMs(0, null, () => 0.5)).toBe(1000);
    expect(retryDelayMs(2, null, () => 0.5)).toBe(4000);
    expect(retryDelayMs(10, null, () => 0.5)).toBe(20_000);
    expect(retryDelayMs(0, null, () => 0)).toBe(750);
  });
});

describe('withRetry', () => {
  afterEach(() => vi.useRealTimers());

  it('retries transient failures then succeeds, reporting each retry', async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TransientApiError('busy', 529, '1');
        return 'ok';
      },
      { onRetry }
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await promise).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, maxAttempts: MAX_RETRIES, delayMs: 1000 });
  });

  it('does not retry permanent errors', async () => {
    const run = vi.fn(async () => {
      throw new Error('400 bad');
    });
    await expect(withRetry(run)).rejects.toThrow('400 bad');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_RETRIES and stops waiting when aborted', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new TransientApiError('busy', 503, '0');
    });
    const failing = withRetry(run);
    const settled = expect(failing).rejects.toThrow('busy');
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    expect(run).toHaveBeenCalledTimes(MAX_RETRIES + 1);

    const controller = new AbortController();
    const waiting = withRetry(
      async () => {
        throw new TransientApiError('busy', 503, '30');
      },
      { signal: controller.signal }
    );
    const aborted = expect(waiting).rejects.toBeInstanceOf(AgentAbortError);
    controller.abort();
    await aborted;
  });
});
