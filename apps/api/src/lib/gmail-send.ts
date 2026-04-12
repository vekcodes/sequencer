// Gmail send helper. Pure fetch, no `googleapis` SDK — the surface we need
// (users.messages.send) is one endpoint. Keeps the dependency graph flat.
//
// Used by the Phase 6 sender-worker. Builds an RFC-822 message with the
// List-Unsubscribe + List-Unsubscribe-Post headers required by Google's
// bulk-sender guidelines (RFC 8058), and posts the base64url body to
// https://gmail.googleapis.com/gmail/v1/users/me/messages/send.

const GMAIL_SEND_URL =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export type GmailSendInput = {
  accessToken: string;
  from: {
    email: string;
    displayName: string | null;
  };
  to: string;
  subject: string;
  bodyText: string;
  /** Reply-in-thread: set to the root message's Message-ID (including angle brackets). */
  inReplyToMessageId?: string | null;
  /** Gmail thread ID — sibling to raw. Required when sending a follow-up in-thread. */
  threadId?: string | null;
  /** Pre-built unsubscribe URL + mailto pair, if unsubscribe is enabled for the campaign. */
  unsubscribe?: {
    url: string;
    mailto: string;
  } | null;
};

export type GmailSendResult = {
  /** Gmail's internal message id (not the RFC 822 Message-ID header). */
  id: string;
  threadId: string;
  /** Extracted from the returned payload.headers if present — needed for threading follow-ups. */
  rfc822MessageId: string | null;
};

export class GmailSendError extends Error {
  status: number;
  /** Normalized category so sender-worker can branch on retry vs bounce vs reconnect. */
  kind: 'invalid_grant' | 'rate_limited' | 'bad_recipient' | 'other';
  responseBody: string;
  constructor(
    status: number,
    kind: GmailSendError['kind'],
    responseBody: string,
    message?: string,
  ) {
    super(message ?? `Gmail send failed (${status}): ${responseBody.slice(0, 500)}`);
    this.status = status;
    this.kind = kind;
    this.responseBody = responseBody;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC 822 builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encodes a header value if it contains any non-ASCII byte. Uses RFC 2047
 * "encoded-word" with base64 so emojis and accents survive. Pure-ASCII
 * strings pass through unchanged (cheaper and human-readable on the wire).
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function formatFrom(from: GmailSendInput['from']): string {
  if (!from.displayName) return from.email;
  // Quote the display name if it contains commas, semicolons, quotes, etc.
  const needsQuote = /["(),:;<>@\[\\\]]/.test(from.displayName);
  const name = needsQuote
    ? `"${from.displayName.replace(/(["\\])/g, '\\$1')}"`
    : from.displayName;
  return `${encodeHeader(name)} <${from.email}>`;
}

function base64Url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generates an RFC 5322 Message-ID. Format: `<random@domain>` where domain is
 * taken from the From address so receivers see a sane value. The random part
 * uses crypto.randomUUID for collision resistance.
 */
export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] ?? 'localhost';
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * Builds an RFC-822 text/plain message. We deliberately avoid multipart —
 * Phase 6 only supports plain text (plainText=true is the default, and
 * deliverability-first). HTML + attachments land in Phase 10.
 */
export function buildRfc822(
  input: GmailSendInput,
  messageId: string,
): string {
  const lines: string[] = [];
  lines.push(`From: ${formatFrom(input.from)}`);
  lines.push(`To: ${input.to}`);
  lines.push(`Subject: ${encodeHeader(input.subject)}`);
  lines.push(`Message-ID: ${messageId}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 8bit');
  if (input.inReplyToMessageId) {
    lines.push(`In-Reply-To: ${input.inReplyToMessageId}`);
    lines.push(`References: ${input.inReplyToMessageId}`);
  }
  if (input.unsubscribe) {
    lines.push(
      `List-Unsubscribe: <${input.unsubscribe.url}>, <mailto:${input.unsubscribe.mailto}>`,
    );
    lines.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  lines.push('');
  // Normalize line endings to CRLF for RFC compliance.
  const body = input.bodyText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  lines.push(body);
  return lines.join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Send
// ─────────────────────────────────────────────────────────────────────────────

function classifyGmailError(status: number, body: string): GmailSendError['kind'] {
  const lower = body.toLowerCase();
  if (status === 401 || lower.includes('invalid_grant')) return 'invalid_grant';
  if (status === 429 || status === 403) return 'rate_limited';
  // Gmail returns 400 with "invalid to header" / "address not found" for bad recipients.
  if (
    status === 400 &&
    (lower.includes('invalid to header') ||
      lower.includes('recipient address rejected') ||
      lower.includes('address not found') ||
      lower.includes('no such user'))
  ) {
    return 'bad_recipient';
  }
  return 'other';
}

/**
 * POSTs a pre-built RFC-822 message to Gmail. Returns the Gmail id + threadId
 * and — if we can parse it back out of the response — the RFC 822 Message-ID
 * header, which we need to thread subsequent follow-ups.
 */
export async function sendGmailMessage(
  input: GmailSendInput,
): Promise<GmailSendResult> {
  const messageId = newMessageId(input.from.email);
  const rfc822 = buildRfc822(input, messageId);
  const raw = base64Url(rfc822);

  const payload: Record<string, unknown> = { raw };
  if (input.threadId) payload.threadId = input.threadId;

  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new GmailSendError(res.status, classifyGmailError(res.status, text), text);
  }

  const json = (await res.json()) as { id: string; threadId: string };

  return {
    id: json.id,
    threadId: json.threadId,
    // We already know the Message-ID we wrote into the headers — return it so
    // the caller can persist it as `first_message_id` for threading.
    rfc822MessageId: messageId,
  };
}
