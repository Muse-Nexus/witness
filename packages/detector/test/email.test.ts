import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  extractEmailEvidence,
  htmlToText,
  MAX_HTML_CHARS,
  offsetMinutesOf,
  parseAddress,
  parseMailDate,
} from '../src/email.js';
import { detect } from '../src/rules.js';

const utc = (iso: string): number => Date.parse(iso);

describe('forwarded messages', () => {
  it('Gmail: takes the original sender, date and body, not the forwarder note', () => {
    const out = extractEmailEvidence({
      subject: 'Fwd: tonight',
      from: { name: 'Sam Rivera', address: 'sam@example.com' },
      date: 'Wed, 17 Sep 2026 08:15:00 -1000',
      headers: { 'message-id': '<fwd1@example.com>' },
      text: [
        'Saving this one.',
        '',
        '---------- Forwarded message ---------',
        'From: Morgan Ellis <morgan@example.org>',
        'Date: Tue, Sep 16, 2026 at 7:45 PM',
        'Subject: tonight',
        'To: Sam Rivera <sam@example.com>',
        'Cc: Jo Park <jo@example.org>,',
        ' Lee Chang <lee@example.org>',
        '',
        'I keep thinking about what you said at dinner. You make everyone around you braver.',
        '',
        '--',
        'Morgan Ellis',
        'Studio North',
      ].join('\n'),
    });
    expect(out.forwarded).toBe(true);
    expect(out.from).toEqual({ name: 'Morgan Ellis', handle: 'morgan@example.org' });
    expect(out.subject).toBe('tonight');
    expect(out.text).toBe('I keep thinking about what you said at dinner. You make everyone around you braver.');
    // No zone in Gmail's forwarded Date: the forwarder's offset (-1000) is used.
    expect(out.occurredAt).toBe(utc('2026-09-17T05:45:00Z'));
    expect(out.headers['message-id']).toBe('<fwd1@example.com>');
  });

  it('Outlook: underscore rule + From/Sent header block', () => {
    const out = extractEmailEvidence({
      subject: 'FW: Final delivery',
      headers: { date: 'Fri, 05 Sep 2026 17:00:00 -0700' },
      text: [
        'sharing this so I remember it',
        '',
        '________________________________',
        'From: Rosa Vega <rosa@vegaarch.example.com>',
        'Sent: Friday, September 5, 2026 4:48 PM',
        'To: Sam Rivera <sam@example.com>',
        'Subject: Final delivery',
        '',
        'Sam, the drawings are stunning. You are by far the most thoughtful designer we have worked with.',
        '',
        'Get Outlook for iOS',
      ].join('\n'),
    });
    expect(out.forwarded).toBe(true);
    expect(out.from).toEqual({ name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' });
    expect(out.subject).toBe('Final delivery');
    expect(out.text).toBe('Sam, the drawings are stunning. You are by far the most thoughtful designer we have worked with.');
    expect(out.occurredAt).toBe(utc('2026-09-05T23:48:00Z'));
  });

  it('Outlook (older): -----Original Message----- with [mailto:] addresses', () => {
    const out = extractEmailEvidence({
      subject: 'FW: thank you',
      headers: {},
      text: [
        '-----Original Message-----',
        'From: Lena Ruiz [mailto:lena.ruiz@example.edu]',
        'Sent: Thursday, September 11, 2026 3:02 PM',
        'To: Alex Kim',
        'Subject: thank you',
        '',
        'You were the best TA I have had in twelve years of teaching.',
      ].join('\n'),
    });
    expect(out.forwarded).toBe(true);
    expect(out.from).toEqual({ name: 'Lena Ruiz', handle: 'lena.ruiz@example.edu' });
    expect(out.text).toBe('You were the best TA I have had in twelve years of teaching.');
    expect(out.occurredAt).toBe(utc('2026-09-11T15:02:00Z'));
  });

  it('Apple Mail: Begin forwarded message, zone abbreviation, mobile sign-off', () => {
    const out = extractEmailEvidence({
      subject: 'Fwd: Sunday',
      headers: {},
      text: [
        'Begin forwarded message:',
        '',
        'From: Marcus Lee <marcus.lee@example.com>',
        'Subject: Sunday',
        'Date: September 14, 2026 at 9:03:44 PM PDT',
        'To: Jordan Blake <jordan@example.com>',
        '',
        "I keep thinking about Sunday. I'm so grateful for you.",
        '',
        'Sent from my iPhone',
      ].join('\n'),
    });
    expect(out.from).toEqual({ name: 'Marcus Lee', handle: 'marcus.lee@example.com' });
    expect(out.text).toBe("I keep thinking about Sunday. I'm so grateful for you.");
    expect(out.occurredAt).toBe(utc('2026-09-15T04:03:44Z'));
  });

  it('nested forwards: the innermost message is the original', () => {
    const out = extractEmailEvidence({
      subject: 'Fwd: Fwd: for you',
      headers: {},
      text: [
        'look what Dana sent!!',
        '',
        '---------- Forwarded message ---------',
        'From: Rae Kim <rae@example.com>',
        'Date: Wed, Sep 3, 2026 at 8:01 AM',
        'Subject: Fwd: for you',
        'To: Sam Rivera <sam@example.com>',
        '',
        'Dana asked me to pass this along.',
        '',
        '---------- Forwarded message ---------',
        'From: Dana Cole <dana.cole@example.org>',
        'Date: Tue, Sep 2, 2026 at 10:15 PM',
        'Subject: for you',
        'To: Rae Kim <rae@example.com>',
        '',
        'Please tell Sam the mural means the world to our family.',
      ].join('\n'),
    });
    expect(out.from).toEqual({ name: 'Dana Cole', handle: 'dana.cole@example.org' });
    expect(out.subject).toBe('for you');
    expect(out.text).toBe('Please tell Sam the mural means the world to our family.');
  });

  it('does not treat a reply with an Outlook header block as a forward', () => {
    const out = extractEmailEvidence({
      subject: 'RE: the recommendation',
      from: { name: 'Imani Brooks', address: 'Imani.Brooks@example.edu' },
      headers: {},
      text: [
        "Of course I'll write it. I'd trust you with any lab I run.",
        '',
        'From: Casey Harlow <casey@example.com>',
        'Sent: Monday, September 8, 2026 10:00 AM',
        'To: Imani Brooks <imani.brooks@example.edu>',
        'Subject: the recommendation',
        '',
        'Would you be willing to write me a letter?',
      ].join('\n'),
    });
    expect(out.forwarded).toBe(false);
    expect(out.from).toEqual({ name: 'Imani Brooks', handle: 'imani.brooks@example.edu' });
    expect(out.text).toBe("Of course I'll write it. I'd trust you with any lab I run.");
  });

  it('ignores a forward marker that only appears inside quoted reply history', () => {
    const out = extractEmailEvidence({
      subject: 'Re: look',
      from: { name: 'Pat', address: 'pat@example.com' },
      headers: {},
      text: [
        'Thank you for sharing this with me. It made my week.',
        '',
        'On Mon, Sep 1, 2026 at 9:00 AM Sam Rivera <sam@example.com> wrote:',
        '> ---------- Forwarded message ---------',
        '> From: Someone Else <else@example.org>',
        '> Date: Sun, Aug 31, 2026 at 8:00 PM',
        '>',
        '> Old news.',
      ].join('\n'),
    });
    expect(out.forwarded).toBe(false);
    expect(out.from?.handle).toBe('pat@example.com');
    expect(out.text).toBe('Thank you for sharing this with me. It made my week.');
  });
});

describe('quoted replies and signatures', () => {
  it('cuts at a wrapped Gmail "On ... wrote:" line', () => {
    const out = extractEmailEvidence({
      headers: {},
      text: [
        'What you said about Grandpa was perfect. Thank you.',
        '',
        'On Sat, Sep 6, 2026 at 11:20 AM Casey Harlow <',
        'casey@example.com> wrote:',
        '> Here is the draft I read today.',
      ].join('\n'),
    });
    expect(out.text).toBe('What you said about Grandpa was perfect. Thank you.');
  });

  it('removes interleaved > lines', () => {
    const out = extractEmailEvidence({
      headers: {},
      text: ['> Did the talk go ok?', 'It went great. You were the reason I felt calm.', '> Proud of you!', 'Thank you.'].join('\n'),
    });
    expect(out.text).toBe('It went great. You were the reason I felt calm.\nThank you.');
  });

  it('unquotes a body that is entirely quoted', () => {
    const out = extractEmailEvidence({ headers: {}, text: '> You are so loved.\n> Always.' });
    expect(out.text).toBe('You are so loved.\nAlways.');
  });

  it('drops the "-- " signature block and mobile sign-offs', () => {
    expect(extractEmailEvidence({ headers: {}, text: 'Proud of you.\n\n-- \nNoah Brandt\nDirector, Example Co' }).text).toBe('Proud of you.');
    expect(extractEmailEvidence({ headers: {}, text: 'Love you.\n\nSent from my Galaxy' }).text).toBe('Love you.');
    expect(extractEmailEvidence({ headers: {}, text: 'You did it!\nSent from Yahoo Mail for iPhone' }).text).toBe('You did it!');
  });

  it('keeps plain messages as they are', () => {
    const out = extractEmailEvidence({
      subject: 'thank you',
      from: { name: 'Grace Okafor', address: 'grace.okafor@example.com' },
      date: 'Sun, 14 Sep 2026 20:11:05 -0400',
      headers: {},
      text: 'Hi Jordan,\r\n\r\nThank you for checking on me every day.\r\n\r\nWith love,\r\nGrace',
    });
    expect(out.forwarded).toBe(false);
    expect(out.subject).toBe('thank you');
    expect(out.text).toBe('Hi Jordan,\n\nThank you for checking on me every day.\n\nWith love,\nGrace');
    expect(out.occurredAt).toBe(utc('2026-09-15T00:11:05Z'));
  });
});

describe('mail the owner did not write', () => {
  const planted = [
    'a note for you',
    '',
    '---------- Forwarded message ---------',
    'From: Mom <mom@example.com>',
    'Date: Dec 25, 2025',
    '',
    'I am so proud of you.',
  ].join('\n');

  it('does not follow a "forwarded" block when asked not to, so nobody can put words in someone else\'s mouth', () => {
    const e = extractEmailEvidence({
      text: planted,
      from: { name: 'Sam Stranger', address: 'sam@elsewhere.example' },
      date: 'Mon, 21 Sep 2026 10:00:00 -0700',
      headers: {},
      followForwards: false,
    });
    expect(e.forwarded).toBe(false);
    expect(e.unfollowedForward).toBe(true);
    expect(e.from).toEqual({ name: 'Sam Stranger', handle: 'sam@elsewhere.example' });
    expect(e.text).toBe('a note for you');
    expect(e.occurredAt).toBe(Date.UTC(2026, 8, 21, 17, 0, 0));
  });

  it('follows it by default (the owner forwarding by hand)', () => {
    const e = extractEmailEvidence({ text: planted, headers: {} });
    expect(e.forwarded).toBe(true);
    expect(e.from).toEqual({ name: 'Mom', handle: 'mom@example.com' });
    expect(e.text).toBe('I am so proud of you.');
  });
});

describe('HTML fallback', () => {
  it('reads crafted HTML with thousands of unclosed tags in linear time', () => {
    for (const html of ['<style>'.repeat(40_000), '<p '.repeat(80_000), '<!--'.repeat(80_000), '<x '.repeat(80_000), '<script>'.repeat(40_000)]) {
      const started = performance.now();
      htmlToText(html);
      expect(performance.now() - started, html.slice(0, 8)).toBeLessThan(1000);
    }
  });

  it('drops hidden blocks and comments, whatever their case, and keeps the text around them', () => {
    expect(htmlToText('<HTML><Head><TITLE>t</TITLE></Head><body><p>Hello <b>there</b></p><!-- note --><p>Again</p><SCRIPT>x()</SCRIPT>after')).toBe(
      'Hello there\n\nAgain\nafter',
    );
    expect(htmlToText('<p>before</p><style>p { color: red }')).toBe('before');
  });

  it('reads at most MAX_HTML_CHARS of HTML', () => {
    const text = htmlToText(`<p>${'a'.repeat(MAX_HTML_CHARS + 5000)}</p>`);
    expect(text.length).toBeLessThanOrEqual(MAX_HTML_CHARS);
  });

  it('uses the HTML part when there is no text part', () => {
    const out = extractEmailEvidence({
      headers: {},
      text: '   ',
      html:
        '<html><head><style>p{color:red}</style></head><body><div dir="ltr">Hi Casey,<div><br></div>' +
        '<div>Thank you for everything you did for us this year. You made a hard year feel lighter &amp; brighter.</div>' +
        '<div><br></div><div>Jun</div></div><script>track()</script></body></html>',
    });
    expect(out.text).toBe(
      'Hi Casey,\n\nThank you for everything you did for us this year. You made a hard year feel lighter & brighter.\n\nJun',
    );
  });

  it('finds an Outlook HTML forward separated by a rule', () => {
    const out = extractEmailEvidence({
      subject: 'FW: thanks',
      headers: {},
      html:
        '<div>keeping this</div><hr style="display:inline-block;width:98%">' +
        '<div id="divRplyFwdMsg"><font><b>From:</b> Ada Moss &lt;ada.moss@example.com&gt;<br>' +
        '<b>Sent:</b> Monday, September 1, 2026 9:00 AM<br><b>To:</b> Sam Rivera &lt;sam@example.com&gt;<br>' +
        '<b>Subject:</b> thanks</font></div><div><br></div><div>You changed how I think about my work.</div>',
    });
    expect(out.forwarded).toBe(true);
    expect(out.from).toEqual({ name: 'Ada Moss', handle: 'ada.moss@example.com' });
    expect(out.text).toBe('You changed how I think about my work.');
  });

  it('decodes entities', () => {
    expect(decodeEntities('you&rsquo;re &hearts; &#128150; &#x1F389; &nbsp;&bogus;')).toBe('you’re ♥ 💖 🎉  &bogus;');
    expect(htmlToText('<p>one</p><p>two&nbsp; three</p>')).toBe('one\n\ntwo three');
  });
});

describe('parseAddress', () => {
  it.each([
    ['Dana Reyes <Dana@Example.com>', { name: 'Dana Reyes', handle: 'dana@example.com' }],
    ['"Reyes, Dana" <dana@example.com>', { name: 'Reyes, Dana', handle: 'dana@example.com' }],
    ['*Dana Reyes* <dana@example.com>', { name: 'Dana Reyes', handle: 'dana@example.com' }],
    ['Dana Reyes [mailto:dana@example.com]', { name: 'Dana Reyes', handle: 'dana@example.com' }],
    ['dana@example.com', { handle: 'dana@example.com' }],
    ['Dana Reyes', { name: 'Dana Reyes' }],
  ])('%s', (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it('returns undefined for nothing', () => {
    expect(parseAddress('')).toBeUndefined();
    expect(parseAddress(undefined)).toBeUndefined();
  });
});

describe('parseMailDate', () => {
  it.each([
    ['Tue, 16 Sep 2026 18:02:11 -0700', '2026-09-17T01:02:11Z'],
    ['16 Sep 2026 18:02 +0000 (UTC)', '2026-09-16T18:02:00Z'],
    ['2026-09-16T19:45:00-07:00', '2026-09-17T02:45:00Z'],
    ['September 16, 2026 at 7:45:12 PM PDT', '2026-09-17T02:45:12Z'],
    ['Monday, September 22, 2026 9:14 AM', '2026-09-22T09:14:00Z'],
    ['Monday, 22 September 2026 09:14', '2026-09-22T09:14:00Z'],
    ['Sept 3, 2026 at 12:05 AM', '2026-09-03T00:05:00Z'],
    ['Sep 3, 2026', '2026-09-03T12:00:00Z'],
  ])('%s', (input, iso) => {
    expect(parseMailDate(input)).toBe(utc(iso));
  });

  it('uses a fallback offset only when the date has no zone', () => {
    expect(parseMailDate('Tue, Sep 16, 2026 at 7:45 PM', -600)).toBe(utc('2026-09-17T05:45:00Z'));
    expect(parseMailDate('Tue, 16 Sep 2026 19:45:00 +0000', -600)).toBe(utc('2026-09-16T19:45:00Z'));
  });

  it('leaves unknown dates unknown', () => {
    expect(parseMailDate('sometime last week')).toBeUndefined();
    expect(parseMailDate('Feb 31, 2026')).toBeUndefined();
    expect(parseMailDate('13:99 on Sep 3, 2026')).toBeUndefined();
    expect(parseMailDate(undefined)).toBeUndefined();
  });

  it('reads offsets', () => {
    expect(offsetMinutesOf('Tue, 16 Sep 2026 18:02:11 -0700')).toBe(-420);
    expect(offsetMinutesOf('Mon, 1 Sep 2026 09:00 +0530')).toBe(330);
    expect(offsetMinutesOf('September 1, 2026 at 9:00 AM HST')).toBe(-600);
    expect(offsetMinutesOf('September 1, 2026')).toBeUndefined();
  });
});

describe('end to end with the detector', () => {
  it('saves the forwarded evidence and quotes only the original words', () => {
    const out = extractEmailEvidence({
      subject: 'Fwd: your workshop',
      headers: {},
      text: [
        'keeping this',
        '',
        '---------- Forwarded message ---------',
        'From: Tessa Moreno <tessa@example.net>',
        'Date: Mon, Sep 8, 2026 at 6:12 PM',
        'Subject: your workshop',
        'To: Sam Rivera <sam@example.com>',
        '',
        'Your workshop changed how our whole team works. Thank you for being so generous with what you know.',
      ].join('\n'),
    });
    const verdict = detect({ text: out.text, subject: out.subject, channel: 'email', from: out.from, headers: out.headers });
    expect(verdict.decision).toBe('save');
    expect(verdict.quote.includes('keeping this')).toBe(false);
    expect(out.text.includes(verdict.quote)).toBe(true);
  });
});
