import { describe, expect, it } from 'vitest';
import { CATEGORY_LABELS } from '../src/index.js';
import { combineWeights, decide, detect, exclusionFor, softExclusionFor } from '../src/rules.js';
import type { Candidate, Verdict } from '../src/types.js';

const text = (body: string, extra: Partial<Candidate> = {}): Candidate => ({
  text: body,
  channel: 'text',
  threadKind: 'direct',
  from: { name: 'Dana Reyes', handle: '+15555550101' },
  ...extra,
});

const email = (body: string, extra: Partial<Candidate> = {}): Candidate => ({
  text: body,
  channel: 'email',
  from: { name: 'Dana Reyes', handle: 'dana@example.com' },
  headers: {},
  ...extra,
});

const rules = (v: Verdict): string[] => v.reasons.map((r) => r.rule);

function expectVerbatim(c: Candidate, v: Verdict): void {
  expect(v.quote).toBe(c.text.slice(v.quoteStart, v.quoteEnd));
  expect(c.text.includes(v.quote)).toBe(true);
}

describe('stage 1: hard exclusions', () => {
  it.each<[string, Candidate, string]>([
    ['from me', text('I am so proud of you', { from: { handle: '+15555550100', isMe: true } }), 'from_me'],
    ['short code', text('Thank you so much for your order', { from: { handle: '55512' } }), 'short_code'],
    ['short code with punctuation', text('Thanks!', { from: { handle: '+1 (555) 12' } }), 'short_code'],
    ['business chat', text('We loved helping you', { from: { handle: 'urn:biz:abc123' } }), 'business_chat'],
    ['alphanumeric SMS sender', text('We appreciate you', { from: { handle: 'BANKCO' } }), 'alphanumeric_sender'],
    ['list-unsubscribe', email('We are so proud of you', { headers: { 'List-Unsubscribe': '<mailto:u@example.com>' } }), 'header:list-unsubscribe'],
    ['list-id', email('Proud of you', { headers: { 'list-id': '<family.example.com>' } }), 'header:list-id'],
    ['precedence bulk', email('Proud of you', { headers: { precedence: 'Bulk' } }), 'header:precedence'],
    ['auto-submitted', email('Thank you so much', { headers: { 'auto-submitted': 'auto-replied' } }), 'header:auto-submitted'],
    ['noreply sender', email('Thank you!', { from: { handle: 'no-reply@shop.example.com' } }), 'sender:noreply'],
    ['job board', email('You would be amazing', { from: { handle: 'jobs-listings@linkedin.com' } }), 'sender:job_board'],
    ['order subject', email('Thank you!', { subject: 'Your order has shipped' }), 'subject:order_status'],
    ['calendar subject', email('See you there', { subject: 'Invitation: Coffee @ Tue Sep 30' }), 'subject:calendar'],
    ['OTP', text('Your verification code is 482913'), 'body:otp'],
    ['unsubscribe footer', email('We love you! Unsubscribe here.'), 'body:unsubscribe'],
    ['recruiter spam', email('I came across your profile and you would be amazing here.'), 'body:recruiter_spam'],
  ])('%s', (_name, candidate, rule) => {
    const verdict = detect(candidate);
    expect(verdict.decision).toBe('exclude');
    expect(verdict.excludedBy).toBe(rule);
    expect(verdict.quote).toBe('');
  });

  it('lets auto-submitted: no through', () => {
    expect(exclusionFor(email('Proud of you', { headers: { 'auto-submitted': 'no' } }))).toBeNull();
  });

  it('never excludes manual adds', () => {
    const manual: Candidate = { text: 'Your code is 1234', channel: 'manual', from: { isMe: true, handle: '55512' } };
    expect(exclusionFor(manual)).toBeNull();
  });

  it('does not treat a person with a phone number as a business', () => {
    expect(exclusionFor(text('proud of you'))).toBeNull();
  });
});

describe('stage 1: soft business signals', () => {
  const client = { name: 'Rita Gomez', handle: 'info@lumen.example.com' };

  it('holds strong words aimed at the reader in maybe, never saved, when a business-sounding rule fires', () => {
    const candidate = email('Thank you so much for the new logo. You nailed it.', { from: client });
    expect(exclusionFor(candidate)).toBeNull();
    expect(softExclusionFor(candidate)).toBe('sender:business_mailbox');
    const v = detect(candidate);
    expect(v.decision).toBe('maybe');
    expect(v.caveats).toContain('business_signal');
    expect(rules(v)).toContain('caveat:business_signal:sender:business_mailbox');
    expectVerbatim(candidate, v);
  });

  it('still excludes business mail with nothing strong for the reader, or anything selling', () => {
    expect(detect(email('Your ticket has been updated. Thanks!', { from: { handle: 'support@acme.example.com' } })).excludedBy).toBe('sender:business_mailbox');
    const invoice = detect(email('Thank you for your business. We appreciate you! Payment is due in 30 days.', { subject: 'Invoice #1182', from: { handle: 'billing@acme.example.com' } }));
    expect(invoice).toMatchObject({ decision: 'exclude', excludedBy: 'sender:business_mailbox' });
  });

  it('keeps bulk and automated mail out whatever it says', () => {
    expect(detect(email("I'm so proud of you.", { from: { handle: 'no-reply@acme.example.com' } })).excludedBy).toBe('sender:noreply');
    expect(detect(email('So proud of you!', { headers: { 'list-unsubscribe': '<mailto:u@example.com>' } })).excludedBy).toBe('header:list-unsubscribe');
    expect(detect(email('Congrats on your new website launch. We would love to help you grow it. Book a free call here.')).excludedBy).toBe('body:cold_sales');
  });

  it('reads one-time codes, not every number near the word "code"', () => {
    expect(exclusionFor(email('The code you wrote in 2024 still runs everything.'))).toBeNull();
    expect(exclusionFor(email('Thanks for the code review on #4821.'))).toBeNull();
    expect(exclusionFor(text('Use code 123456 to sign in'))).toBe('body:otp');
    expect(exclusionFor(text('Your Harbor code is: 482913'))).toBe('body:otp');
  });

  it('tells a gift card thank-you from prize spam', () => {
    expect(exclusionFor(email('Thank you for the gift card, you are the sweetest.'))).toBeNull();
    expect(exclusionFor(email("You've been selected to win a $500 gift card! Claim now."))).toBe('body:prize_spam');
  });

  it('reads an organization from the shape of the sender name, not a word anywhere in it', () => {
    expect(softExclusionFor(text('proud of you', { from: { name: 'Dana (support group)', handle: '+15555550150' } }))).toBeNull();
    expect(softExclusionFor(text('proud of you', { from: { name: 'Coach Tina Team Mom', handle: '+15555550151' } }))).toBeNull();
    expect(softExclusionFor(email('Thanks for being with us', { from: { name: 'Acme Support', handle: 'hello@acme.example.com' } }))).toBe('sender:organization_name');
  });

  it('leaves ordinary kind subjects alone ("promotion", "sale", "how was your")', () => {
    for (const subject of ['Congrats on the promotion!', 'Congrats on the sale!!', 'How was your first week?']) {
      expect(detect(email('So proud of you. You earned every bit of this.', { subject })).decision).toBe('save');
    }
    expect(exclusionFor(email('Proud of you', { subject: 'Flash sale: 40% off everything' }))).toBe('subject:marketing');
  });
});

describe('implicit praise, with no stock phrase', () => {
  it.each([
    'You were the calmest person in the room today. The whole team noticed, and so did I.',
    'We picked your proposal because you listened better than anyone else we talked to.',
    'You were the only one who checked on me after the surgery.',
    'Nobody explains this stuff better than you.',
    'Your hard work on the fundraiser did not go unnoticed.',
    'Everyone enjoyed your talk so much.',
    "We'd love to hire you.",
    'You won first place in the regional poetry contest.',
    'Your contributions are truly valued here.',
    'Mahalo nui loa for everything you did for our ohana this week.',
  ])('keeps "%s" for a look, not saved on its own', (body) => {
    const candidate = email(body);
    const v = detect(candidate);
    expect(v.decision).toBe('maybe');
    expectVerbatim(candidate, v);
  });

  it.each([
    'you were the last person to leave, lock up please',
    "We picked your order up on the way home, it's on the counter.",
    'We picked you up at 6, see you then',
    'Better than anyone expected, the stock rose 12% after the earnings call.',
    'The whole team noticed the outage before the alert fired.',
    'Everyone noticed you were late again.',
    'Your absence did not go unnoticed. Please see me before class.',
    'She sings better than anyone in the choir, you have to come hear her.',
    "You were the calmest you've been in weeks, did the new meds help?",
    "You think you're better than everyone.",
    'You did better than expected, which honestly is not saying much.',
    'Nobody knows your body better than you, so trust your gut on the dosage.',
    'you took first aid last year right?',
  ])('does not read "%s" as praise', (body) => {
    expect(detect(text(body)).decision).toBe('exclude');
  });
});

describe('payments from people', () => {
  it('keeps a person paying for your work in maybe, never saved, however warm', () => {
    for (const body of [
      'sending the last $300 for the website, thank you',
      'Paid invoice #12 for the logo, great work',
      'Payment sent! I am so proud of you and so grateful. You are a genius, thank you for the amazing work on the rebrand.',
    ]) {
      const v = detect(text(body));
      expect(v.decision, body).toBe('maybe');
      expect(v.caveats, body).toContain('payment');
    }
    expect(detect({ text: 'Priya Shah paid you $250.00\nfor the mural', channel: 'ocr' }).decision).toBe('maybe');
  });

  it("keeps receipts, a processor's own mail and paying someone back out", () => {
    const processor = email('You received a payment of $1,200.00 from Harbor Coffee Co. for Invoice #0042.', { from: { handle: 'notifications@payments.example.com' } });
    expect(detect(processor).excludedBy).toBe('sender:automated_mailbox');
    expect(detect(email('Thank you for your purchase! Your order total was $84.20.', { from: { handle: 'orders@shop.example.com' } })).decision).toBe('exclude');
    expect(detect(text('thanks for dinner, sending you $20 for my half')).decision).toBe('exclude');
  });
});

describe('negation words that are part of the praise', () => {
  it.each(['Thank you for never giving up on me.', 'You never let me down. Not once.', 'Thank you for checking in on me.'])('keeps "%s"', (body) => {
    expect(detect(text(body)).decision).not.toBe('exclude');
  });

  it('still reads routine thanks and real negation as they are', () => {
    expect(detect(text('Thanks for checking in, the report is attached.')).decision).toBe('exclude');
    expect(detect(text('They never gave up on the lawsuit, so we settled.')).decision).toBe('exclude');
  });

  it('saves the landing page example', () => {
    const body = 'I never said it properly, so here it is. Those Sunday calls last winter got me through. Thank you for checking on me, every single week.';
    expect(detect(text(body)).decision).toBe('save');
    expect(detect(email(body)).decision).toBe('save');
  });
});

describe('traps without a marker emoji', () => {
  it('reads "said no one ever" and "can\'t wait to watch you fail" as sarcasm', () => {
    expect(detect(text("I'm so proud of you, said no one ever")).decision).toBe('exclude');
    expect(detect(text("Wow you're SO talented, can't wait to watch you fail again")).decision).toBe('exclude');
  });

  it('never saves love next to a request for secrecy, and keeps the request in the quote', () => {
    const candidate = text("I love you. Delete this after you read it and don't tell your mom we talked.");
    const v = detect(candidate);
    expect(v.decision).toBe('maybe');
    expect(v.caveats).toContain('coercion');
    expect(v.quote).toContain("don't tell your mom");
    expectVerbatim(candidate, v);
  });

  it('never saves a group message: the "you" may be someone else in the chat', () => {
    const v = detect(text("can't believe how far you've come Priya. so proud of you", { threadKind: 'group' }));
    expect(v.decision).toBe('maybe');
    expect(v.score).toBeGreaterThanOrEqual(0.75);
    expect(v.caveats).toContain('group_message');
  });
});

describe('stage 2: scoring', () => {
  it('saves clear, directed evidence', () => {
    const c = text("I'm so proud of you. You worked so hard for this.");
    const v = detect(c);
    expect(v.decision).toBe('save');
    expect(v.category).toBe('pride');
    expect(v.score).toBeGreaterThanOrEqual(0.75);
    expect(v.engine).toBe('rules');
    expectVerbatim(c, v);
  });

  it('keeps a bare thanks out entirely and a warm thanks in maybe', () => {
    expect(detect(text('thanks!')).decision).toBe('exclude');
    expect(detect(text('Thank you so much!')).decision).toBe('maybe');
  });

  it('does not stack a repeated phrase', () => {
    const once = detect(text('love you'));
    const thrice = detect(text('love you love you love you'));
    expect(thrice.score).toBe(once.score);
  });

  it('scores the longest matching cue, not the phrases inside it', () => {
    const v = detect(text("I can't thank you enough."));
    expect(rules(v)).toContain('gratitude/phrase:cant_thank_you_enough');
    expect(rules(v)).not.toContain('gratitude/phrase:thank_you');
    expect(v.caveats).not.toContain('negated');
  });

  it('is deterministic', () => {
    const c = text('Thank you for everything. You mean the world to me ❤️');
    expect(detect(c)).toEqual(detect(c));
  });

  it('never puts message text in reason ids', () => {
    const v = detect(text('Zyxwvut, I am so proud of you. Zyxwvut.'));
    expect(JSON.stringify(v.reasons.map((r) => r.rule)).toLowerCase()).not.toContain('zyxwvut');
  });

  it('keeps nothing when there is no body to quote', () => {
    const v = detect(email('', { subject: "I'm so proud of you" }));
    expect(v.decision).toBe('exclude');
    expect(v.excludedBy).toBe('no_quote');
  });

  it('uses the subject as support but quotes only the body', () => {
    const c = email('Your mom told me about the scholarship. So well deserved.', { subject: 'Congratulations!' });
    const v = detect(c);
    expect(rules(v)).toContain('subject:accomplishment/phrase:congratulations');
    expectVerbatim(c, v);
  });
});

describe('negation', () => {
  it('drops a negated cue and excludes when nothing else is left', () => {
    const v = detect(text("I'm not proud of you for how you handled that."));
    expect(v.decision).toBe('exclude');
    expect(rules(v)).toContain('negated>pride/phrase:proud_of_you');
  });

  it('only looks a few words back', () => {
    expect(detect(text('Not that it matters now, but I am so proud of you')).decision).toBe('save');
    expect(detect(text("I don't think I have ever told you how proud of you I am")).decision).not.toBe('exclude');
  });

  it('stops at a clause break', () => {
    const v = detect(text("It's not much, but thank you for everything you did for Dad."));
    expect(v.caveats).not.toContain('negated');
    expect(v.decision).not.toBe('exclude');
  });

  it('honors exceptions like "can\'t stop" and "not gonna lie"', () => {
    expect(detect(text("Not gonna lie, I cried reading your post. So proud of you.")).decision).toBe('save');
    expect(detect(text("I can't stop telling people about you. You're so talented.")).caveats).not.toContain('negated');
  });

  it('adds a caveat when negated evidence sits next to live evidence', () => {
    const v = detect(text("I'm not saying I'm proud of you. I love you so much though."));
    expect(v.caveats).toContain('negated');
    expect(v.decision).toBe('maybe');
  });
});

describe('dampeners', () => {
  it('neutralizes boilerplate thanks', () => {
    for (const body of ['Thanks in advance for the slides', 'Thanks for the quick reply! Tuesday works.', 'Thank you for your patience.']) {
      expect(detect(text(body)).decision, body).toBe('exclude');
    }
  });

  it('neutralizes transactional praise and flags it when other evidence remains', () => {
    expect(detect(text('Congrats on your purchase! Track your order below.')).decision).toBe('exclude');
    const v = detect(email('Dear customer, we appreciate you so much. You are the best part of our store.'));
    expect(v.caveats).toContain('transactional');
    expect(v.decision).not.toBe('save');
  });

  it('neutralizes praise aimed at someone else', () => {
    expect(detect(text('Congrats to Priya on the promotion!', { threadKind: 'group' })).decision).toBe('exclude');
    expect(detect(text('Proud of my son today, he finished a marathon')).decision).toBe('exclude');
  });

  it('keeps a cue that names "you" even when a third-party pattern overlaps', () => {
    expect(detect(text("I'm so proud of the person you're becoming.")).decision).toBe('save');
  });

  it('flags sarcasm and never saves it', () => {
    const v = detect(text('thanks a lot, really helpful 🙄 you are the best'));
    expect(v.caveats).toContain('possible_sarcasm');
    expect(v.decision).not.toBe('save');
    expect(detect(text('Thanks for nothing.')).decision).toBe('exclude');
  });

  it('holds apologies and rejections in maybe', () => {
    const apology = detect(text("I'm sorry I hurt you. I love you so much and I'll do better."));
    expect(apology.caveats).toContain('apology');
    expect(apology.decision).toBe('maybe');
    const breakup = detect(text("I love you but I can't do this anymore."));
    expect(breakup.caveats).toContain('rejection');
    expect(breakup.decision).toBe('maybe');
  });

  it('flags backhanded praise', () => {
    expect(detect(text("I didn't think you'd pull it off, but you did. Proud of you")).decision).toBe('maybe');
  });

  it("ignores the owner's own lines in a pasted chat", () => {
    expect(detect({ text: 'Aunt Carol: see you soon\nYou: love you so much, thank you', channel: 'ocr' }).decision).toBe('exclude');
  });
});

describe('context', () => {
  it('dampens group threads and notes it', () => {
    const direct = detect(text('So proud of you!! 🎉'));
    const group = detect(text('So proud of you!! 🎉', { threadKind: 'group' }));
    expect(group.score).toBeLessThan(direct.score);
    expect(group.caveats).toContain('group_message');
    expect(group.decision).toBe('maybe');
  });

  it('marks evidence with no one addressed as not directed', () => {
    const v = detect(text("Honestly the best manager I've had."));
    expect(v.caveats).toContain('not_directed');
    expect(v.decision).toBe('maybe');
  });
});

describe('quote selection', () => {
  it('returns the evidence span, not the whole email', () => {
    const body =
      'Quick update: the offsite moves to Oct 14. Send me any conflicts.\n\n' +
      'Also, thank you for staying late on Friday. You saved the launch.\n\nBest,\nRiley';
    const c = email(body);
    const v = detect(c);
    expect(v.quote).toBe('Also, thank you for staying late on Friday. You saved the launch.');
    expectVerbatim(c, v);
  });

  it('never cuts away a sarcasm marker in the next sentence', () => {
    const c = text('Great job... NOT');
    const v = detect(c);
    expect(v.quote).toBe('Great job... NOT');
    expectVerbatim(c, v);
  });

  it('keeps an adjacent apology with the evidence', () => {
    const c = text("I'm sorry I hurt you. You mean the world to me.");
    expect(detect(c).quote).toBe(c.text);
  });

  it('drops narration and quotation marks around the words', () => {
    expect(detect({ text: 'My sister texted: "You\'re the strongest person I know."', channel: 'agent' }).quote).toBe(
      "You're the strongest person I know.",
    );
    expect(detect({ text: "They said: 'We couldn't have shipped v2 without you.'", channel: 'agent' }).quote).toBe(
      "We couldn't have shipped v2 without you.",
    );
    expect(detect({ text: 'Nadia: happy birthday!! love you so much', channel: 'ocr' }).quote).toBe('happy birthday!! love you so much');
  });

  it('keeps long quotes bounded', () => {
    const filler = 'We talked about the garden and the weather and the new bakery on the corner and ';
    const c = text(`${filler.repeat(12)}I am so proud of you ${filler.repeat(12)}`);
    const v = detect(c);
    expect(v.quote.length).toBeLessThanOrEqual(600);
    expect(v.quote).toContain('I am so proud of you');
    expectVerbatim(c, v);
  });
});

describe('performance', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => ['you', 'so', 'proud', 'thank', 'never', 'without', 'best'][i % 7]).join(' ');

  it('stays fast on long and adversarial messages', () => {
    detect(text('warm up'));
    const inputs = [`you're ${'so '.repeat(5000)}x`, `you are ${'such a '.repeat(3000)}person`, 'Proud of you. '.repeat(3000), 'a'.repeat(50_000), words(10_000)];
    for (const input of inputs) {
      const started = performance.now();
      detect(text(input));
      // A generous ceiling: busy CI machines run every workspace at once.
      expect(performance.now() - started, input.slice(0, 30)).toBeLessThan(2000);
    }
  });

  it('grows linearly with one very long sentence, not quadratically', () => {
    const time = (input: string): number => {
      let best = Infinity;
      for (let i = 0; i < 3; i += 1) {
        const started = performance.now();
        detect(text(input));
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    detect(text(words(500)));
    const small = time(words(4_000));
    const large = time(words(16_000));
    // Four times the words: about 4x when linear, about 16x when quadratic.
    expect(large).toBeLessThan(small * 9 + 25);
  });
});

describe('control, threats and harm next to kind words', () => {
  it.each([
    "I love you, you're nothing without me.",
    'I love you so much. No one else will ever love you like I do.',
    "I love you, that's why I'm telling you this: you're crazy and nobody believes you.",
    'I love you but sometimes I really hate you.',
    "I love you even though you're a disappointment to this family.",
    "You're my everything. I love you so much that I can't stand you talking to other guys.",
    "I care about you so much, that's why I need your location on at all times.",
    'So proud of you for finally losing the weight, you look so much better now.',
    "I'm proud of you, but don't let it go to your head, you still mess everything up.",
    "I love you but you're being ridiculous right now",
    "You mean the world to me, which is why you're not allowed to see your friends.",
    "I care about you, that's why I read your messages.",
    "I'm so proud of you, even if you're still fat.",
  ])('never auto-saves coercion or backhanded love: %s', (body) => {
    for (const channel of ['text', 'email', 'agent'] as const) {
      const c = channel === 'email' ? email(body) : text(body, { channel });
      const v = detect(c);
      expect(v.decision, channel).toBe('maybe');
      expect(v.caveats).toContain('coercion');
      expect(v.quote).toBe(body);
      expectVerbatim(c, v);
    }
  });

  it('keeps the coercive sentence in the quote instead of trimming it away', () => {
    const c = text('I did all this for you because I love you. You owe me.');
    const v = detect(c);
    expect(v.decision).toBe('maybe');
    expect(v.quote).toContain('You owe me.');
    const guilt = text('I love you so much. After everything I have done for you, you owe me.');
    expect(detect(guilt).quote).toContain('you owe me');
  });

  it.each<[string, string]>([
    ["I'm sorry I hit you. It won't happen again. I love you so much.", 'harm:violence_to_you'],
    ['I love you, you know I only hit you because you make me so angry.', 'harm:violence_to_you'],
    ["I love you. If you leave me I'll kill myself and it will be your fault.", 'harm:self_harm'],
    ["I still love you. Answer me or I'm coming over.", 'harm:or_else_threat'],
    ["Thank you for everything. I love you. I won't be around much longer.", 'harm:not_around_longer'],
    ["You mean the world to me. I'm going to end it tonight.", 'harm:end_it_now'],
    ["I love you. Don't tell anyone about what happened or you'll regret it.", 'harm:you_will_regret'],
  ])('never keeps a loving fragment cut from a threat or warning: %s', (body, rule) => {
    const v = detect(text(body));
    expect(v.decision).toBe('exclude');
    expect(v.excludedBy).toBe(rule);
    expect(v.quote).toBe('');
  });

  it('still saves ordinary warmth that shares words with those patterns', () => {
    for (const body of [
      "I'll hit you up later, love you so much",
      "You're crazy talented and I'm so proud of you.",
      'So proud of you for finally finishing your degree!',
      'Love you but gotta run, so proud of you for today!',
    ]) {
      expect(detect(text(body)).decision, body).toBe('save');
    }
  });

  it('never excludes what the person adds by hand', () => {
    expect(detect(text("I'm sorry I hit you. I love you.", { channel: 'manual' })).decision).not.toBe('exclude');
  });
});

describe('decide', () => {
  it('follows the SPEC thresholds', () => {
    expect(decide(0.8, [])).toBe('save');
    expect(decide(0.75, [])).toBe('save');
    expect(decide(0.74, [])).toBe('maybe');
    expect(decide(0.35, [])).toBe('maybe');
    expect(decide(0.34, [])).toBe('exclude');
  });

  it('lets blocking caveats hold a verdict in maybe', () => {
    expect(decide(0.95, ['possible_sarcasm'])).toBe('maybe');
    expect(decide(0.3, ['apology'])).toBe('maybe');
    expect(decide(0.2, ['apology'])).toBe('exclude');
  });

  it('treats boilerplate and group_message as informational', () => {
    expect(decide(0.8, ['boilerplate', 'group_message'])).toBe('save');
    expect(decide(0.3, ['group_message'])).toBe('exclude');
  });
});

describe('combineWeights', () => {
  it('lets the strongest cue lead and others support', () => {
    expect(combineWeights([], 0.6)).toBe(0);
    expect(combineWeights([0.5], 0.6)).toBe(0.5);
    expect(combineWeights([0.5, 0.5], 0.6)).toBeCloseTo(0.65);
    expect(combineWeights([0.2, 0.2, 0.2, 0.2], 0.6)).toBeLessThan(0.5);
  });
});

describe('CATEGORY_LABELS', () => {
  it('matches the SPEC display names', () => {
    expect(Object.values(CATEGORY_LABELS)).toEqual([
      'Love', 'Care', 'Pride', 'Gratitude', 'Trusted', 'Belonging', 'Accomplishment', 'Recovery', 'Other',
    ]);
  });
});
