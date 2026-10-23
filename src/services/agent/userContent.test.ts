import { describe, expect, it } from 'vitest';
import { toNeutral } from './history';
import { buildSystemPrompt } from './prompt';
import { anthropicUserContent } from './providers/anthropic';
import { googleUserParts } from './providers/google';
import { openaiUserContent } from './providers/openai';
import { stripImageData } from '../../hooks/useChatSessions';
import type { AppSettings, ChatSession } from '../../types/agent';

const img = { id: 'i1', name: 'a.png', mediaType: 'image/png', data: 'QUJD' };

describe('user content with images', () => {
  it('keeps plain strings when there are no images', () => {
    expect(anthropicUserContent({ text: 'hi' })).toBe('hi');
    expect(openaiUserContent({ text: 'hi', images: [] })).toBe('hi');
    expect(googleUserParts({ text: 'hi' })).toEqual([{ text: 'hi' }]);
  });

  it('builds provider-native image blocks', () => {
    expect(anthropicUserContent({ text: 'look', images: [img] })).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: 'look' },
    ]);
    expect(openaiUserContent({ text: 'look', images: [img] })).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
    expect(googleUserParts({ text: 'look', images: [img] })).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
      { text: 'look' },
    ]);
  });

  it('omits empty text blocks for image-only messages', () => {
    expect(anthropicUserContent({ text: '', images: [img] })).toHaveLength(1);
    expect(openaiUserContent({ text: '  ', images: [img] })).toHaveLength(1);
    expect(googleUserParts({ text: '', images: [img] })).toHaveLength(1);
  });

  it('ignores images whose data was not persisted', () => {
    const { data: _d, ...noData } = img;
    expect(anthropicUserContent({ text: 'x', images: [noData] })).toBe('x');
  });

  it('toNeutral keeps only text from OpenAI content parts', () => {
    const history = [{ role: 'user', content: openaiUserContent({ text: 'look', images: [img] }) }];
    expect(toNeutral(history, 'openai')).toEqual([{ role: 'user', text: 'look' }]);
  });
});

describe('stripImageData', () => {
  it('removes base64 data but keeps the attachment metadata', () => {
    const session = {
      id: 's',
      title: 't',
      createdAt: 0,
      updatedAt: 0,
      messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 0, images: [img] }],
    } as ChatSession;
    const [out] = stripImageData([session]);
    expect(out.messages[0].images).toEqual([{ id: 'i1', name: 'a.png', mediaType: 'image/png' }]);
    expect(session.messages[0].images?.[0].data).toBe('QUJD');
  });
});

describe('buildSystemPrompt project instructions', () => {
  const settings = { cwd: 'D:\\proj', language: 'en' } as AppSettings;

  it('includes the project file when present', () => {
    const prompt = buildSystemPrompt(settings, { file: 'DEX.md', content: 'Use pnpm.\n' });
    expect(prompt).toContain('from DEX.md');
    expect(prompt).toContain('<project_instructions>\nUse pnpm.\n</project_instructions>');
  });

  it('omits the section when there is no file or it is blank', () => {
    expect(buildSystemPrompt(settings)).not.toContain('project_instructions');
    expect(buildSystemPrompt(settings, { file: 'AGENTS.md', content: '  ' })).not.toContain('project_instructions');
  });
});
