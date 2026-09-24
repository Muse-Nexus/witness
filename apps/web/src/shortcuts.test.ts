import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_URL,
  ITEM_TYPE,
  KEY_QUESTION,
  KEY_VARIABLE,
  NOTICES,
  SHORTCUTS,
  captureUrl,
  describeRequest,
  imageShortcut,
  textShortcut,
  toPlistXml,
  type Workflow,
  type WorkflowAction,
} from '../../../scripts/shortcuts/workflow.mjs';
import headers from '../public/_headers?raw';
import manifest from './lib/shortcuts.json';

// The ready-made iPhone shortcuts (scripts/shortcuts/build.mjs). Each one is written as an
// XML property list, read back here with the browser's own XML parser, and checked for what
// it sends: never a key, only what the person shares.

const OBJECT = '\uFFFC';
const SELF_HOSTED = 'https://witness.example.com';
const KEYISH = /wit_(dev|agent|sess|link)_[A-Za-z0-9_-]{8,}/;

/** A minimal XML plist reader: dict, array, string, integer, true, false. */
function parsePlist(xml: string): Workflow {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  expect(doc.documentElement.nodeName).toBe('plist');
  expect(doc.documentElement.children).toHaveLength(1);
  return read(doc.documentElement.children[0]!) as Workflow;
}

function read(el: Element): unknown {
  switch (el.nodeName) {
    case 'dict': {
      const out: Record<string, unknown> = {};
      const kids = Array.from(el.children);
      expect(kids.length % 2).toBe(0);
      for (let i = 0; i < kids.length; i += 2) {
        expect(kids[i]!.nodeName).toBe('key');
        out[kids[i]!.textContent ?? ''] = read(kids[i + 1]!);
      }
      return out;
    }
    case 'array':
      return Array.from(el.children).map(read);
    case 'string':
      return el.textContent ?? '';
    case 'integer':
      return Number(el.textContent);
    case 'true':
      return true;
    case 'false':
      return false;
    default:
      throw new Error(`unexpected <${el.nodeName}>`);
  }
}

const ids = (w: Workflow) => w.WFWorkflowActions.map((a) => a.WFWorkflowActionIdentifier.replace('is.workflow.actions.', ''));
const only = (w: Workflow, id: string): WorkflowAction => {
  const found = w.WFWorkflowActions.filter((a) => a.WFWorkflowActionIdentifier === `is.workflow.actions.${id}`);
  expect(found).toHaveLength(1);
  return found[0]!;
};
type Field = { WFItemType: number; WFKey: unknown; WFValue: Record<string, unknown> };
const fields = (state: { Value: { WFDictionaryFieldValueItems: Field[] }; WFSerializationType: string }) => {
  expect(state.WFSerializationType).toBe('WFDictionaryFieldValue');
  return Object.fromEntries(state.Value.WFDictionaryFieldValueItems.map((f) => [(f.WFKey as { Value: { string: string } }).Value.string, f]));
};
const text = (value: string) => ({ Value: { string: value, attachmentsByRange: {} }, WFSerializationType: 'WFTextTokenString' });
const variableText = (attachment: object) => ({
  Value: { string: OBJECT, attachmentsByRange: { '{0, 1}': attachment } },
  WFSerializationType: 'WFTextTokenString',
});

describe.each([
  ['Send to Witness', textShortcut],
  ['Send image to Witness', imageShortcut],
] as const)('%s', (name, build) => {
  const xml = toPlistXml(build());
  const workflow = parsePlist(xml);

  it('is in the share sheet', () => {
    expect(SHORTCUTS.map((s) => s.name)).toContain(name);
    expect(workflow.WFWorkflowTypes).toContain('ActionExtension');
    expect(workflow.WFWorkflowHasShortcutInputVariables).toBe(true);
  });

  it('POSTs JSON to the capture API of the Witness it was built for', () => {
    const request = only(workflow, 'downloadurl').WFWorkflowActionParameters;
    expect(request.WFHTTPMethod).toBe('POST');
    expect(request.WFURL).toBe('https://witness.musenexus.studio/api/v1/capture');
    expect(request.WFHTTPBodyType).toBe('JSON');
    expect(DEFAULT_APP_URL).toBe(manifest.appUrl);
    const selfHosted = describeRequest(parsePlist(toPlistXml(build({ appUrl: SELF_HOSTED }))), { [KEY_VARIABLE]: 'k', ExtensionInput: 'x', 'Base64 Encoded': 'y' });
    expect(selfHosted.url).toBe(`${SELF_HOSTED}/api/v1/capture`);
  });

  it('sends the key only from the WitnessKey variable, in the Authorization header', () => {
    const h = fields(only(workflow, 'downloadurl').WFWorkflowActionParameters.WFHTTPHeaders);
    expect(Object.keys(h)).toEqual(['Authorization', 'Content-Type']);
    expect(h.Authorization!.WFItemType).toBe(ITEM_TYPE.text);
    expect(h.Authorization!.WFValue).toEqual({
      Value: { string: `Bearer ${OBJECT}`, attachmentsByRange: { '{7, 1}': { Type: 'Variable', VariableName: 'WitnessKey' } } },
      WFSerializationType: 'WFTextTokenString',
    });
    expect(h['Content-Type']!.WFValue).toEqual(text('application/json'));
  });

  it('asks for the key once, when it is added, into an empty Text action that sets WitnessKey', () => {
    expect(workflow.WFWorkflowImportQuestions).toHaveLength(1);
    const [question] = workflow.WFWorkflowImportQuestions;
    expect(question).toEqual({ ActionIndex: expect.any(Number), Category: 'Parameter', DefaultValue: '', ParameterKey: 'WFTextActionText', Text: KEY_QUESTION });
    expect(question!.Text).toContain('wit_dev_');
    expect(question!.Text).toContain('Set up → Texts & photos');
    const asked = workflow.WFWorkflowActions[question!.ActionIndex]!;
    expect(asked.WFWorkflowActionIdentifier).toBe('is.workflow.actions.gettext');
    expect(asked.WFWorkflowActionParameters.WFTextActionText).toBe('');
    const set = only(workflow, 'setvariable').WFWorkflowActionParameters;
    expect(set.WFVariableName).toBe('WitnessKey');
    expect(set.WFInput).toEqual({
      Value: { Type: 'ActionOutput', OutputName: 'Text', OutputUUID: asked.WFWorkflowActionParameters.UUID },
      WFSerializationType: 'WFTextTokenAttachment',
    });
    expect(workflow.WFWorkflowActions.indexOf(only(workflow, 'setvariable'))).toBeLessThan(workflow.WFWorkflowActions.indexOf(only(workflow, 'downloadurl')));
  });

  it('embeds no key or token of any kind', () => {
    expect(xml).not.toMatch(KEYISH);
    expect(xml).not.toMatch(/Bearer [^\uFFFC<]/);
    // wit_dev_ appears once: in the question that tells the person what to paste.
    expect(xml.match(/wit_dev_/g)).toHaveLength(1);
  });

  it('says what happened in one calm notification: kept, kept in Maybe, or did not arrive', () => {
    const notices = workflow.WFWorkflowActions.filter((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.notification');
    expect(notices.map((n) => n.WFWorkflowActionParameters.WFNotificationActionBody)).toEqual([NOTICES.saved, NOTICES.maybe, NOTICES.failed]);
    for (const n of notices) expect(`${n.WFWorkflowActionParameters.WFNotificationActionTitle} ${n.WFWorkflowActionParameters.WFNotificationActionBody}`).not.toContain('!');
    const status = only(workflow, 'getvalueforkey').WFWorkflowActionParameters;
    expect(status.WFDictionaryKey).toBe('status');
    const conditions = workflow.WFWorkflowActions
      .filter((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.conditional' && a.WFWorkflowActionParameters.WFControlFlowMode === 0)
      .map((a) => [a.WFWorkflowActionParameters.WFCondition, a.WFWorkflowActionParameters.WFConditionalActionString, a.WFWorkflowActionParameters.WFInput.Variable.Value.OutputUUID]);
    expect(conditions).toEqual([
      [4, 'saved', status.UUID],
      [4, 'maybe', status.UUID],
    ]);
    const comment = only(workflow, 'comment').WFWorkflowActionParameters.WFCommentActionText as string;
    expect(comment).toContain('witness.musenexus.studio');
    expect(comment).toContain('revoke the key in Witness under Settings');
  });
});

describe('Send to Witness (text)', () => {
  const workflow = parsePlist(toPlistXml(textShortcut()));

  it('takes text from the share sheet, or what is copied when run on its own', () => {
    expect(workflow.WFWorkflowInputContentItemClasses).toEqual(['WFStringContentItem']);
    expect(workflow.WFWorkflowNoInputBehavior).toEqual({ Name: 'WFWorkflowNoInputBehaviorGetClipboard', Parameters: {} });
    // If saved … Otherwise, If maybe … Otherwise … End If, End If.
    expect(ids(workflow)).toEqual([
      'comment',
      'gettext',
      'setvariable',
      'downloadurl',
      'getvalueforkey',
      'conditional',
      'notification',
      'conditional',
      'conditional',
      'notification',
      'conditional',
      'notification',
      'conditional',
      'conditional',
    ]);
  });

  it('sends the shared text as person-chosen, with JSON types Witness expects', () => {
    const body = fields(only(workflow, 'downloadurl').WFWorkflowActionParameters.WFJSONValues);
    expect(Object.keys(body)).toEqual(['sourceType', 'text', 'sourceLabel', 'shared']);
    expect(body.sourceType).toMatchObject({ WFItemType: ITEM_TYPE.text, WFValue: text('text') });
    expect(body.text).toMatchObject({ WFItemType: ITEM_TYPE.text, WFValue: variableText({ Type: 'ExtensionInput' }) });
    expect(body.sourceLabel).toMatchObject({ WFItemType: ITEM_TYPE.text, WFValue: text('iPhone') });
    // A real boolean (<true/>), not the text "true" or the number 1.
    expect(body.shared).toMatchObject({ WFItemType: ITEM_TYPE.boolean, WFValue: { Value: true, WFSerializationType: 'WFNumberSubstitutableState' } });
    expect(toPlistXml(textShortcut())).toMatch(/<key>Value<\/key>\s*<true\/>/);

    expect(describeRequest(workflow, { [KEY_VARIABLE]: 'KEY', ExtensionInput: 'I am so proud of you for finishing the course.' })).toEqual({
      method: 'POST',
      url: 'https://witness.musenexus.studio/api/v1/capture',
      headers: { Authorization: 'Bearer KEY', 'Content-Type': 'application/json' },
      bodyType: 'JSON',
      body: { sourceType: 'text', text: 'I am so proud of you for finishing the course.', sourceLabel: 'iPhone', shared: true },
    });
  });
});

describe('Send image to Witness', () => {
  const workflow = parsePlist(toPlistXml(imageShortcut()));

  it("takes images and sends each one's original bytes as base64, with no conversion or resizing", () => {
    expect(workflow.WFWorkflowInputContentItemClasses).toEqual(['WFImageContentItem']);
    expect(workflow.WFWorkflowNoInputBehavior).toBeUndefined();
    const all = ids(workflow);
    expect(all.slice(0, 7)).toEqual(['comment', 'gettext', 'setvariable', 'repeat.each', 'base64encode', 'downloadurl', 'getvalueforkey']);
    expect(all.at(-1)).toBe('repeat.each');
    expect(all.filter((id) => id.startsWith('image.') || id.includes('convert') || id.includes('resize'))).toEqual([]);
    // One request per image, so several shared at once never run together in one field.
    const [start, end] = workflow.WFWorkflowActions.filter((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.repeat.each').map((a) => a.WFWorkflowActionParameters);
    expect(start).toMatchObject({ WFControlFlowMode: 0, WFInput: { Value: { Type: 'ExtensionInput' }, WFSerializationType: 'WFTextTokenAttachment' } });
    expect(end).toMatchObject({ WFControlFlowMode: 2, GroupingIdentifier: start!.GroupingIdentifier });
    const encode = only(workflow, 'base64encode').WFWorkflowActionParameters;
    expect(encode).toMatchObject({
      WFEncodeMode: 'Encode',
      WFBase64LineBreakMode: 'None',
      WFInput: { Value: { Type: 'Variable', VariableName: 'Repeat Item' }, WFSerializationType: 'WFTextTokenAttachment' },
    });

    const body = fields(only(workflow, 'downloadurl').WFWorkflowActionParameters.WFJSONValues);
    expect(Object.keys(body)).toEqual(['sourceType', 'sourceLabel', 'shared', 'image']);
    expect(body.sourceType!.WFValue).toEqual(text('screenshot'));
    expect(body.shared).toMatchObject({ WFItemType: ITEM_TYPE.boolean, WFValue: { Value: true, WFSerializationType: 'WFNumberSubstitutableState' } });
    expect(body.image!.WFItemType).toBe(ITEM_TYPE.dictionary);
    const image = fields(body.image!.WFValue.Value as Parameters<typeof fields>[0]);
    expect(image.base64!.WFValue).toEqual(variableText({ Type: 'ActionOutput', OutputName: 'Base64 Encoded', OutputUUID: encode.UUID }));
    expect(image.mediaType!.WFValue).toEqual(text('image/heic'));

    expect(describeRequest(workflow, { [KEY_VARIABLE]: 'KEY', 'Base64 Encoded': 'iVBORw0KGgo=' }).body).toEqual({
      sourceType: 'screenshot',
      sourceLabel: 'iPhone',
      shared: true,
      image: { base64: 'iVBORw0KGgo=', mediaType: 'image/heic' },
    });
  });
});

describe('the published files', () => {
  const files = import.meta.glob('../public/shortcuts/*.shortcut', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  it('are signed shortcuts, one for each, listed for the web app', () => {
    expect(Object.keys(files).sort()).toEqual(SHORTCUTS.map((s) => `../public/shortcuts/${s.file}`).sort());
    for (const content of Object.values(files)) expect(content.slice(0, 4)).toBe('AEA1');
    expect(manifest.shortcuts).toEqual(SHORTCUTS.map(({ id, name, file }) => ({ id, name, href: `/shortcuts/${file}` })));
    expect(new URL(manifest.appUrl).protocol).toBe('https:');
  });

  it('download as files named after each shortcut', () => {
    const rules = headers.split(/\n\s*\n/).map((block) => block.trim());
    const rule = (path: string) => rules.find((r) => r.split('\n').some((line) => line.trim() === path)) ?? '';
    for (const { name, file } of SHORTCUTS) {
      expect(rule(`/shortcuts/${file}`)).toContain('Content-Type: application/octet-stream');
      expect(rule(`/shortcuts/${file}`)).toContain(`Content-Disposition: attachment; filename="${name}.shortcut"`);
    }
  });

});

describe('the Witness a shortcut sends to', () => {
  it('is an https origin (or localhost)', () => {
    expect(captureUrl('https://witness.example.com')).toBe('https://witness.example.com/api/v1/capture');
    expect(captureUrl('http://localhost:8787')).toBe('http://localhost:8787/api/v1/capture');
    expect(() => captureUrl('http://witness.example.com')).toThrow(/https/);
    expect(() => captureUrl('https://witness.example.com/app')).toThrow(/origin/);
  });
});
