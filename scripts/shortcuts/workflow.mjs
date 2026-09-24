// The two Apple Shortcuts that send to Witness, as plain data (WFWorkflow property lists).
//
//   build.mjs              writes, lints, signs and checks them (macOS)
//   apps/web/src/shortcuts.test.ts   reads them back and checks what they send
//
// Nothing here holds a key. Each shortcut asks for the person's phone key once, when it is
// added (an import question on an empty Text action), and keeps it in the variable
// WitnessKey, which only the Authorization header uses.
import { createHash } from 'node:crypto';

export const DEFAULT_APP_URL = 'https://witness.musenexus.studio';
export const KEY_VARIABLE = 'WitnessKey';
export const CAPTURE_PATH = '/api/v1/capture';

/** Where the files are published (apps/web/public/shortcuts) and what they are called. */
export const SHORTCUTS = [
  { id: 'text', name: 'Send to Witness', file: 'send-to-witness.shortcut' },
  { id: 'image', name: 'Send image to Witness', file: 'send-image-to-witness.shortcut' },
];

export const KEY_QUESTION =
  'Paste your Witness phone key (it starts with wit_dev_). You can make one in Witness → Set up → Texts & photos.';

/** What the notification says. Calm and plain, like the rest of Witness. */
export const NOTICES = {
  saved: 'Kept.',
  maybe: 'Kept in Maybe.',
  failed: 'This did not reach Witness. Try again in a moment, or check the phone key in this shortcut.',
};

/** Shortcuts puts this character where a variable sits inside text. */
const OBJECT_REPLACEMENT = '\uFFFC';

/** Oldest Shortcuts that reads this format (the signer keeps it; iOS 13 era). */
const MINIMUM_CLIENT = 900;
const CLIENT_VERSION = '2605.0.5';
const ICON = { WFWorkflowIconGlyphNumber: 59511, WFWorkflowIconStartColor: 4251333119 };

/** WFItemType codes in a dictionary field. */
export const ITEM_TYPE = { text: 0, dictionary: 1, array: 2, number: 3, boolean: 4 };

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Stable UUIDs, so a rebuild with the same URL gives the same workflow. */
function uuid(seed) {
  const h = createHash('sha256').update(`witness-shortcuts:${seed}`).digest('hex').toUpperCase();
  const variant = '89AB'[Number.parseInt(h[16], 16) & 3];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const action = (id, parameters) => ({
  WFWorkflowActionIdentifier: `is.workflow.actions.${id}`,
  WFWorkflowActionParameters: parameters,
});

const shortcutInput = { Type: 'ExtensionInput' };
const repeatItem = { Type: 'Variable', VariableName: 'Repeat Item' };
const namedVariable = (name) => ({ Type: 'Variable', VariableName: name });
const actionOutput = (id, name) => ({ Type: 'ActionOutput', OutputName: name, OutputUUID: id });
const attachment = (value) => ({ Value: value, WFSerializationType: 'WFTextTokenAttachment' });

/** Text that may hold variables: strings and attachments, in order. */
function tokenString(...parts) {
  let string = '';
  const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === 'string') {
      string += part;
    } else {
      attachmentsByRange[`{${string.length}, 1}`] = part;
      string += OBJECT_REPLACEMENT;
    }
  }
  return { Value: { string, attachmentsByRange }, WFSerializationType: 'WFTextTokenString' };
}

const dictionary = (fields) => ({ Value: { WFDictionaryFieldValueItems: fields }, WFSerializationType: 'WFDictionaryFieldValue' });

/** One dictionary field: text (a string, or parts with variables), true/false, or a nested dictionary. */
function field(key, value) {
  const WFKey = tokenString(key);
  if (typeof value === 'boolean') {
    return { WFItemType: ITEM_TYPE.boolean, WFKey, WFValue: { Value: value, WFSerializationType: 'WFNumberSubstitutableState' } };
  }
  if (value && typeof value === 'object' && 'fields' in value) {
    return { WFItemType: ITEM_TYPE.dictionary, WFKey, WFValue: { Value: dictionary(value.fields), WFSerializationType: 'WFDictionaryFieldValue' } };
  }
  return { WFItemType: ITEM_TYPE.text, WFKey, WFValue: tokenString(...(Array.isArray(value) ? value : [value])) };
}

const notify = (body) =>
  action('notification', { WFNotificationActionTitle: 'Witness', WFNotificationActionBody: body, WFNotificationActionSound: false });

/** If `subject` is `value` … Otherwise … End If. */
function ifIs(subject, value, group, then, otherwise) {
  return [
    action('conditional', {
      GroupingIdentifier: group,
      WFControlFlowMode: 0,
      WFCondition: 4, // "is"
      WFConditionalActionString: value,
      WFInput: { Type: 'Variable', Variable: attachment(subject) },
    }),
    ...then,
    action('conditional', { GroupingIdentifier: group, WFControlFlowMode: 1 }),
    ...otherwise,
    action('conditional', { GroupingIdentifier: group, WFControlFlowMode: 2, UUID: uuid(`${group}:end`) }),
  ];
}

export function captureUrl(appUrl) {
  const url = new URL(appUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error(`Witness URL must be https: ${appUrl}`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`Witness URL must be an origin, like ${DEFAULT_APP_URL}: ${appUrl}`);
  return `${url.origin}${CAPTURE_PATH}`;
}

/**
 * Comment, key (asked for once, when the shortcut is added), the request, then one quiet
 * notification: saved, maybe, or that it did not arrive. With `eachInput`, the request and
 * its notification run once for each item shared (Repeat with Each).
 */
function sender({ id, appUrl, about, inputClasses, noInputBehavior, eachInput = false, prepare = [], body }) {
  const u = (label) => uuid(`${id}:${label}`);
  const keyText = u('key');
  const request = u('request');
  const status = actionOutput(u('status'), 'Dictionary Value');
  const send = [
    ...prepare,
    action('downloadurl', {
      UUID: request,
      WFURL: captureUrl(appUrl),
      WFHTTPMethod: 'POST',
      ShowHeaders: true,
      WFHTTPHeaders: dictionary([
        field('Authorization', ['Bearer ', namedVariable(KEY_VARIABLE)]),
        field('Content-Type', 'application/json'),
      ]),
      WFHTTPBodyType: 'JSON',
      WFJSONValues: dictionary(body),
    }),
    action('getvalueforkey', {
      UUID: status.OutputUUID,
      WFGetDictionaryValueType: 'Value',
      WFDictionaryKey: 'status',
      WFInput: attachment(actionOutput(request, 'Contents of URL')),
    }),
    ...ifIs(status, 'saved', u('if-saved'), [notify(NOTICES.saved)], ifIs(status, 'maybe', u('if-maybe'), [notify(NOTICES.maybe)], [notify(NOTICES.failed)])),
  ];
  const repeat = u('repeat');
  const actions = [
    action('comment', { WFCommentActionText: about }),
    action('gettext', { UUID: keyText, WFTextActionText: '' }),
    action('setvariable', { WFVariableName: KEY_VARIABLE, WFInput: attachment(actionOutput(keyText, 'Text')) }),
    ...(eachInput
      ? [
          action('repeat.each', { GroupingIdentifier: repeat, WFControlFlowMode: 0, WFInput: attachment(shortcutInput) }),
          ...send,
          action('repeat.each', { GroupingIdentifier: repeat, WFControlFlowMode: 2, UUID: uuid(`${repeat}:end`) }),
        ]
      : send),
  ];
  const keyIndex = actions.findIndex((a) => a.WFWorkflowActionParameters.UUID === keyText);
  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: CLIENT_VERSION,
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowIcon: ICON,
    WFWorkflowImportQuestions: [
      { ActionIndex: keyIndex, Category: 'Parameter', DefaultValue: '', ParameterKey: 'WFTextActionText', Text: KEY_QUESTION },
    ],
    WFWorkflowInputContentItemClasses: inputClasses,
    WFWorkflowMinimumClientVersion: MINIMUM_CLIENT,
    WFWorkflowMinimumClientVersionString: String(MINIMUM_CLIENT),
    ...(noInputBehavior ? { WFWorkflowNoInputBehavior: noInputBehavior } : {}),
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: ['ActionExtension'],
  };
}

function aboutText(what, appUrl) {
  return [
    `${what.replace('HOST', new URL(appUrl).host)} It sends nothing else, and never reads anything back.`,
    'Your phone key is in the Text action below. It can add things to Witness, never read them.',
    'To stop, delete this shortcut and revoke the key in Witness under Settings.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The two shortcuts
// ---------------------------------------------------------------------------

/** "Send to Witness": text from the share sheet, or what is copied when run on its own. */
export function textShortcut({ appUrl = DEFAULT_APP_URL } = {}) {
  return sender({
    id: 'text',
    appUrl,
    about: aboutText('Sends the text you share to your Witness at HOST. Run on its own, it sends what you last copied.', appUrl),
    inputClasses: ['WFStringContentItem'],
    noInputBehavior: { Name: 'WFWorkflowNoInputBehaviorGetClipboard', Parameters: {} },
    // `shared`: you chose this one, so Witness keeps it (in Maybe at worst).
    body: [field('sourceType', 'text'), field('text', [shortcutInput]), field('sourceLabel', 'iPhone'), field('shared', true)],
  });
}

/** "Send image to Witness": the original image bytes, never converted or resized. */
export function imageShortcut({ appUrl = DEFAULT_APP_URL } = {}) {
  const encoded = actionOutput(uuid('image:base64'), 'Base64 Encoded');
  return sender({
    id: 'image',
    appUrl,
    about: aboutText('Sends the screenshot or photo you share to your Witness at HOST, as the original file.', appUrl),
    inputClasses: ['WFImageContentItem'],
    // One request per image: several encoded images in one text field would run together.
    eachInput: true,
    prepare: [
      action('base64encode', { UUID: encoded.OutputUUID, WFEncodeMode: 'Encode', WFBase64LineBreakMode: 'None', WFInput: attachment(repeatItem) }),
    ],
    // Witness reads the real type from the file itself; the label only has to be one it accepts.
    body: [
      field('sourceType', 'screenshot'),
      field('sourceLabel', 'iPhone'),
      field('shared', true),
      field('image', { fields: [field('base64', [encoded]), field('mediaType', 'image/heic')] }),
    ],
  });
}

export const BUILDERS = { text: textShortcut, image: imageShortcut };

// ---------------------------------------------------------------------------
// Reading one back: what does it send? (build.mjs checks the signed file with this, and
// scripts/e2e.mjs sends exactly this request to the real Worker.)
// ---------------------------------------------------------------------------

/** Text with its variables filled in from `values` (by variable name, output name, or input type). */
export function readText(state, values) {
  if (typeof state === 'string') return state;
  if (state?.WFSerializationType !== 'WFTextTokenString') throw new Error(`not text: ${JSON.stringify(state)}`);
  let { string } = state.Value;
  const ranges = Object.entries(state.Value.attachmentsByRange ?? {})
    .map(([range, value]) => {
      const m = /^\{(\d+), (\d+)\}$/.exec(range);
      if (!m) throw new Error(`bad range ${range}`);
      return { start: Number(m[1]), length: Number(m[2]), name: variableName(value) };
    })
    .sort((a, b) => b.start - a.start);
  for (const { start, length, name } of ranges) {
    if (!(name in values)) throw new Error(`no value for ${name}`);
    string = string.slice(0, start) + values[name] + string.slice(start + length);
  }
  return string;
}

function variableName(value) {
  if (value.Type === 'Variable') return value.VariableName;
  if (value.Type === 'ActionOutput') return value.OutputName;
  return value.Type;
}

/** A WFDictionaryFieldValue as a plain object. */
export function readDictionary(state, values) {
  if (state?.WFSerializationType !== 'WFDictionaryFieldValue') throw new Error(`not a dictionary: ${JSON.stringify(state)}`);
  const out = {};
  for (const item of state.Value.WFDictionaryFieldValueItems) {
    const key = readText(item.WFKey, values);
    if (item.WFItemType === ITEM_TYPE.text) out[key] = readText(item.WFValue, values);
    else if (item.WFItemType === ITEM_TYPE.dictionary) out[key] = readDictionary(item.WFValue.Value, values);
    else if (item.WFItemType === ITEM_TYPE.boolean && item.WFValue.WFSerializationType === 'WFNumberSubstitutableState') out[key] = item.WFValue.Value;
    else throw new Error(`unexpected field ${key} (type ${item.WFItemType})`);
  }
  return out;
}

/** The request a shortcut makes, given the person's key, their input, and any action outputs. */
export function describeRequest(workflow, values) {
  const request = workflow.WFWorkflowActions.filter((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl');
  if (request.length !== 1) throw new Error(`expected one Get Contents of URL, found ${request.length}`);
  const p = request[0].WFWorkflowActionParameters;
  return {
    method: p.WFHTTPMethod,
    url: readText(p.WFURL, values),
    headers: readDictionary(p.WFHTTPHeaders, values),
    bodyType: p.WFHTTPBodyType,
    body: readDictionary(p.WFJSONValues, values),
  };
}

// ---------------------------------------------------------------------------
// XML property list
// ---------------------------------------------------------------------------

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Serializes strings, integers, booleans, arrays and plain objects (nothing else is needed). */
export function toPlistXml(value) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ];
  write(value, 0, out);
  out.push('</plist>', '');
  return out.join('\n');
}

function write(value, depth, out) {
  const pad = '\t'.repeat(depth);
  if (typeof value === 'string') out.push(`${pad}<string>${escapeXml(value)}</string>`);
  else if (typeof value === 'boolean') out.push(`${pad}<${value}/>`);
  else if (Number.isInteger(value)) out.push(`${pad}<integer>${value}</integer>`);
  else if (Array.isArray(value)) {
    if (value.length === 0) return void out.push(`${pad}<array/>`);
    out.push(`${pad}<array>`);
    for (const item of value) write(item, depth + 1, out);
    out.push(`${pad}</array>`);
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return void out.push(`${pad}<dict/>`);
    out.push(`${pad}<dict>`);
    for (const key of keys) {
      out.push(`${pad}\t<key>${escapeXml(key)}</key>`);
      write(value[key], depth + 1, out);
    }
    out.push(`${pad}</dict>`);
  } else {
    throw new TypeError(`a property list cannot hold ${String(value)}`);
  }
}
