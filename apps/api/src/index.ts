import { env, isGoogleOAuthConfigured } from './lib/env'; // must be first — loads .env
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { authMiddleware, type AuthVariables } from './middleware/auth';
import { authRoutes } from './routes/auth';
import { oauthRoutes } from './routes/oauth';
import { mailboxRoutes } from './routes/mailboxes';
import { adminRoutes } from './routes/admin';
import { leadsRoutes } from './routes/leads';
import { leadListsRoutes } from './routes/lead-lists';
import { blocklistRoutes } from './routes/blocklist';
import { campaignsRoutes } from './routes/campaigns';
import { statsRoutes } from './routes/stats';
import { repliesRoutes } from './routes/replies';
import { webhooksRoutes } from './routes/webhooks';
import { pubsubRoutes } from './routes/pubsub';
import { unsubscribeRoutes } from './routes/unsubscribe';
import { customVariablesRoutes } from './routes/custom-variables';
import { startHealthScheduler } from './lib/health-scheduler';
import { startSendScheduler } from './lib/send-scheduler';
import { startReplyScheduler } from './lib/reply-scheduler';
import { startWarmupScheduler } from './lib/warmup-scheduler';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const app = new Hono<{ Variables: AuthVariables }>();

app.use('*', logger());
app.use(
  '/api/*',
  cors({
    origin: env.WEB_ORIGIN,
    credentials: true,
  }),
);
app.use('/api/*', authMiddleware);

app.get('/api/health', (c) =>
  c.json({
    ok: true as const,
    service: 'ces-api',
    version: '0.0.0',
    env: env.NODE_ENV,
    googleOAuthConfigured: isGoogleOAuthConfigured(),
  }),
);

app.route('/api/auth', authRoutes);
app.route('/api/auth', oauthRoutes); // /api/auth/google/start, /callback
app.route('/api/mailboxes', mailboxRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/leads', leadsRoutes);
app.route('/api/lead-lists', leadListsRoutes);
app.route('/api/blocklist', blocklistRoutes);
app.route('/api/campaigns', campaignsRoutes);
app.route('/api/stats', statsRoutes);
app.route('/api/replies', repliesRoutes);
app.route('/api/webhooks', webhooksRoutes);
app.route('/api/custom-variables', customVariablesRoutes);
// Pub/Sub push endpoint is mounted at root (no /api prefix and no auth middleware).
app.route('/pubsub', pubsubRoutes);
// Unsubscribe endpoint is public — hit by email recipients.
app.route('/unsub', unsubscribeRoutes);

// ─── Production: serve the built Vite frontend ──────────────────
// In dev, Vite's dev server handles this. In production, the API serves
// the static build and falls back to index.html for client-side routing.
if (env.NODE_ENV === 'production') {
  const webDist = resolve(process.cwd(), 'apps/web/dist');
  if (existsSync(webDist)) {
    app.use('/*', serveStatic({ root: './apps/web/dist' }));
    // SPA fallback: any non-API, non-file request gets index.html
    app.get('*', (c) => {
      const html = readFileSync(resolve(webDist, 'index.html'), 'utf-8');
      return c.html(html);
    });
  }
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ces-api listening on http://localhost:${info.port}`);
  if (!isGoogleOAuthConfigured()) {
    // eslint-disable-next-line no-console
    console.log(
      '  ⚠ Google OAuth is not configured — /api/auth/google/* will return 503',
    );
  }
  startHealthScheduler();
  startSendScheduler();
  startReplyScheduler();
  startWarmupScheduler();
});
