// Synthetic inputs for the end-to-end test. Every person, address, number and
// message here is fictional (example.com/.org/.net, 555-01xx numbers).
import { deflateSync } from 'node:zlib';

export const ACCOUNT = 'alex@example.com';

/** Words people sent Alex, exactly as the gallery and deliveries must show them. */
export const KIND = {
  maya: {
    name: 'Maya Chen',
    address: 'maya.chen@example.org',
    words: "Alex, thank you for staying late to help me move last weekend. I honestly couldn't have done it without you.",
  },
  jordan: {
    name: 'Jordan Ellis',
    address: 'jordan.ellis@example.org',
    words: "I'm so proud of you for finishing the marathon.",
  },
  // Added by hand in the app, with a photo.
  manual: { name: 'Sam Okafor', words: 'You were the calmest person in the room when it mattered. Thank you for that.' },
  // Arrives from the Mac helper, stored in attributedBody only.
  text: { handle: '+15555550142', words: "Thank you so much for picking me up yesterday. I don't know what I'd do without you." },
};

/** Things that must never reach the gallery. */
export const NOT_EVIDENCE = {
  newsletter: 'Thank you for being a valued subscriber. This week only: 20% off everything in the shop.',
  tapback: 'Loved “Thank you so much for picking me up yesterday.”',
  fromMe: 'Thank you, I love you so much, see you soon.',
  otp: 'Your verification code is 482913. Thank you for keeping your account safe.',
};

let counter = 0;
function messageId() {
  counter += 1;
  return `<e2e-${Date.now()}-${counter}@mail.example.com>`;
}

function rfc2822(date = new Date()) {
  return date.toUTCString().replace('GMT', '+0000');
}

/** A plain-text RFC 5322 message with CRLF line endings. */
function eml(headers, body) {
  const lines = Object.entries({ 'MIME-Version': '1.0', 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': '8bit', ...headers }).map(
    ([k, v]) => `${k}: ${v}`,
  );
  return `${lines.join('\r\n')}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}\r\n`;
}

/** What Gmail sends to a new forwarding address (synthetic, same shape). */
export function gmailConfirmation(to, code = '104729338') {
  return eml(
    {
      From: 'Gmail Team <forwarding-noreply@google.com>',
      To: to,
      Subject: `(#${code}) Gmail Forwarding Confirmation - Receive Mail from ${ACCOUNT}`,
      'Message-ID': messageId(),
      Date: rfc2822(),
    },
    [
      `${ACCOUNT} has requested to automatically forward mail to your email address ${to}.`,
      `Confirmation code: ${code}`,
      '',
      `To allow ${ACCOUNT} to automatically forward mail to your address, please click the link below to confirm the request:`,
      '',
      'https://mail-settings.google.com/mail/vf-%5BANGjdJ-e2e-synthetic%5D-e2eSyntheticToken',
      '',
      'If you click the link and it appears to be broken, please copy and paste it into a new browser window.',
    ].join('\n'),
  );
}

/** Alex forwarding a friend's email by hand from Gmail. */
export function forwardedKindEmail(to, friend) {
  return eml(
    {
      From: `Alex Rivera <${ACCOUNT}>`,
      To: to,
      Subject: 'Fwd: Last weekend',
      'Message-ID': messageId(),
      Date: rfc2822(),
    },
    [
      'Keeping this one.',
      '',
      '---------- Forwarded message ---------',
      `From: ${friend.name} <${friend.address}>`,
      'Date: Mon, Sep 21, 2026 at 9:14 AM',
      'Subject: Last weekend',
      `To: Alex Rivera <${ACCOUNT}>`,
      '',
      friend.words,
    ].join('\n'),
  );
}

/** A newsletter that Alex's filter forwarded: bulk mail, never evidence. */
export function newsletter(to) {
  return eml(
    {
      From: 'Weekly Deals <news@shop.example.net>',
      To: to,
      Subject: 'This week only',
      'List-Unsubscribe': '<mailto:unsubscribe@shop.example.net>',
      Precedence: 'bulk',
      'Message-ID': messageId(),
      Date: rfc2822(),
    },
    `${NOT_EVIDENCE.newsletter}\n\nUnsubscribe at any time.`,
  );
}

/** Rows for scripts/e2e/make-chat-db.swift. */
export function chatRows() {
  return [
    { guid: 'e2e-kind', text: KIND.text.words, handle: KIND.text.handle, minutesAgo: 40 },
    { guid: 'e2e-tapback', text: NOT_EVIDENCE.tapback, handle: KIND.text.handle, tapback: true, minutesAgo: 35 },
    { guid: 'e2e-from-me', text: NOT_EVIDENCE.fromMe, handle: KIND.text.handle, fromMe: true, minutesAgo: 30 },
    { guid: 'e2e-otp', text: NOT_EVIDENCE.otp, handle: '+15555550143', minutesAgo: 20 },
  ];
}

// --- A small synthetic PNG (a coral-to-lavender gradient), built without dependencies.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function gradientPng(width = 320, height = 200) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const t = x / (width - 1);
      raw[row + 1 + x * 3] = Math.round(236 * (1 - t) + 196 * t);
      raw[row + 2 + x * 3] = Math.round(112 * (1 - t) + 176 * t);
      raw[row + 3 + x * 3] = Math.round(99 * (1 - t) + 222 * t);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
