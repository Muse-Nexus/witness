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
import { pickFromThread } from '../src/thread.js';

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

  it('says when the words were all quoted, and not otherwise', () => {
    const quoted = extractEmailEvidence({ subject: 'Fwd: hi', headers: {}, text: '> You are the best designer I have ever worked with.\n>\n> Rosa' });
    expect(quoted.quotedOnly).toBe(true);
    const mixed = extractEmailEvidence({ subject: 'Re: hi', headers: {}, text: 'Ha, thanks.\n> You are the best designer I have ever worked with.' });
    expect(mixed.quotedOnly).toBeUndefined();
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

  it('says when it read only the start of the HTML, so nothing is kept from a cut message', () => {
    const kind = '<p>Thank you for everything you did for us this year.</p>';
    const long = extractEmailEvidence({ headers: {}, html: `${kind}${'<p>More news about the garden.</p>'.repeat(Math.ceil(MAX_HTML_CHARS / 30))}` });
    expect(long.truncated).toBe(true);
    expect(extractEmailEvidence({ headers: {}, html: kind }).truncated).toBeUndefined();
    // A text part is read whole; the HTML is not used then.
    expect(extractEmailEvidence({ headers: {}, text: 'Thank you.', html: 'x'.repeat(MAX_HTML_CHARS + 1) }).truncated).toBeUndefined();
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

  // Quoted history is someone else's words (often the owner's own); crediting it to the
  // replier would put words in their mouth. Kept or not, a quote never comes from it.
  it.each([
    [
      'a reply over quoted history',
      ['Got them, thanks.', '', 'On Sun, Sep 7, 2026 at 8:00 PM Sam Rivera <sam@example.com> wrote:', '> Rosa, I am so proud of you. You deserve every bit of this.'],
    ],
    ['interleaved quote lines', ['> You are the best designer I have ever worked with.', 'Ha, thanks. Sending the files tonight.']],
    [
      'a forward whose kind words sit only in its quoted history',
      [
        'look what she said',
        '',
        '---------- Forwarded message ---------',
        'From: Rosa Vega <rosa.vega@example.org>',
        'Date: Mon, Sep 8, 2026 at 6:12 PM',
        'Subject: Re: final files',
        'To: Sam Rivera <sam@example.com>',
        '',
        'Got them, thanks.',
        '',
        'On Sun, Sep 7, 2026 at 8:00 PM Sam Rivera <sam@example.com> wrote:',
        '> Rosa, I am so proud of you. You deserve every bit of this.',
      ],
    ],
  ])('never keeps quoted history as the sender\'s words: %s', (_name, lines) => {
    const out = extractEmailEvidence({ subject: 'Re: files', from: { name: 'Rosa Vega', address: 'rosa.vega@example.org' }, headers: {}, text: lines.join('\n') });
    const verdict = detect({ text: out.text, subject: out.subject, channel: 'email', from: out.from, headers: out.headers });
    expect(verdict.quote).not.toMatch(/proud of you|best designer|deserve every bit/);
    expect(verdict.decision).not.toBe('save');
  });
});

// ---------------------------------------------------------------------------
// Whose words: the owner's own words, quoted in a reply, are never the replier's
// ---------------------------------------------------------------------------

/** What the owner (Sam) wrote, quoted back in Ana's reply. Strong praise, so misreading it would save it. */
const OWNER_WORDS = 'Ana, I am so proud of you. You deserve every bit of this.';
const OWNER_SENTENCE = 'so proud of you';
const REPLY = 'Gracias, de verdad.';
const ana = { name: 'Ana Duarte', address: 'ana.duarte@example.com' };

/** A reply from Ana: her new words, then Sam's message under a header (as the client prints it). */
const REPLIES: Record<string, { subject: string; text?: string; html?: string }> = {
  'Spanish Gmail, "El … escribió:" with > quoting': {
    subject: 'Re: felicidades',
    text: [REPLY, '', 'El lun, 1 sept 2026 a las 9:00, Sam Rivera (<sam@example.com>) escribió:', `> ${OWNER_WORDS}`].join('\n'),
  },
  'Spanish Gmail, the intro wrapped and the quote not marked': {
    subject: 'Re: felicidades',
    text: [REPLY, '', 'El lun, 1 sept 2026 a las 9:00, Sam Rivera (<', 'sam@example.com>) escribió:', '', OWNER_WORDS].join('\n'),
  },
  'French Gmail, "Le … a écrit :" (no-break space before the colon)': {
    subject: 'Re: félicitations',
    text: [REPLY, '', 'Le lun. 1 sept. 2026 à 09:00, Sam Rivera <sam@example.com> a écrit :', '', OWNER_WORDS].join('\n'),
  },
  'German Gmail, "Am … schrieb …:"': {
    subject: 'Re: Glückwunsch',
    text: [REPLY, '', 'Am Mo., 1. Sept. 2026 um 09:00 Uhr schrieb Sam Rivera <sam@example.com>:', '', OWNER_WORDS].join('\n'),
  },
  'Portuguese Gmail, "Em … escreveu:"': {
    subject: 'Re: parabéns',
    text: [REPLY, '', 'Em seg., 1 de set. de 2026 às 09:00, Sam Rivera <sam@example.com> escreveu:', '', OWNER_WORDS].join('\n'),
  },
  'Spanish Outlook, De/Enviado/Para/Asunto under a rule': {
    subject: 'RE: felicidades',
    text: [
      REPLY,
      '',
      '________________________________',
      'De: Sam Rivera <sam@example.com>',
      'Enviado: lunes, 1 de septiembre de 2026 9:00',
      'Para: Ana Duarte <ana.duarte@example.com>',
      'Asunto: felicidades',
      '',
      OWNER_WORDS,
    ].join('\n'),
  },
  'Spanish Outlook desktop, De/"Enviado el"/Para/Asunto with [mailto:] and no rule': {
    subject: 'RE: felicidades',
    text: [
      REPLY,
      '',
      'De: Sam Rivera [mailto:sam@example.com]',
      'Enviado el: lunes, 1 de septiembre de 2026 9:00',
      'Para: Ana Duarte <ana.duarte@example.com>',
      'Asunto: felicidades',
      '',
      OWNER_WORDS,
    ].join('\n'),
  },
  'Spanish Outlook desktop, "Enviado el" under a rule': {
    subject: 'RE: felicidades',
    text: [
      REPLY,
      '',
      '________________________________',
      'De: Sam Rivera <sam@example.com>',
      'Enviado el: lunes, 1 de septiembre de 2026 9:00',
      'Para: Ana Duarte <ana.duarte@example.com>',
      'Asunto: felicidades',
      '',
      OWNER_WORDS,
    ].join('\n'),
  },
  'Brazilian Outlook desktop, De/"Enviada em"/Para/Assunto': {
    subject: 'RE: parabéns',
    text: [
      REPLY,
      '',
      'De: Sam Rivera <sam@example.com>',
      'Enviada em: segunda-feira, 1 de setembro de 2026 09:00',
      'Para: Ana Duarte <ana.duarte@example.com>',
      'Assunto: parabéns',
      '',
      OWNER_WORDS,
    ].join('\n'),
  },
  'Italian Outlook on the web, Da/Inviato/A/Oggetto under a rule': {
    subject: 'R: congratulazioni',
    text: [
      REPLY,
      '',
      '________________________________',
      'Da: Sam Rivera <sam@example.com>',
      'Inviato: lunedì 1 settembre 2026 09:00',
      'A: Ana Duarte <ana.duarte@example.com>',
      'Oggetto: congratulazioni',
      '',
      OWNER_WORDS,
    ].join('\n'),
  },
  'Dutch Outlook on the web, Van/Verzonden/Aan/Onderwerp under a rule, names only': {
    subject: 'RE: gefeliciteerd',
    text: [
      REPLY,
      '',
      '________________________________',
      'Van: Sam Rivera',
      'Verzonden: maandag 1 september 2026 09:00',
      'Aan: Ana Duarte',
      'Onderwerp: gefeliciteerd',
      '',
      OWNER_WORDS,
    ].join('\n'),
  },
  'Italian Outlook on the web, HTML only': {
    subject: 'R: congratulazioni',
    html:
      `<div>${REPLY}</div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr">` +
      '<font face="Calibri, sans-serif"><b>Da:</b> Sam Rivera &lt;sam@example.com&gt;<br><b>Inviato:</b> lunedì 1 settembre 2026 09:00<br>' +
      '<b>A:</b> Ana Duarte &lt;ana.duarte@example.com&gt;<br><b>Oggetto:</b> congratulazioni</font><div>&nbsp;</div></div>' +
      `<div>${OWNER_WORDS}</div>`,
  },
  'German Outlook, Von/Gesendet/An/Betreff with no rule': {
    subject: 'AW: Glückwunsch',
    text: [
      REPLY,
      '',
      'Von: Sam Rivera <sam@example.com>',
      'Gesendet: Montag, 1. September 2026 09:00',
      'An: Ana Duarte <ana.duarte@example.com>',
      'Betreff: Glückwunsch',
      '',
      OWNER_WORDS,
    ].join('\n'),
  },
  'French Outlook, "De :"/"Envoyé :"/"À :"/"Objet :" in bold': {
    subject: 'RE: félicitations',
    text: [
      REPLY,
      '',
      '*De :* Sam Rivera <sam@example.com>',
      '*Envoyé :* lundi 1 septembre 2026 09:00',
      '*À :* Ana Duarte <ana.duarte@example.com>',
      '*Objet :* félicitations',
      '',
      OWNER_WORDS,
    ].join('\n'),
  },
  'Spanish Outlook on the web, HTML only': {
    subject: 'RE: felicidades',
    html:
      `<div>${REPLY}</div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr">` +
      '<font face="Calibri, sans-serif"><b>De:</b> Sam Rivera &lt;sam@example.com&gt;<br><b>Enviado:</b> lunes, 1 de septiembre de 2026 9:00<br>' +
      '<b>Para:</b> Ana Duarte &lt;ana.duarte@example.com&gt;<br><b>Asunto:</b> felicidades</font><div>&nbsp;</div></div>' +
      `<div>${OWNER_WORDS}</div>`,
  },
  'Gmail HTML only: div.gmail_quote with a Spanish intro': {
    subject: 'Re: felicidades',
    html:
      `<div dir="ltr">${REPLY}</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">El lun, 1 sept 2026 a las 9:00, Sam Rivera (&lt;<a href="mailto:sam@example.com">sam@example.com</a>&gt;) escribió:<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">${OWNER_WORDS}</div></blockquote></div>`,
  },
  'Gmail HTML only: an intro in a language Witness does not read, the blockquote still marks the quote': {
    subject: 'Re: congratulazioni',
    html:
      `<div dir="ltr">${REPLY}</div><div class="gmail_quote"><div class="gmail_attr">Il giorno lun 1 set 2026 alle ore 09:00 Sam Rivera &lt;sam@example.com&gt; ha scritto:<br></div>` +
      `<blockquote class="gmail_quote"><div>${OWNER_WORDS}</div><blockquote class="gmail_quote"><div>Older words, also quoted.</div></blockquote></blockquote></div>`,
  },
  'Apple Mail HTML: blockquote type="cite"': {
    subject: 'Re: felicidades',
    html: `<div>${REPLY}</div><div><br><blockquote type="cite"><div>On Sep 1, 2026, at 9:00 AM, Sam Rivera &lt;sam@example.com&gt; wrote:</div><div>${OWNER_WORDS}</div></blockquote></div>`,
  },
};

describe('replies in other languages and HTML-only quotes', () => {
  it.each(Object.entries(REPLIES))('%s: only the replier\'s new words are read', (_name, reply) => {
    const out = extractEmailEvidence({ ...reply, from: ana, date: 'Mon, 1 Sep 2026 10:30:00 -0500', headers: {} });
    expect(out.forwarded).toBe(false);
    expect(out.from).toEqual({ name: 'Ana Duarte', handle: 'ana.duarte@example.com' });
    expect(out.text).toBe(REPLY);
    // Regression: whatever the detector keeps, it never holds the owner's quoted words.
    const verdict = detect({ text: out.text, subject: out.subject, channel: 'email', from: out.from, headers: out.headers });
    expect(verdict.quote.toLowerCase()).not.toContain(OWNER_SENTENCE);
    expect(verdict.decision).toBe('exclude');
  });

  it('reads nested HTML quotes as nested "> " lines', () => {
    expect(htmlToText('<p>new</p><blockquote><p>one</p><blockquote><p>two</p></blockquote><p>back</p></blockquote><p>after</p>')).toBe(
      'new\n\n> one\n\n>> two\n\n> back\n\nafter',
    );
    // An unclosed quote runs to the end, as a browser shows it; a stray closer changes nothing.
    expect(htmlToText('<p>a</p></blockquote><blockquote><p>b</p>')).toBe('a\n\n> b');
    // The markers cannot be forged by a message.
    expect(htmlToText('<p>x\u0000quote+</p><p>y</p>')).toBe('xquote+\n\ny');
  });

  it('never guesses a date that reads as two months ("mar" is a Spanish Tuesday)', () => {
    expect(parseMailDate('mar, 1 sept 2026 a las 9:00')).toBeUndefined();
    expect(parseMailDate('vie, 5 sept 2026 a las 9:00 p. m.')).toBe(utc('2026-09-05T21:00:00Z'));
    expect(parseMailDate('Fr., 5. Sept. 2026 um 09:00')).toBe(utc('2026-09-05T09:00:00Z'));
    // Month names in other languages are not read at all: unknown stays unknown.
    expect(parseMailDate('lunes, 1 de septiembre de 2026 9:00')).toBeUndefined();
  });
});

describe('forwards in other languages', () => {
  it('Spanish Gmail: "Mensaje reenviado" with De/Fecha/Asunto/Para', () => {
    const out = extractEmailEvidence({
      subject: 'Fwd: la entrega',
      from: { name: 'Sam Rivera', address: 'sam@example.com' },
      headers: {},
      text: [
        'mira esto',
        '',
        '---------- Mensaje reenviado ---------',
        'De: Rosa Vega <rosa@vegaarch.example.com>',
        'Fecha: vie, 5 sept 2026 a las 16:48',
        'Asunto: la entrega',
        'Para: Sam Rivera <sam@example.com>',
        '',
        'Sam, the drawings are stunning. You are by far the most thoughtful designer we have worked with.',
      ].join('\n'),
    });
    expect(out.forwarded).toBe(true);
    expect(out.from).toEqual({ name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' });
    expect(out.subject).toBe('la entrega');
    expect(out.text).toBe('Sam, the drawings are stunning. You are by far the most thoughtful designer we have worked with.');
    expect(out.occurredAt).toBe(utc('2026-09-05T16:48:00Z'));
  });

  it('Spanish Outlook: "RV:" makes a De/Enviado block a forward; a date it cannot read stays unknown', () => {
    const out = extractEmailEvidence({
      subject: 'RV: Entrega final',
      date: 'Mon, 21 Sep 2026 10:00:00 -0700',
      headers: {},
      text: [
        'para guardar',
        '',
        '________________________________',
        'De: Rosa Vega <rosa@vegaarch.example.com>',
        'Enviado: viernes, 5 de septiembre de 2026 16:48',
        'Para: Sam Rivera <sam@example.com>',
        'Asunto: Entrega final',
        '',
        'You are by far the most thoughtful designer we have worked with.',
      ].join('\n'),
    });
    expect(out.forwarded).toBe(true);
    expect(out.from).toEqual({ name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' });
    expect(out.subject).toBe('Entrega final');
    expect(out.text).toBe('You are by far the most thoughtful designer we have worked with.');
    expect(out.occurredAt).toBeUndefined();
  });

  it('Spanish and Brazilian Outlook desktop: "Enviado el:" and "Enviada em:" mark a forward too', () => {
    for (const [subject, sent] of [
      ['RV: Entrega final', 'Enviado el: viernes, 5 de septiembre de 2026 16:48'],
      ['ENC: Entrega final', 'Enviada em: sexta-feira, 5 de setembro de 2026 16:48'],
    ] as const) {
      const out = extractEmailEvidence({
        subject,
        date: 'Mon, 21 Sep 2026 10:00:00 -0700',
        headers: {},
        text: [
          'para guardar',
          '',
          'De: Rosa Vega [mailto:rosa@vegaarch.example.com]',
          sent,
          'Para: Sam Rivera <sam@example.com>',
          'Asunto: Entrega final',
          '',
          'You are by far the most thoughtful designer we have worked with.',
        ].join('\n'),
      });
      expect(out.forwarded, subject).toBe(true);
      expect(out.from).toEqual({ name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' });
      expect(out.text).toBe('You are by far the most thoughtful designer we have worked with.');
    }
  });

  it('a forwarded block with no date keeps its date unknown, never the time it was forwarded', () => {
    const out = extractEmailEvidence({
      subject: 'Fwd: hi',
      date: 'Mon, 21 Sep 2026 10:00:00 -0700',
      headers: {},
      text: ['---------- Forwarded message ---------', 'From: Mom <mom@example.com>', 'Subject: hi', '', 'I am so proud of you.'].join('\n'),
    });
    expect(out.from).toEqual({ name: 'Mom', handle: 'mom@example.com' });
    expect(out.occurredAt).toBeUndefined();
  });

  it('an inner forward whose header cannot be read has no author, rather than the forwarder around it', () => {
    const out = extractEmailEvidence({
      subject: 'Fwd: Fwd: for you',
      headers: {},
      text: [
        '---------- Forwarded message ---------',
        'From: Rae Kim <rae@example.com>',
        'Date: Wed, Sep 3, 2026 at 8:01 AM',
        '',
        'Passing this along.',
        '',
        '---------- Forwarded message ---------',
        '',
        'Please tell Sam the mural means the world to our family.',
      ].join('\n'),
    });
    expect(out.forwarded).toBe(true);
    expect(out.text).toBe('Please tell Sam the mural means the world to our family.');
    expect(out.from).toBeUndefined();
    expect(out.occurredAt).toBeUndefined();
  });
});

describe('a thread the owner forwarded', () => {
  const sam = { name: 'Sam Rivera', address: 'sam@example.com' };
  const isOwnerAddress = (address: string) => ['sam@example.com', 'sam.rivera@work.example.com'].includes(address.toLowerCase());
  const threadMail = (history: string[], latest = 'Got them, thanks.') =>
    [
      'look what she said!!',
      '',
      '---------- Forwarded message ---------',
      'From: Rosa Vega <rosa@vegaarch.example.com>',
      'Date: Mon, Sep 8, 2026 at 6:12 PM',
      'Subject: Re: final files',
      'To: Sam Rivera <sam@example.com>',
      '',
      latest,
      '',
      ...history,
    ].join('\n');
  const GMAIL_HISTORY = [
    'On Sun, Sep 7, 2026 at 8:00 PM Sam Rivera <sam@example.com> wrote:',
    '> Here are the final files. I am so proud of how this turned out, you were wonderful to work with.',
    '>',
    '> On Fri, Sep 5, 2026 at 9:00 AM Rosa Vega <rosa@vegaarch.example.com> wrote:',
    '>> Sam, these drawings are stunning. You are by far the most thoughtful designer we have ever worked with.',
  ];
  const ROSA = 'Sam, these drawings are stunning. You are by far the most thoughtful designer we have ever worked with.';

  it('lists the earlier messages from others, each credited and dated by the thread; never the owner\'s', () => {
    const out = extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, date: 'Tue, 22 Sep 2026 09:00:00 -0700', headers: {}, text: threadMail(GMAIL_HISTORY), isOwnerAddress });
    expect(out.text).toBe('Got them, thanks.');
    expect(out.from).toEqual({ name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' });
    expect(out.thread).toEqual([{ text: ROSA, from: { name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' }, occurredAt: utc('2026-09-05T16:00:00Z') }]);
    expect(JSON.stringify(out.thread)).not.toContain('final files');
  });

  it('picks the earlier message when the forwarded one holds nothing to keep, credited to its author', () => {
    const out = extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, date: 'Tue, 22 Sep 2026 09:00:00 -0700', headers: {}, text: threadMail(GMAIL_HISTORY), isOwnerAddress });
    const picked = pickFromThread(out);
    expect(picked).toMatchObject({ text: ROSA, from: { name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' }, occurredAt: utc('2026-09-05T16:00:00Z'), fromThread: true, forwarded: true });
    expect('thread' in picked).toBe(false);
    const verdict = detect({ text: picked.text, channel: 'email', from: picked.from, headers: picked.headers });
    expect(verdict.decision).not.toBe('exclude');
    expect(verdict.quote).not.toContain('proud of how this turned out');
    // The forwarded message comes first when it is worth keeping.
    const kind = extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, headers: {}, text: threadMail(GMAIL_HISTORY, 'Thank you so much, you made this whole project a joy.'), isOwnerAddress });
    expect(pickFromThread(kind)).toMatchObject({ text: 'Thank you so much, you made this whole project a joy.', from: { name: 'Rosa Vega' } });
    expect(pickFromThread(kind).fromThread).toBeUndefined();
  });

  it('reads the history only for a forward the owner sent (isOwnerAddress given)', () => {
    const out = extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, headers: {}, text: threadMail(GMAIL_HISTORY) });
    expect(out.thread).toBeUndefined();
    expect(pickFromThread(out).text).toBe('Got them, thanks.');
    // And never in someone else's mail.
    const other = extractEmailEvidence({ subject: 'Re: final files', from: ana, headers: {}, text: ['Got them, thanks.', '', ...GMAIL_HISTORY].join('\n'), isOwnerAddress });
    expect(other.thread).toBeUndefined();
    expect(other.text).toBe('Got them, thanks.');
  });

  it('knows the owner by any of their addresses, by name, or as the one person the forwarded message was sent to', () => {
    const byWorkAddress = ['On Sun, Sep 7, 2026 at 8:00 PM Sam R <sam.rivera@work.example.com> wrote:', '> You are the best client, truly, thank you so much for everything.'];
    const byName = ['On Sun, Sep 7, 2026 at 8:00 PM Sam Rivera <srivera@elsewhere.example.net> wrote:', '> You are the best client, truly, thank you so much for everything.'];
    for (const history of [byWorkAddress, byName]) {
      expect(extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, headers: {}, text: threadMail(history), isOwnerAddress }).thread).toBeUndefined();
    }
    // Forwarded from another account: the forwarded message went to Sam's old address, which is Sam.
    const viaOld = threadMail(['On Sun, Sep 7, 2026 at 8:00 PM Samantha <sam.old@example.org> wrote:', '> You are the best client, truly, thank you so much for everything.']).replace(
      'To: Sam Rivera <sam@example.com>',
      'To: Samantha <sam.old@example.org>',
    );
    expect(extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, headers: {}, text: viaOld, isOwnerAddress }).thread).toBeUndefined();
  });

  it('never credits a quoted message with no address, and never dates one it cannot read', () => {
    const noAddress = ['On Sun, Sep 7, 2026 at 8:00 PM Rosa Vega wrote:', '> You are by far the most thoughtful designer we have ever worked with.'];
    expect(extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, headers: {}, text: threadMail(noAddress), isOwnerAddress }).thread).toBeUndefined();
    const undated = ['Em sex., 5 de set. de 2026 às 09:00, Rosa Vega <rosa@vegaarch.example.com> escreveu:', `> ${ROSA}`];
    const out = extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, date: 'Tue, 22 Sep 2026 09:00:00 -0700', headers: {}, text: threadMail(undated), isOwnerAddress });
    expect(out.thread).toEqual([{ text: ROSA, from: { name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' } }]);
    const picked = pickFromThread(out);
    expect(picked.occurredAt).toBeUndefined();
  });

  it('reads Outlook-style history and localized intros', () => {
    const outlook = [
      '________________________________',
      'From: Sam Rivera <sam@example.com>',
      'Sent: Sunday, September 7, 2026 8:00 PM',
      'To: Rosa Vega <rosa@vegaarch.example.com>',
      'Subject: RE: final files',
      '',
      'Here are the final files.',
      '',
      '________________________________',
      'De: Rosa Vega <rosa@vegaarch.example.com>',
      'Enviado: viernes, 5 de septiembre de 2026 9:00',
      'Para: Sam Rivera <sam@example.com>',
      'Asunto: final files',
      '',
      ROSA,
    ];
    expect(extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, headers: {}, text: threadMail(outlook), isOwnerAddress }).thread).toEqual([
      { text: ROSA, from: { name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' } },
    ]);
    // Quoted in Sam's own reply, so Sam's mail client printed the intro (in Sam's zone).
    const german = [
      'On Sun, Sep 7, 2026 at 8:00 PM Sam Rivera <sam@example.com> wrote:',
      '> Here are the final files.',
      '>',
      '> Am Fr., 5. Sept. 2026 um 09:00 Uhr schrieb Rosa Vega <rosa@vegaarch.example.com>:',
      `>> ${ROSA}`,
    ];
    expect(extractEmailEvidence({ subject: 'Fwd: Re: final files', from: sam, headers: {}, text: threadMail(german), isOwnerAddress }).thread).toEqual([
      { text: ROSA, from: { name: 'Rosa Vega', handle: 'rosa@vegaarch.example.com' }, occurredAt: utc('2026-09-05T09:00:00Z') },
    ]);
  });

  it('recovers a middle forwarder\'s note, credited to them', () => {
    const out = extractEmailEvidence({
      subject: 'Fwd: Fwd: files',
      from: sam,
      headers: {},
      isOwnerAddress,
      text: [
        'saving this',
        '',
        '---------- Forwarded message ---------',
        'From: Jo Park <jo@studio.example.com>',
        'Date: Wed, Sep 3, 2026 at 8:01 AM',
        'Subject: Fwd: files',
        'To: Sam Rivera <sam@example.com>',
        '',
        'Sam, this is all you. I am so proud of you and what you built.',
        '',
        '---------- Forwarded message ---------',
        'From: Client Desk <desk@client.example.org>',
        'Date: Tue, Sep 2, 2026 at 10:15 PM',
        'Subject: files',
        '',
        'Received, thanks.',
      ].join('\n'),
    });
    expect(out.text).toBe('Received, thanks.');
    expect(out.thread).toEqual([
      { text: 'Sam, this is all you. I am so proud of you and what you built.', from: { name: 'Jo Park', handle: 'jo@studio.example.com' }, occurredAt: utc('2026-09-03T08:01:00Z') },
    ]);
    expect(pickFromThread(out)).toMatchObject({ from: { name: 'Jo Park' }, fromThread: true });
  });
});

describe('whose words, and when: the owner is never someone else', () => {
  const mark = { name: 'Mark Matthews', address: 'mark@example.com' };
  const isOwnerAddress = (address: string) => address.toLowerCase() === 'mark@example.com';
  const OWNERS = 'You have been such a wonderful friend to me this year. Thank you for everything.';
  const forwardOf = (from: string, to: string, body: string[], date = 'Thu, Sep 10, 2026 at 9:00 AM') =>
    ['---------- Forwarded message ---------', `From: ${from}`, `Date: ${date}`, 'Subject: Re: dinner', `To: ${to}`, '', ...body].join('\n');
  const extract = (text: string, extra: Partial<Parameters<typeof extractEmailEvidence>[0]> = {}) =>
    extractEmailEvidence({ subject: 'Fwd: Re: dinner', from: mark, date: 'Thu, 10 Sep 2026 12:00:00 -0700', headers: {}, text, isOwnerAddress, ...extra });
  const everyText = (out: ReturnType<typeof extractEmailEvidence>) => [out.text, ...(out.thread ?? []).map((m) => m.text)].join('\n');

  it('a quoted message that is nothing but a quoted header block holds no words of its own', () => {
    // Rosa quoting Mark's mail with no note of her own, Outlook for Mac style (no rule line).
    const out = extract(
      forwardOf('Sam Lee <sam@example.com>', '<mark@example.com>', [
        'Got it.',
        '',
        'On Wed, Sep 9, 2026 at 8:00 PM Rosa Vega <rosa@example.com> wrote:',
        '> From: Mark Matthews <mark@example.com>',
        '> Sent: Tuesday, September 8, 2026 7:00 PM',
        '> To: Rosa Vega <rosa@example.com>',
        '> Subject: dinner',
        '>',
        `> ${OWNERS}`,
      ]),
    );
    expect(out.thread).toBeUndefined();
    const picked = pickFromThread(out);
    expect(picked.text).toBe('Got it.');
    expect(picked.fromThread).toBeUndefined();
  });

  it.each([
    ['On', ['On Monday I will loop in Sam <sam@example.com>', 'On 9/5/26 9:00 AM, Mark Matthews wrote:']],
    ['Le', ["Le mail de Sam c'est sam@example.com", 'Le 05/09/2026 à 09:00, Mark Matthews a écrit :']],
    // Two lines above: the three are never joined into one intro either.
    ['On, two lines up', ['On Monday I will loop in Sam <sam@example.com>', 'and Jo too', 'On 9/5/26 9:00 AM, Mark Matthews wrote:']],
    ['Le, two lines up', ["Le mail de Sam c'est sam@example.com", 'et celui de Jo aussi', 'Le 05/09/2026 à 09:00, Mark Matthews a écrit :']],
    ['Am, two lines up', ['Am Montag frage ich Sam <sam@example.com>', 'und Jo auch', 'Am 05.09.2026 um 09:00 schrieb Mark Matthews:']],
  ])('never takes the author of a quote from the line above its intro (%s)', (_opener, lines) => {
    const out = extract(forwardOf('Rosa Vega <rosa@example.com>', 'Mark Matthews <mark@example.com>', ['Got it.', ...lines, `> ${OWNERS}`]));
    // The intro has no address, so nobody is credited with the quote, and Rosa keeps her own lines.
    expect(out.thread).toBeUndefined();
    expect(out.text).toBe(['Got it.', ...lines.slice(0, -1)].join('\n'));
    expect(pickFromThread(out).text).not.toContain('wonderful friend');
    // A wrapped intro is still read as one.
    const wrapped = extract(
      forwardOf('Rosa Vega <rosa@example.com>', 'Mark Matthews <mark@example.com>', ['Got it.', '', 'On Wed, Sep 9, 2026 at 8:00 PM Sam Lee <', 'sam@example.com> wrote:', '> Proud of you, always. You earned every bit of this.']),
    );
    expect(wrapped.thread).toEqual([{ text: 'Proud of you, always. You earned every bit of this.', from: { name: 'Sam Lee', handle: 'sam@example.com' } }]);
    const wrappedTwice = extract(
      forwardOf('Rosa Vega <rosa@example.com>', 'Mark Matthews <mark@example.com>', ['Got it.', '', 'On Wed, Sep 9, 2026 at 8:00 PM Sam', 'Lee <sam@example.com>', 'wrote:', '> Proud of you, always. You earned every bit of this.']),
    );
    expect(wrappedTwice.thread).toEqual([{ text: 'Proud of you, always. You earned every bit of this.', from: { name: 'Sam Lee', handle: 'sam@example.com' } }]);
  });

  it('knows the owner behind a mailing list\'s rewritten sender, and by their name with or without a middle initial', () => {
    const viaList = ["On Fri, Sep 5, 2026 at 9:00 AM 'Mark Matthews' via Parents <parents@googlegroups.com> wrote:", '> You have been such a wonderful friend to our family this year.'];
    const out = extract(forwardOf('Rosa Vega <rosa@example.com>', 'Mark Matthews <mark@example.com>', ['Got it.', '', ...viaList]));
    expect(out.thread).toBeUndefined();
    expect(pickFromThread(out).text).toBe('Got it.');
    // A list address is nobody's own, so no one is credited by it.
    const other = extract(forwardOf('Rosa Vega <rosa@example.com>', 'Mark Matthews <mark@example.com>', ['Got it.', '', ...viaList.map((l) => l.replace('Mark Matthews', 'Sam Lee'))]));
    expect(other.thread).toBeUndefined();
    // An address the owner never registered, under their name without the middle initial.
    const alternate = ['On Fri, Sep 5, 2026 at 9:00 AM Mark Matthews <mark@work.example.com> wrote:', `> ${OWNERS}`];
    const markD = { name: 'Mark D. Matthews', address: 'mark@example.com' };
    const out2 = extract(forwardOf('Rosa Vega <rosa@example.com>', 'Mark D. Matthews <mark@example.com>', ['Got it.', '', ...alternate]), { from: markD });
    expect(out2.thread).toBeUndefined();
    expect(pickFromThread(out2).text).toBe('Got it.');
  });

  it('never keeps the owner\'s own forwarded message, and still finds the kind words it quotes', () => {
    const rosa = '> I am so proud of you and everything you built this year.';
    const text = forwardOf('Mark Matthews <mark@example.com>', 'Rosa Vega <rosa@example.com>', [OWNERS, '', 'On Wed, Sep 9, 2026 at 8:00 PM Rosa Vega <rosa@example.com> wrote:', rosa]);
    const out = extract(text);
    expect(out.fromOwner).toBe(true);
    // Rosa is who Mark wrote to, not Mark: her words are hers. Mark's client printed the intro, in his zone.
    expect(out.thread).toEqual([{ text: rosa.slice(2), from: { name: 'Rosa Vega', handle: 'rosa@example.com' }, occurredAt: utc('2026-09-10T03:00:00Z') }]);
    const picked = pickFromThread(out);
    expect(picked).toMatchObject({ text: rosa.slice(2), from: { name: 'Rosa Vega' }, fromThread: true });
    expect(picked.fromOwner).toBeUndefined();
    // Nothing kind from anyone else: the owner's own words stay flagged, for the caller to keep nothing.
    const alone = pickFromThread(extract(text.replace(rosa, '> ok, see you then')));
    expect(alone).toMatchObject({ text: OWNERS, fromOwner: true });
    expect(alone.fromThread).toBeUndefined();
    // Someone else's forwarded message is not flagged.
    expect(extract(forwardOf('Rosa Vega <rosa@example.com>', 'Mark Matthews <mark@example.com>', ['Thank you.'])).fromOwner).toBeUndefined();
  });

  it('keeps the kind words of a list post or a blind-copied mass mail the owner forwards', () => {
    const KIND = 'Sam, you have been such a wonderful friend to our family this year. Thank you for everything.';
    // Google Groups: the forwarded message is from the list and to the list.
    const list = extract(forwardOf("'Rosa Vega' via Parents <parents@googlegroups.com>", 'Parents <parents@googlegroups.com>', [KIND]));
    expect(list.fromOwner).toBeUndefined();
    expect(list.text).toBe(KIND);
    // A club mail sent to its own sender, with everyone blind-copied.
    const mass = extract(forwardOf('Coach Rosa <rosa@club.example.org>', 'Coach Rosa <rosa@club.example.org>', [KIND]));
    expect(mass.fromOwner).toBeUndefined();
    expect(mass.text).toBe(KIND);
  });

  it('never takes the one person a message went to for the owner when the owner was only copied', () => {
    const jen = '> Mark, you were so good to my kids this week. I will not forget it.';
    const text = [
      '---------- Forwarded message ---------',
      'From: Rosa Vega <rosa@example.com>',
      'Date: Thu, Sep 10, 2026 at 9:00 AM',
      'Subject: Re: the week',
      'To: Jen Matthews <jen@example.net>',
      'Cc: Mark Matthews <mark@example.com>',
      '',
      'Got it.',
      '',
      'On Wed, Sep 9, 2026 at 8:00 PM Jen Matthews <jen@example.net> wrote:',
      jen,
    ].join('\n');
    const out = extract(text);
    expect(out.thread).toEqual([expect.objectContaining({ text: jen.slice(2), from: { name: 'Jen Matthews', handle: 'jen@example.net' } })]);
  });

  it('never takes a relative, or a longer name, for the owner', () => {
    const KIND = 'Thank you for being there for me every single week this year.';
    for (const from of ['Mary Ann Matthews <mary@example.net>', 'Mark Matthews Jr <junior@example.net>', 'Jen Matthews <jen@example.net>']) {
      const out = extract(forwardOf(from, 'Mark Matthews <mark@example.com>', [KIND]));
      expect(out.fromOwner).toBeUndefined();
      expect(out.text).toBe(KIND);
    }
  });

  it('never joins a line with no date to the intro below it, even when the intro has no opener', () => {
    const out = extract(forwardOf('Rosa Vega <rosa@example.com>', 'Mark Matthews <mark@example.com>', ['Got it.', 'On Monday I will loop in Sam <sam@example.com>', 'Mark Matthews wrote:', `> ${OWNERS}`]));
    expect(out.thread).toBeUndefined();
    expect(pickFromThread(out).text).not.toContain('wonderful friend');
  });

  it('reads a surname "Via" as a person, not a list', () => {
    const KIND = 'Thank you for being there for me every single week this year.';
    const out = extract(forwardOf('Maria Via Lopez <maria@example.com>', 'Mark Matthews <mark@example.com>', ['Got it.', '', 'On Wed, Sep 9, 2026 at 8:00 PM Maria Via Lopez <maria@example.com> wrote:', `> ${KIND}`]));
    expect(out.thread).toEqual([expect.objectContaining({ text: KIND, from: { name: 'Maria Via Lopez', handle: 'maria@example.com' } })]);
  });

  it('drops what is quoted inside an all-quoted forward, whatever language introduces it (Apple Mail, HTML only)', () => {
    const html =
      '<div>fyi</div><blockquote type="cite"><div>Begin forwarded message:</div><br>' +
      '<div><b>From: </b>Rosa Vega &lt;rosa@example.com&gt;<br><b>Subject: </b>Re: grazie<br>' +
      '<b>Date: </b>September 6, 2026 at 9:00:00 AM PDT<br><b>To: </b>Mark Matthews &lt;mark@example.com&gt;</div><br>' +
      '<div>Grazie, a presto.</div><br>' +
      '<div>Il giorno 5 set 2026, alle ore 09:00, Mark Matthews &lt;mark@example.com&gt; ha scritto:</div>' +
      `<blockquote type="cite"><div>${OWNERS} You truly changed my life.</div></blockquote></blockquote>`;
    const out = extractEmailEvidence({ subject: 'Fwd: grazie', from: mark, headers: {}, html });
    expect(out).toMatchObject({ forwarded: true, from: { name: 'Rosa Vega', handle: 'rosa@example.com' }, quotedOnly: true, text: 'Grazie, a presto.' });
    const verdict = detect({ text: out.text, channel: 'email', from: out.from, headers: out.headers });
    expect(verdict.quote).not.toContain('wonderful friend');
    // A plain-text body quoted the same way keeps only its outer level.
    expect(extractEmailEvidence({ headers: {}, text: '> Grazie, a presto.\n>\n>> You have been such a wonderful friend.' }).text).toBe('Grazie, a presto.');
  });

  it('reads a quoted time in the owner\'s zone only when the owner\'s own mail client printed it', () => {
    // Sam, in another zone, replied quoting Rosa; Sam's client printed "8:00 AM" in Sam's zone.
    const out = extract(
      forwardOf('Sam Lee <sam@example.org>', 'Mark Matthews <mark@example.com>', [
        'Got it.',
        '',
        'On Tue, Sep 8, 2026 at 8:00 AM Rosa Vega <rosa@example.com> wrote:',
        '> You are the kindest person I know. Thank you for everything this year.',
      ], 'Mon, Sep 7, 2026 at 4:30 PM'),
      { date: 'Tue, 8 Sep 2026 10:00:00 -0700' },
    );
    expect(out.thread).toEqual([{ text: 'You are the kindest person I know. Thank you for everything this year.', from: { name: 'Rosa Vega', handle: 'rosa@example.com' } }]);
    expect(pickFromThread(out).occurredAt).toBeUndefined();
    // A time that carries its own zone needs no one's.
    const zoned = extract(
      forwardOf('Sam Lee <sam@example.org>', 'Mark Matthews <mark@example.com>', [
        'Got it.',
        '',
        'From: Rosa Vega <rosa@example.com>',
        'Sent: Monday, September 7, 2026 11:00 PM +0000',
        'To: Sam Lee <sam@example.org>',
        '',
        'You are the kindest person I know. Thank you for everything this year.',
      ]),
    );
    expect(zoned.thread?.[0]?.occurredAt).toBe(utc('2026-09-07T23:00:00Z'));
  });

  it('reads a forwarded header\'s time in the owner\'s zone only when the owner forwarded that block', () => {
    const nested = (date: string) =>
      forwardOf('Sam Lee <sam@example.org>', 'Mark Matthews <mark@example.com>', [
        'look at this',
        '',
        '---------- Forwarded message ---------',
        'From: Rosa Vega <rosa@example.com>',
        `Date: ${date}`,
        'Subject: thank you',
        'To: Sam Lee <sam@example.org>',
        '',
        'You are the kindest person I know. Thank you for everything this year.',
      ]);
    // Sam's client printed Rosa's header, in Sam's zone: unknown.
    expect(extract(nested('Tue, Sep 8, 2026 at 8:00 AM')).occurredAt).toBeUndefined();
    expect(extract(nested('Tue, 8 Sep 2026 08:00:00 +0900')).occurredAt).toBe(utc('2026-09-07T23:00:00Z'));
    // The block the owner forwarded themself: their own client, their own zone.
    expect(extract(forwardOf('Rosa Vega <rosa@example.com>', 'Mark Matthews <mark@example.com>', ['Thank you for everything.'], 'Tue, Sep 8, 2026 at 8:00 AM')).occurredAt).toBe(
      utc('2026-09-08T15:00:00Z'),
    );
  });

  it('never reads a Spanish or French Tuesday ("mar") as March', () => {
    for (const date of ['mar. 1 déc. 2026 à 09:00', 'mar., 1 déc. 2026 à 09:00', 'mar. 2 juin 2026', 'mar, 1 dic 2026 a las 9:00', 'mar. 5 janv. 2027 à 09:00', 'mar, 6 ene 2026 a las 9:00']) {
      expect(parseMailDate(date), date).toBeUndefined();
    }
    // English March, in every form mail clients print it.
    expect(parseMailDate('Tue, Mar 3, 2026 at 9:00 AM')).toBe(utc('2026-03-03T09:00:00Z'));
    expect(parseMailDate('Tue, 3 Mar 2026 09:00:00 -0700 (MST)')).toBe(utc('2026-03-03T16:00:00Z'));
    expect(parseMailDate('Tuesday, 3 Mar 2026 09:00 GMT')).toBe(utc('2026-03-03T09:00:00Z'));
    expect(parseMailDate('Mar 3, 2026')).toBe(utc('2026-03-03T12:00:00Z'));
    // End to end: a French Gmail forward, and a French intro, keep the date unknown.
    const fr = extractEmailEvidence({
      subject: 'TR: bravo',
      date: 'Tue, 1 Dec 2026 12:00:00 -0800',
      headers: {},
      text: ['---------- Message transféré ---------', 'De : Rosa Vega <rosa@example.com>', 'Date: mar. 1 déc. 2026 à 09:00', 'Objet : bravo', '', 'Tu as été incroyable, merci pour tout.'].join('\n'),
    });
    expect(fr.from).toEqual({ name: 'Rosa Vega', handle: 'rosa@example.com' });
    expect(fr.occurredAt).toBeUndefined();
    const intro = extract(
      forwardOf('Mark Matthews <mark@example.com>', 'Rosa Vega <rosa@example.com>', ['Merci.', '', 'Le mar. 1 déc. 2026 à 09:00, Rosa Vega <rosa@example.com> a écrit :', '> Tu as été incroyable, merci pour tout.']),
    );
    expect(intro.thread).toEqual([{ text: 'Tu as été incroyable, merci pour tout.', from: { name: 'Rosa Vega', handle: 'rosa@example.com' } }]);
  });
});

describe('a line that only looks like a reply intro', () => {
  const sam = { name: 'Sam Rivera', address: 'sam@example.com' };
  const isOwnerAddress = (address: string) => address.toLowerCase() === 'sam@example.com';
  const TEACHER = 'Ana has been such a kind and thoughtful helper in class this week. We are lucky to have her.';

  it.each([
    'On Friday, her teacher wrote:',
    'El maestro de Ana escribió:',
    'Le professeur a écrit :',
    'Am Freitag hat ihre Lehrerin geschrieben, sie schrieb:',
    'Em sala, a professora escreveu:',
  ])('follows a forward under a note that says who wrote it, with no date: "%s"', (note) => {
    const out = extractEmailEvidence({
      subject: 'Fwd: Great week',
      from: sam,
      date: 'Fri, 11 Sep 2026 17:00:00 -0700',
      headers: {},
      isOwnerAddress,
      text: [note, '', '---------- Forwarded message ---------', 'From: Ms. Lee <lee@school.example.org>', 'Date: Fri, Sep 11, 2026 at 3:00 PM', 'Subject: Great week', 'To: Sam Rivera <sam@example.com>', '', TEACHER].join('\n'),
    });
    expect(out.forwarded).toBe(true);
    expect(out.from).toEqual({ name: 'Ms. Lee', handle: 'lee@school.example.org' });
    expect(out.text).toBe(TEACHER);
  });

  it('keeps someone\'s own words after a line of theirs that ends in "wrote:"', () => {
    const lines = ['Sam, I found this card in her backpack.', 'On the back, Ana wrote:', '"My dad is my hero."', 'You are doing an amazing job with her.'];
    const out = extractEmailEvidence({ subject: 'a card', from: { name: 'Rosa Vega', address: 'rosa@example.com' }, headers: {}, followForwards: false, text: lines.join('\n') });
    expect(out.text).toBe(lines.join('\n'));
    expect(detect({ text: out.text, channel: 'email', from: out.from, headers: out.headers }).decision).not.toBe('exclude');
  });
});

describe('the one person a forwarded message went to', () => {
  const mark = { name: 'Mark Matthews', address: 'mark@example.com' };
  const isOwnerAddress = (address: string) => address.toLowerCase() === 'mark@example.com';
  const ROSA = 'Mark has been the most generous, patient volunteer we have ever had. Thank you for everything, Mark.';
  const forwarded = (to: string) =>
    [
      '---------- Forwarded message ---------',
      'From: Principal Diaz <diaz@school.example.org>',
      'Date: Thu, Sep 10, 2026 at 9:00 AM',
      'Subject: Re: volunteers',
      `To: ${to}`,
      '',
      'Agreed, adding him to the list.',
      '',
      'On Wed, Sep 9, 2026 at 8:00 PM Rosa Vega <rosa@school.example.org> wrote:',
      `> ${ROSA}`,
    ].join('\n');
  const extract = (text: string) => extractEmailEvidence({ subject: 'Fwd: Re: volunteers', from: mark, date: 'Thu, 10 Sep 2026 12:00:00 -0700', headers: {}, text, isOwnerAddress });

  it('is someone else when the owner was blind-copied: their words are kept, credited to them', () => {
    const out = extract(forwarded('Rosa Vega <rosa@school.example.org>'));
    // Undated: the principal's client printed that time with no zone, and it is not the owner's.
    expect(out.thread).toEqual([{ text: ROSA, from: { name: 'Rosa Vega', handle: 'rosa@school.example.org' } }]);
  });

  it('is the owner when the address carries their name, or no name at all', () => {
    for (const to of ['Mark Matthews <rosa@school.example.org>', 'M. Matthews <rosa@school.example.org>', '<rosa@school.example.org>', 'rosa@school.example.org']) {
      expect(extract(forwarded(to)).thread, to).toBeUndefined();
    }
  });
});
