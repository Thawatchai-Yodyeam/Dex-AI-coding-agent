import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '../../types/agent';
import { evaluateRules, isSensitiveFileError, relativeToWorkspace, ruleMatches, suggestShellPattern } from './permissions';

const r = (action: PermissionRule['action'], tool: PermissionRule['tool'], pattern: string): PermissionRule => ({
  id: pattern,
  action,
  tool,
  pattern,
});

describe('ruleMatches', () => {
  it('matches shell commands with * and ignores case and extra spaces', () => {
    expect(ruleMatches(r('allow', 'shell', 'npm test*'), 'shell', 'npm   test --watch')).toBe(true);
    expect(ruleMatches(r('allow', 'shell', 'npm test*'), 'shell', 'NPM TEST')).toBe(true);
    expect(ruleMatches(r('allow', 'shell', 'npm test'), 'shell', 'npm test --watch')).toBe(false);
    expect(ruleMatches(r('allow', 'shell', 'npm test*'), 'shell', 'npx npm test')).toBe(false);
  });

  it('treats regex characters in patterns literally', () => {
    expect(ruleMatches(r('allow', 'shell', 'echo (hi)'), 'shell', 'echo (hi)')).toBe(true);
    expect(ruleMatches(r('allow', 'read', 'a.ts'), 'read', 'abts')).toBe(false);
  });

  it('matches file patterns by path, or by name when the pattern has no slash', () => {
    expect(ruleMatches(r('deny', 'read', '.env*'), 'read', 'config/.env.local')).toBe(true);
    expect(ruleMatches(r('deny', 'read', 'src/*'), 'read', 'src/deep/a.ts')).toBe(true);
    expect(ruleMatches(r('deny', 'read', 'src/*'), 'read', 'lib/src/a.ts')).toBe(false);
    expect(ruleMatches(r('deny', 'read', 'src\\*'), 'read', 'src/a.ts')).toBe(true);
  });

  it('only applies to its own tool', () => {
    expect(ruleMatches(r('allow', 'edit', '*'), 'read', 'a.ts')).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('lets deny win regardless of order', () => {
    const rules = [r('allow', 'shell', 'git*'), r('deny', 'shell', 'git push*')];
    expect(evaluateRules(rules, 'shell', 'git push origin')?.action).toBe('deny');
    expect(evaluateRules(rules, 'shell', 'git status')?.action).toBe('allow');
    expect(evaluateRules(rules, 'shell', 'npm test')).toBeNull();
  });

  it('checks every segment of a chained command against deny rules', () => {
    const rules = [r('deny', 'shell', 'rm*')];
    expect(evaluateRules(rules, 'shell', 'echo hi; rm -rf x')?.action).toBe('deny');
    expect(evaluateRules(rules, 'shell', 'dir | rm x')?.action).toBe('deny');
  });
});

describe('suggestShellPattern', () => {
  it('keeps the command and subcommand, stopping at flags', () => {
    expect(suggestShellPattern('npm test -- --watch')).toBe('npm test*');
    expect(suggestShellPattern('npm run build')).toBe('npm run build*');
    expect(suggestShellPattern('cargo   check --release')).toBe('cargo check*');
    expect(suggestShellPattern('python -m pytest')).toBe('python*');
  });
});

describe('relativeToWorkspace', () => {
  it('strips the workspace and collapses dot segments', () => {
    expect(relativeToWorkspace('D:\\proj', 'D:\\proj/src/../.env')).toBe('.env');
    expect(relativeToWorkspace('D:\\proj\\', 'd:/PROJ/src/a.ts')).toBe('src/a.ts');
    expect(relativeToWorkspace('D:\\proj', 'C:/other/a.ts')).toBe('C:/other/a.ts');
  });
});

describe('isSensitiveFileError', () => {
  it('recognises the Rust error prefix in strings and Errors', () => {
    expect(isSensitiveFileError('SENSITIVE_FILE: x')).toBe(true);
    expect(isSensitiveFileError(new Error('SENSITIVE_FILE: x'))).toBe(true);
    expect(isSensitiveFileError('not found')).toBe(false);
  });
});
