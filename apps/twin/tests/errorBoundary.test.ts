import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/AppErrorBoundary';

describe('AppErrorBoundary', () => {
  it('keeps the actionable exception message and provides a safe fallback', () => {
    expect(errorMessage(new Error('camera-bar rigidity violated'))).toBe('camera-bar rigidity violated');
    expect(errorMessage('bad scene')).toBe('Unknown rendering failure');
  });
});
