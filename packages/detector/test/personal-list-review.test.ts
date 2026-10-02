import { describe, expect, it } from 'vitest';
import { detect, personalListReplyForReview } from '../src/rules.js';
import type { Candidate } from '../src/types.js';

const personal: Candidate = {
  channel: 'email', from: {name: 'Morgan', handle: 'morgan@school.example.com'},
  text: 'I am proud of you. The way you stayed to help every family find their child showed such care. I will never forget it.',
  headers: {'List-Unsubscribe': '<https://school.example.com/unsubscribe>', 'List-Id': 'school.example.com'},
};
const negativeCases: Partial<Candidate>[] = [
  {text: 'Browse our new audiobooks and membership plans. We are here for you.', from:{name:'Listening Store',handle:'offers@store.example.com'}},
  {text: 'We appreciate you. Apply for our credit card offer and earn a welcome bonus.'},
  {headers:{'List-Id':'school.example.com',Precedence:'junk'}},
  {from:{name:'Morgan'}},
  {text:'Here is the agenda.',subject:'I am proud of you.'},
  {text: 'I am proud of you. If you leave, you will regret it.'},
  {text: 'I am proud of you.', headers:{'List-Id':'school.example.com','Auto-Submitted':'auto-generated'}},
  {text: 'I am proud of you.', headers:{'List-Id':'school.example.com','Feedback-Id':'campaign-42'}},
  {text: 'I am proud of you.', from:{handle:'noreply@school.example.com'}},
  {text: 'Here is the meeting agenda.'},
  {from:{isMe:true}},
];
describe('opt-in personal list review', () => {
  it('preserves an exact personal quote for review, never automatic saving', () => {
    expect(detect(personal).decision).toBe('exclude');
    const verdict = personalListReplyForReview(personal)!;
    expect(verdict.decision).toBe('maybe');
    expect(verdict.engine).toBe('rules');
    expect(verdict.caveats).toContain('mailing_list');
    expect(personal.text.slice(verdict.quoteStart, verdict.quoteEnd)).toBe(verdict.quote);
  });
  it.each(negativeCases)('does not rescue automated, commercial, harmful or non-evidence mail: %j', (override) => {
    expect(personalListReplyForReview({...personal,...override})).toBeNull();
  });
  it('does not change ordinary mail or other capture channels', () => {
    expect(personalListReplyForReview({...personal, headers:{}})).toBeNull();
    expect(personalListReplyForReview({...personal, channel:'text'})).toBeNull();
  });
});
