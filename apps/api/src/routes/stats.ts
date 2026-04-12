import { Hono } from 'hono';
import { requireAuth, type AuthVariables } from '../middleware/auth';
import { getDashboardStats } from '../services/stats';

export const statsRoutes = new Hono<{ Variables: AuthVariables }>();
statsRoutes.use('*', requireAuth);

statsRoutes.get('/dashboard', async (c) => {
  const user = c.get('user')!;
  const daysRaw = Number(c.req.query('days') ?? '10');
  const days =
    Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90
      ? Math.floor(daysRaw)
      : 10;
  const stats = await getDashboardStats(user.workspaceId, days);
  return c.json(stats);
});
