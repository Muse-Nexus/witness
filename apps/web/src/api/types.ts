// Wire types for the core REST API (docs/dev/SPEC.md §8 and §10.1).
// Keep these in step with apps/core; they are the web app's half of the contract.

export type Category =
  | 'love'
  | 'care'
  | 'pride'
  | 'gratitude'
  | 'trust'
  | 'belonging'
  | 'accomplishment'
  | 'recovery'
  | 'other';

export type ItemStatus = 'saved' | 'maybe' | 'removed';
export type ItemKind = 'text' | 'image' | 'mixed';
export type SourceType = 'email' | 'text' | 'photo' | 'screenshot' | 'manual' | 'agent' | 'import';

export interface Item {
  id: string;
  status: ItemStatus;
  kind: ItemKind;
  /** The other person's exact words. Never rewritten by Witness. */
  quote: string | null;
  context: string | null;
  fromName: string | null;
  occurredAt: number | null;
  sourceType: SourceType;
  sourceLabel: string;
  category: Category;
  /**
   * False when nothing sorted the item (the detector did not keep its words and the person
   * chose no kind). `category` is then "other" only so it is always a valid value: show no kind.
   */
  categoryKnown?: boolean;
  edited: boolean;
  mediaType: string | null;
  /** Optional; when absent the client uses `/api/v1/items/:id/media`. */
  mediaUrl?: string | null;
  /** False when Witness does not know who sent it (manual adds, photos), so "never save from" cannot apply. */
  canBlockSender?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ItemPage {
  items: Item[];
  nextCursor: string | null;
}

export interface ItemQuery {
  status?: 'saved' | 'maybe';
  cursor?: string;
  limit?: number;
  q?: string;
}

export interface ImageUpload {
  base64: string;
  mediaType: string;
}

export interface NewItem {
  quote?: string;
  fromName?: string;
  occurredAt?: number;
  image?: ImageUpload;
}

export interface ItemPatch {
  status?: ItemStatus;
  /** null puts the item back to unsorted: it then shows no kind. */
  category?: Category | null;
  fromName?: string | null;
  occurredAt?: number | null;
  quote?: string;
}

export interface Me {
  email: string;
  displayName: string | null;
  timezone: string;
  inboundAddress: string;
  createdAt: number;
}

export interface MePatch {
  displayName?: string | null;
  timezone?: string;
}

export interface SourceHealth {
  type: SourceType;
  lastAt: number | null;
  count7d: number;
}

export interface Status {
  saved: number;
  maybe: number;
  /** Saved items an email can show (not an image-only HEIC photo). */
  deliverable: number;
  lastCapturedAt: number | null;
  sources: SourceHealth[];
  rhythm: { enabled: boolean; nextAt: number | null; pausedUntil: number | null };
}

/** `GET /api/v1/config`: how this Witness is run. Public and content-free; never about any person. */
export interface PublicConfig {
  /** 'invite': only invited addresses can make an account, and nobody is told whether an address is invited. */
  signups: 'open' | 'invite';
  /** Whether the optional AI check for messages Witness is unsure about is on. */
  aiCheck: boolean;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface RhythmSettings {
  enabled: boolean;
  /** 24-hour "HH:MM" in `timezone`. */
  localTime: string;
  days: Weekday[];
  timezone: string;
  channel: 'email';
}

export interface Rhythm extends RhythmSettings {
  consentedAt?: number | null;
  pausedUntil?: number | null;
  nextAt?: number | null;
}

export interface SendNowResult {
  /** False when there was nothing to send. Witness never sends an empty message. */
  sent: boolean;
  /**
   * Why nothing was sent. nothing_qualifies: nothing kept yet. all_recent: things are kept,
   * all sent recently. send_failed: the mail provider failed. in_progress: another one is
   * being sent to this person at this moment.
   */
  reason?: 'nothing_qualifies' | 'all_recent' | 'send_failed' | 'in_progress';
}

export type TokenKind = 'agent' | 'device';

export interface TokenSummary {
  id: string;
  kind: TokenKind;
  label: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt?: number | null;
}

export interface McpConfigs {
  claudeCode: string;
  codex: string;
  json: string;
  /** A read-only status check: only for a key with the `status` scope (others get 403 from it). */
  curl?: string;
}

/**
 * What core returns with a new token. Assistant tokens get the three MCP configs; device
 * tokens only `captureUrl`. Either gets `curl` only when it may read status.
 */
export interface TokenConfigs extends Partial<McpConfigs> {
  mcpUrl?: string;
  captureUrl?: string;
}

/** Returned once, on creation. The plaintext token is never shown again. */
export interface CreatedToken extends TokenSummary {
  token: string;
  configs?: TokenConfigs;
}

export interface NewToken {
  label: string;
  kind: TokenKind;
  scopes?: string[];
}

export interface InboundAddress {
  address: string;
  verifiedAt: number | null;
  /** The sign-in email, which always stays on the list. */
  isAccountEmail?: boolean;
}

export interface ForwardingConfirmation {
  provider: string;
  url?: string | null;
  code?: string | null;
  receivedAt: number;
}

export interface BlockedSender {
  senderKey: string;
  createdAt: number;
  /** A display label if core kept one. Senders are stored as keyed hashes, never plaintext. */
  label?: string | null;
}

/** `POST /api/v1/items/:id/block-sender`: every item already kept from that sender is removed too. */
export interface BlockSenderResult {
  ok?: boolean;
  removed?: number;
  removedIds?: string[];
}

/** How many kept things came from an item's sender (this one included). */
export interface SenderCount {
  count: number;
  fromName: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
