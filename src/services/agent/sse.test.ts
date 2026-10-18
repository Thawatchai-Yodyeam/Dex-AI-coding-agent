import { describe, expect, it } from 'vitest';
import { readSseData, tryParseJson } from './sse';
import { AgentAbortError } from './types';

function streamResponse(chunks: (string | Uint8Array)[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      controller.close();
    },
  });
  return new Response(body);
}

async function collect(response: Response, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readSseData(response, signal)) out.push(data);
  return out;
}

describe('readSseData', () => {
  it('yields data payloads and ignores comments, events and blank lines', async () => {
    const res = streamResponse([': keep-alive\n', 'event: message\n', 'data: {"a":1}\n\n', 'data:{"b":2}\r\n\r\n']);
    expect(await collect(res)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles lines split across chunks', async () => {
    const res = streamResponse(['da', 'ta: {"te', 'xt":"hel', 'lo"}\n', '\ndata: {"x"', ':2}\n\n']);
    expect(await collect(res)).toEqual(['{"text":"hello"}', '{"x":2}']);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: สวัสดี\n');
    const res = streamResponse([bytes.slice(0, 9), bytes.slice(9)]);
    expect(await collect(res)).toEqual(['สวัสดี']);
  });

  it('flushes a trailing line with no newline at end of stream', async () => {
    const res = streamResponse(['data: {"a":1}\n\n', 'data: {"usage":{"total":5}}']);
    expect(await collect(res)).toEqual(['{"a":1}', '{"usage":{"total":5}}']);
  });

  it('stops at [DONE] and ignores anything after it', async () => {
    const res = streamResponse(['data: one\n\ndata: [DONE]\n\ndata: after\n\n']);
    expect(await collect(res)).toEqual(['one']);
  });

  it('does not yield a trailing [DONE] without newline', async () => {
    const res = streamResponse(['data: one\n\n', 'data: [DONE]']);
    expect(await collect(res)).toEqual(['one']);
  });

  it('throws AgentAbortError when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(collect(streamResponse(['data: x\n']), ctrl.signal)).rejects.toBeInstanceOf(AgentAbortError);
  });

  it('throws when the response has no body', async () => {
    await expect(collect(new Response(null))).rejects.toThrow('no readable stream');
  });
});

describe('tryParseJson', () => {
  it('parses valid JSON and returns null for invalid input', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('not json')).toBeNull();
  });
});
