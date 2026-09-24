// Types for workflow.mjs, so the web app's tests can import it.

export interface ShortcutFile {
  id: 'text' | 'image';
  name: string;
  file: string;
}

export interface WorkflowAction {
  WFWorkflowActionIdentifier: string;
  // Parameters differ per action; tests read them as the plist has them.
  WFWorkflowActionParameters: Record<string, any>;
}

export interface ImportQuestion {
  ActionIndex: number;
  Category: string;
  DefaultValue: string;
  ParameterKey: string;
  Text: string;
}

export interface Workflow {
  WFWorkflowActions: WorkflowAction[];
  WFWorkflowImportQuestions: ImportQuestion[];
  WFWorkflowTypes: string[];
  WFWorkflowInputContentItemClasses: string[];
  WFWorkflowNoInputBehavior?: { Name: string; Parameters: Record<string, unknown> };
  [key: string]: unknown;
}

export interface ShortcutRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  bodyType: string;
  body: Record<string, unknown>;
}

export declare const DEFAULT_APP_URL: string;
export declare const KEY_VARIABLE: string;
export declare const CAPTURE_PATH: string;
export declare const SHORTCUTS: readonly ShortcutFile[];
export declare const KEY_QUESTION: string;
export declare const NOTICES: { saved: string; maybe: string; failed: string };
export declare const ITEM_TYPE: { text: 0; dictionary: 1; array: 2; number: 3; boolean: 4 };
export declare const BUILDERS: Record<ShortcutFile['id'], (options?: { appUrl?: string }) => Workflow>;

export declare function captureUrl(appUrl: string): string;
export declare function textShortcut(options?: { appUrl?: string }): Workflow;
export declare function imageShortcut(options?: { appUrl?: string }): Workflow;
export declare function readText(state: unknown, values: Record<string, string>): string;
export declare function readDictionary(state: unknown, values: Record<string, string>): Record<string, unknown>;
export declare function describeRequest(workflow: Workflow, values: Record<string, string>): ShortcutRequest;
export declare function toPlistXml(value: unknown): string;
