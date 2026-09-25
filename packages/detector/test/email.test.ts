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
    const german = ['Am Fr., 5. Sept. 2026 um 09:00 Uhr schrieb Rosa Vega <rosa@vegaarch.example.com>:', `> ${ROSA}`];
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
