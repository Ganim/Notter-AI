import { describe, it, expect } from 'vitest';
import { askUser } from '../src/tools/ask-user.js';

describe('ask_user (Phase E stub)', () => {
  it('always returns {answer:"proceed", timeout:false}', () => {
    expect(
      askUser({
        action_id: 'act-1',
        task_id: 't1',
        question: 'Is it safe?',
      }),
    ).toEqual({ answer: 'proceed', timeout: false });
  });

  it('ignores options in Phase E', () => {
    expect(
      askUser({
        action_id: 'act-1',
        task_id: 't1',
        question: 'Pick one',
        options: ['a', 'b'],
      }),
    ).toEqual({ answer: 'proceed', timeout: false });
  });
});
