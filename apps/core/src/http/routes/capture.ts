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
import { capture, createJudge, type CaptureInput } from '../../capture.js';
import { base64Decode } from '../../crypto.js';
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

const CaptureBody = z.object({
  sourceType: z.enum(SOURCE_TYPES),
  text: z.string().max(50_000).optional(),
  subject: z.string().max(1000).optional(),
  fromName: z.string().max(200).optional(),
  fromHandle: z.string().max(320).optional(),
  occurredAt: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
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
});

export const captureApi = new Hono<HonoEnv>();

captureApi.post(
  '/',
  requireAuth({ session: true, device: 'capture', agent: 'add' }),
  async (c) => {
    const auth = requireUser(c);
    const body = await jsonBody(c, CaptureBody);
    if (!body.text?.trim() && !body.image) throw badRequest('Send text, an image, or both.');

    const input: CaptureInput = {
      sourceType: body.sourceType,
      text: body.text ?? null,
      subject: body.subject ?? null,
      fromName: body.fromName ?? null,
      fromHandle: body.fromHandle ?? null,
      occurredAt: body.occurredAt ?? null,
      sourceRef: body.sourceRef ?? null,
      sourceLabel: body.sourceLabel ?? null,
      image: body.image ? decodeImage(body.image) : null,
      ...(body.threadKind ? { threadKind: body.threadKind } : {}),
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
