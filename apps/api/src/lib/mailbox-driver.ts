// Phase 10 — MailboxDriver interface.
//
// Abstracts provider-specific operations (send, watch, history-walk, token
// refresh) behind a single interface. Currently only the Google implementation
// exists; Outlook (Graph API) plugs in here when it's time.
//
// Services (sender-worker, warmup, reply-ingestion, gmail-watch) should call
// `getDriver(mailboxRow)` to get the right implementation for a given mailbox
// rather than hard-coding `sendGmailMessage` / `listGmailHistory` directly.
// For Phase 10, the services still call the Google helpers directly — the
// refactoring to route everything through the driver is a follow-up PR once
// a second provider is actually available. This file establishes the contract.

import type { GmailSendResult } from './gmail-send';
import type { GmailWatchResponse, GmailMessage, GmailHistoryListResponse } from './google';

export type SendInput = {
  accessToken: string;
  from: { email: string; displayName: string | null };
  to: string;
  subject: string;
  bodyText: string;
  inReplyToMessageId?: string | null;
  threadId?: string | null;
  unsubscribe?: { url: string; mailto: string } | null;
};

export type SendResult = {
  providerMessageId: string;
  providerThreadId: string;
  rfc822MessageId: string | null;
};

export type WatchResult = {
  historyId: string;
  expiresAt: Date;
};

export interface MailboxDriver {
  readonly provider: 'google' | 'microsoft' | 'smtp';

  /** Send a single message. */
  send(input: SendInput): Promise<SendResult>;

  /** Start a push notification watch (Pub/Sub for Google, subscriptions for Graph). */
  startWatch(accessToken: string, topic: string): Promise<WatchResult>;

  /** Stop a push notification watch. */
  stopWatch(accessToken: string): Promise<void>;

  /** Walk the history since `startId` and return new message IDs. */
  listHistory(
    accessToken: string,
    startId: string,
    pageToken?: string,
  ): Promise<{ messageIds: string[]; latestHistoryId: string; nextPageToken?: string }>;

  /** Fetch one message by ID. */
  fetchMessage(accessToken: string, messageId: string): Promise<GmailMessage>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google implementation
// ─────────────────────────────────────────────────────────────────────────────

import {
  sendGmailMessage,
} from './gmail-send';
import {
  startGmailWatch,
  stopGmailWatch,
  listGmailHistory,
  fetchGmailMessage,
} from './google';

export class GoogleMailboxDriver implements MailboxDriver {
  readonly provider = 'google' as const;

  async send(input: SendInput): Promise<SendResult> {
    const r: GmailSendResult = await sendGmailMessage(input);
    return {
      providerMessageId: r.id,
      providerThreadId: r.threadId,
      rfc822MessageId: r.rfc822MessageId,
    };
  }

  async startWatch(
    accessToken: string,
    topic: string,
  ): Promise<WatchResult> {
    const r: GmailWatchResponse = await startGmailWatch(accessToken, topic);
    return {
      historyId: r.historyId,
      expiresAt: new Date(Number(r.expiration)),
    };
  }

  async stopWatch(accessToken: string): Promise<void> {
    await stopGmailWatch(accessToken);
  }

  async listHistory(
    accessToken: string,
    startId: string,
    pageToken?: string,
  ): Promise<{
    messageIds: string[];
    latestHistoryId: string;
    nextPageToken?: string;
  }> {
    const r: GmailHistoryListResponse = await listGmailHistory(
      accessToken,
      startId,
      pageToken,
    );
    const ids: string[] = [];
    for (const entry of r.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) ids.push(added.message.id);
      }
    }
    return {
      messageIds: ids,
      latestHistoryId: r.historyId,
      nextPageToken: r.nextPageToken,
    };
  }

  async fetchMessage(
    accessToken: string,
    messageId: string,
  ): Promise<GmailMessage> {
    return fetchGmailMessage(accessToken, messageId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

const googleDriver = new GoogleMailboxDriver();

export function getDriver(provider: 'google' | 'microsoft' | 'smtp'): MailboxDriver {
  switch (provider) {
    case 'google':
      return googleDriver;
    case 'microsoft':
      throw new Error('Outlook driver not implemented yet — coming in a future release');
    case 'smtp':
      throw new Error('SMTP driver not implemented yet — coming in a future release');
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
