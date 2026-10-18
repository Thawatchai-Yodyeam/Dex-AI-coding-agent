import { describe, expect, it } from 'vitest';
import { appendStepText } from './types';

describe('appendStepText', () => {
  it('appends streamed pieces within a step without a separator', () => {
    expect(appendStepText('Hel', 'lo', true)).toBe('Hello');
  });

  it('separates the first text of a new step with a blank line', () => {
    expect(appendStepText('Stopping it:', 'Done.', false)).toBe('Stopping it:\n\nDone.');
  });

  it('adds no separator for the very first text or when one is already there', () => {
    expect(appendStepText('', 'First', false)).toBe('First');
    expect(appendStepText('Para\n\n', 'Next', false)).toBe('Para\n\nNext');
  });
});
