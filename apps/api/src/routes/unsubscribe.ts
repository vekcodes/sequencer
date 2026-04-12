import { Hono } from 'hono';
import { parseUnsubToken, processUnsubscribe } from '../services/unsubscribe';

// Public routes — no auth. These are hit by email recipients clicking the
// List-Unsubscribe link or the one-click POST from Gmail's UI.

export const unsubscribeRoutes = new Hono();

const PAGE_STYLE = `
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         display:flex;align-items:center;justify-content:center;min-height:100vh;
         background:#f6f7fb;color:#1a1f2b;padding:2rem}
    .card{background:#fff;border-radius:12px;padding:2.5rem;max-width:420px;
          text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
    h2{font-size:1.35rem;margin-bottom:0.75rem}
    p{color:#6b7280;font-size:0.95rem;line-height:1.5}
    .icon{font-size:2.5rem;margin-bottom:1rem}
    .error .icon{color:#ef4444}
    .success .icon{color:#10b981}
  </style>
`;

function htmlPage(icon: string, title: string, message: string, kind: 'success' | 'error') {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${PAGE_STYLE}</head>
<body><div class="card ${kind}"><div class="icon">${icon}</div><h2>${title}</h2><p>${message}</p></div></body></html>`;
}

/**
 * POST /unsub/:token — RFC 8058 one-click unsubscribe.
 * Gmail sends: POST with body `List-Unsubscribe=One-Click`.
 */
unsubscribeRoutes.post('/:token', async (c) => {
  const parsed = parseUnsubToken(c.req.param('token'));
  if (!parsed) return c.text('Invalid or expired link.', 400);
  const result = await processUnsubscribe(parsed.campaignId, parsed.leadId);
  if (!result.ok) return c.text('Unsubscribe failed.', 400);
  return c.text('You have been unsubscribed.');
});

/**
 * GET /unsub/:token — browser-friendly fallback for recipients who click
 * the unsubscribe link in their mail client.
 */
unsubscribeRoutes.get('/:token', async (c) => {
  const parsed = parseUnsubToken(c.req.param('token'));
  if (!parsed) {
    return c.html(
      htmlPage(
        '\u26A0\uFE0F',
        'Invalid Link',
        'This unsubscribe link is invalid or has expired. If you believe this is an error, please contact the sender directly.',
        'error',
      ),
      400,
    );
  }
  const result = await processUnsubscribe(parsed.campaignId, parsed.leadId);
  if (!result.ok) {
    return c.html(
      htmlPage(
        '\u26A0\uFE0F',
        'Something went wrong',
        'We couldn\'t process your unsubscribe request. Please try again later or contact the sender directly.',
        'error',
      ),
      500,
    );
  }
  return c.html(
    htmlPage(
      '\u2705',
      'Unsubscribed',
      'You have been successfully unsubscribed and will no longer receive emails from this campaign.',
      'success',
    ),
  );
});
