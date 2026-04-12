// LLM-powered reply classification using Claude via the Anthropic SDK.
//
// When ANTHROPIC_API_KEY is set, this replaces the rule-based classifier in
// reply-ingestion. Falls back gracefully to the rule-based result if the API
// call fails or times out.

import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import type { ReplyClassification } from '../services/reply-ingestion';

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export function isLlmClassifierAvailable(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

const SYSTEM_PROMPT = `You are a cold-email reply classifier for a sales outreach platform. Your job is to classify inbound email replies into exactly one of these categories:

- **interested**: The prospect shows positive intent — wants to learn more, schedule a call, asks questions about the product/offer, or gives a warm response.
- **not_interested**: The prospect explicitly declines — says no, not a fit, already has a solution, asks to stop emailing, or wants to unsubscribe.
- **neutral**: The prospect replies but without clear positive or negative intent — acknowledges receipt, asks a clarifying question without enthusiasm, or gives a noncommittal response.
- **auto_reply**: The message is an automated out-of-office reply, vacation responder, system notification, delivery failure (bounce/DSN), mailer-daemon message, or any non-human-written response.

Respond with ONLY one of these exact words: interested, not_interested, neutral, auto_reply

Do not explain your reasoning. Just output the single classification word.`;

/**
 * Classifies a reply using Claude. Returns null if the LLM is unavailable or
 * the call fails — the caller should fall back to the rule-based classifier.
 */
export async function classifyWithLlm(
  subject: string,
  body: string,
  fromEmail: string,
): Promise<ReplyClassification | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  const userMessage = [
    `From: ${fromEmail}`,
    `Subject: ${subject}`,
    '',
    body.slice(0, 2000), // Cap body to avoid blowing tokens on very long emails
  ].join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text =
      response.content[0]?.type === 'text'
        ? response.content[0].text.trim().toLowerCase()
        : '';

    const valid: ReplyClassification[] = [
      'interested',
      'not_interested',
      'neutral',
      'auto_reply',
    ];
    if (valid.includes(text as ReplyClassification)) {
      return text as ReplyClassification;
    }

    // LLM returned something unexpected — fall back.
    // eslint-disable-next-line no-console
    console.warn(`[llm-classifier] unexpected response: "${text}"`);
    return null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[llm-classifier] API call failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
