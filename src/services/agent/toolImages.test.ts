import { describe, expect, it } from 'vitest';
import { TOOL_IMAGES_NOTE, dropOldToolImages, estimateHistoryChars, isUserTextTurn, toNeutral, trimToolResults } from './history';
import { anthropicToolResult } from './providers/anthropic';
import { googleFunctionResponse } from './providers/google';
import { openaiToolMessages } from './providers/openai';
import { TOOL_IMAGES_KEY, takeToolImages } from './types';

const shot = (data = 'SHOT') => ({ [TOOL_IMAGES_KEY]: [{ mediaType: 'image/jpeg', data }], note: 'Screenshot', url: 'http://localhost/' });

describe('takeToolImages', () => {
  it('splits images from the rest of the result', () => {
    expect(takeToolImages(shot())).toEqual({
      result: { note: 'Screenshot', url: 'http://localhost/' },
      images: [{ mediaType: 'image/jpeg', data: 'SHOT' }],
    });
    expect(takeToolImages('plain')).toEqual({ result: 'plain', images: [] });
  });
});

describe('provider tool results with images', () => {
  it('Claude puts the image inside tool_result', () => {
    const block = anthropicToolResult('tu1', shot());
    expect(block.content[0]).toEqual({ type: 'text', text: JSON.stringify({ note: 'Screenshot', url: 'http://localhost/' }) });
    expect(block.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'SHOT' } });
    expect(anthropicToolResult('tu2', { error: 'nope' })).toMatchObject({ content: '{"error":"nope"}', is_error: true });
  });

  it('OpenAI sends images in a follow-up user message', () => {
    const messages = openaiToolMessages(['c1', 'c2'], [{ content: 'text' }, shot()]);
    expect(messages.map((m) => m.role)).toEqual(['tool', 'tool', 'user']);
    expect(messages[1].content).not.toContain('SHOT');
    expect(messages[2].content).toEqual([
      { type: 'text', text: TOOL_IMAGES_NOTE },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,SHOT' } },
    ]);
    expect(openaiToolMessages(['c1'], [{ content: 'text' }])).toHaveLength(1);
  });

  it('Gemini attaches images as function response parts', () => {
    expect(googleFunctionResponse('browser', shot())).toEqual({
      functionResponse: {
        name: 'browser',
        response: { note: 'Screenshot', url: 'http://localhost/' },
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'SHOT' } }],
      },
    });
  });
});

describe('tool image messages in OpenAI history', () => {
  const history = [
    { role: 'user', content: 'test the page' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'browser', arguments: '{}' } }] },
    ...openaiToolMessages(['c1'], [shot()]),
    { role: 'assistant', content: 'Looks fine' },
  ];

  it('is not a turn the user typed', () => {
    expect(history.filter((m) => isUserTextTurn(m, 'openai'))).toHaveLength(1);
    expect(toNeutral(history, 'openai')).toEqual([
      { role: 'user', text: 'test the page' },
      { role: 'assistant', text: 'Looks fine' },
    ]);
  });
});

describe('dropOldToolImages', () => {
  it('keeps only the newest screenshots in Claude history', () => {
    const history = [1, 2, 3, 4].map((n) => ({ role: 'user', content: [anthropicToolResult(`t${n}`, shot(`S${n}`))] }));
    expect(dropOldToolImages(history, 'anthropic', 2)).toBe(2);
    const kinds = history.map((m) => m.content[0].content[1].type);
    expect(kinds).toEqual(['text', 'text', 'image', 'image']);
    expect(dropOldToolImages(history, 'anthropic', 2)).toBe(0);
  });

  it('works for OpenAI and Gemini', () => {
    const openai = [1, 2].flatMap((n) => openaiToolMessages([`c${n}`], [shot(`S${n}`)]));
    expect(dropOldToolImages(openai, 'openai', 1)).toBe(1);
    expect(openai[1].content[1].type).toBe('text');
    expect(openai[3].content[1].type).toBe('image_url');

    const google = [1, 2].map((n) => ({ role: 'user', parts: [googleFunctionResponse('browser', shot(`S${n}`))] }));
    expect(dropOldToolImages(google, 'google', 1)).toBe(1);
    expect(google[0].parts[0].functionResponse.parts).toBeUndefined();
    expect(google[1].parts[0].functionResponse.parts).toHaveLength(1);
  });
});

describe('history size with screenshots', () => {
  it('counts an image at a fixed size and trims results that hold images correctly', () => {
    const big = 'x'.repeat(200_000);
    const history = [{ role: 'user', content: [anthropicToolResult('t1', shot(big))] }];
    expect(estimateHistoryChars(history)).toBeLessThan(10_000);
    // ไม่เกินงบ → ไม่ล้างทั้งที่ base64 ยาวมาก
    expect(trimToolResults(history, 'anthropic', 50_000)).toBe(0);
  });
});
