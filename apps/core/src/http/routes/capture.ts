/**
 * POST /api/v1/capture: devices (Mac helper, iPhone Shortcut), assistants and
 * the web app all send evidence here. Response:
 * `{ status: saved|maybe|excluded|duplicate|blocked, id?, category?, quote?, reason? }`.
 * Device and assistant tokens never see `duplicate`: they get the status a first capture
 * of the same words would get, without an id.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_SUBJECT_CHARS, MAX_TEXT_CHARS, TOO_LONG_MESSAGE, capture, createJudge, type CaptureInput } from '../../capture.js';
import { base64Decode } from '../../crypto.js';
import { OccurredAtMs } from '../../dates.js';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, sniffImageType, type ImageType } from '../../media.js';
import { SOURCE_TYPES } from '../../store/db.js';
import { requireAuth } from '../auth.js';
import { requireUser, type HonoEnv } from '../context.js';
import { ApiError, badRequest, errorBody } from '../errors.js';
import { jsonBody } from '../middleware.js';

/** Room for a 10 MB image as base64 plus the rest of the JSON. */
export const CAPTURE_BODY_LIMIT = 15 * 1024 * 1024;

export const tooLarge = (c: Context) => c.json(errorBody('too_large', 'That is too large. Images can be up to 10 MB.'), 413);

export const ImageInput = z.object({
  base64: z.string().min(1).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 200),
  mediaType: z.enum(IMAGE_TYPES),
});

/** Decodes and checks an image. The file's own bytes decide its type. */
export function decodeImage(input: z.infer<typeof ImageInput>): { bytes: Uint8Array; type: ImageType } {
  const b64 = input.base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(b64.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw badRequest('The image is not valid base64.');
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'too_large', 'That is too large. Images can be up to 10 MB.');
  const type = sniffImageType(bytes);
  if (!type) throw badRequest('That image type is not supported. Use JPEG, PNG, WebP, HEIC or GIF.', 'unsupported_image');
  return { bytes, type };
}

/** What a device sends as sourceType (the web app may also send manual; an assistant's is always agent). */
const DEVICE_SOURCES = 'text, email, photo, screenshot, import';

const CaptureBody = z.object({
  sourceType: z.enum(SOURCE_TYPES, {
    error: (issue) => (issue.input === undefined ? `sourceType is required: one of ${DEVICE_SOURCES}.` : `sourceType must be one of ${DEVICE_SOURCES}.`),
  }),
  // The limit is checked below: text read from an image may run over it without losing the image.
  text: z.string().optional(),
  subject: z.string().max(MAX_SUBJECT_CHARS, `A subject can be up to ${MAX_SUBJECT_CHARS} characters.`).optional(),
  fromName: z.string().max(200).optional(),
  fromHandle: z.string().max(320).optional(),
  occurredAt: OccurredAtMs.optional(),
  sourceRef: z.string().max(500).optional(),
  sourceLabel: z.string().max(80).optional(),
  threadKind: z.enum(['direct', 'group']).optional(),
  image: ImageInput.optional(),
  /** Photos only, from a device: the person marked it a favorite, so it is saved without review. */
  favorite: z.boolean().optional(),
  /**
   * Devices: the person sent this one on purpose (the iPhone share sheet), so it is kept even
   * when the detector would not keep it (in maybe). Automations leave it out.
   */
  shared: z.boolean().optional(),
  /**
   * The text was read out of the attached image on the device (the iPhone shortcut's
   * on-device "Extract Text from Image"). Needs the image. The kept quote is labeled as read
   * from the image; when the words are not evidence, the image is kept alone.
   */
  textFromImage: z.boolean().optional(),
}).superRefine((body, ctx) => {
  if (body.text !== undefined && body.text.length > MAX_TEXT_CHARS && !(body.textFromImage && body.image)) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: TOO_LONG_MESSAGE });
  }
});

export const captureApi = new Hono<HonoEnv>();

captureApi.post(
  '/',
  requireAuth({ session: true, device: 'capture', agent: 'add' }),
  async (c) => {
    const auth = requireUser(c);
    const body = await jsonBody(c, CaptureBody, { example: '{"sourceType": "text", "text": "…"}' });
    if (!body.text?.trim() && !body.image) throw badRequest('Send text, an image, or both.');
    if (body.textFromImage && !body.image) throw badRequest('textFromImage needs the image the text was read from.');

    // More text than Witness reads, read out of an image (a long document): the image is kept
    // alone rather than refused, and none of that text is.
    const text = body.textFromImage && body.text !== undefined && body.text.length > MAX_TEXT_CHARS ? null : (body.text ?? null);
    const input: CaptureInput = {
      sourceType: body.sourceType,
      text,
      subject: body.subject ?? null,
      fromName: body.fromName ?? null,
      fromHandle: body.fromHandle ?? null,
      occurredAt: body.occurredAt ?? null,
      sourceRef: body.sourceRef ?? null,
      sourceLabel: body.sourceLabel ?? null,
      image: body.image ? decodeImage(body.image) : null,
      ...(body.threadKind ? { threadKind: body.threadKind } : {}),
      ...(body.textFromImage ? { textFromImage: true } : {}),
    };

    if (auth.kind === 'session') {
      input.manual = body.sourceType === 'manual';
    } else if (auth.tokenKind === 'agent') {
      // Assistants always capture as themselves, through the detector; what they add is at
      // the person's request, so it is never thrown away (at worst it waits in maybe).
      input.sourceType = 'agent';
      input.sourceLabel = body.sourceLabel ? `${body.sourceLabel.trim()} · Added by ${auth.label}` : `Added by ${auth.label}`;
      input.personChosen = true;
      input.neutralDuplicates = true;
    } else {
      if (body.sourceType === 'manual' || body.sourceType === 'agent') {
        throw badRequest('Devices capture texts, email, photos, screenshots or imports.');
      }
      input.trustedImage = body.sourceType === 'photo' && body.favorite === true;
      input.personChosen = body.shared === true;
      input.neutralDuplicates = true;
    }

    const cfg = c.get('cfg');
    const result = await capture(
      { env: c.env, cfg, keyring: c.get('keyring'), now: c.get('now'), judge: createJudge(c.env, cfg) },
      auth.userId,
      input,
    );
    return c.json(result, result.id ? 201 : 200);
  },
);
