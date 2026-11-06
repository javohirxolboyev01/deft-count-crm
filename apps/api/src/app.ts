import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { requireAuth, requireStaff } from './common/auth';
import { errorHandler } from './common/errors';
import { config } from './config';
import { pool } from './db';
import { authRouter, meRouter } from './modules/auth';
import { chatRouter } from './modules/chat';
import { clientsRouter } from './modules/clients';
import { auditRouter, dashboardRouter } from './modules/dashboard';
import { sseHandler } from './modules/events';
import { generatorRouter } from './modules/generator';
import { gridRouter } from './modules/grid';
import { leadsRouter } from './modules/leads';
import { notificationsRouter } from './modules/notifications';
import { settingsRouter } from './modules/settings';
import { sheetsRouter } from './modules/sheets/routes';
import { tasksRouter } from './modules/tasks';
import { transfersRouter } from './modules/taskTransfer';
import { usersRouter } from './modules/users';
import { worksRouter } from './modules/works';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // Chat fayllari (rasm, video, ovoz) brauzerga blob: URL sifatida beriladi (Authorization sarlavhasi bilan olinadi)
      contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'blob:'], 'media-src': ["'self'", 'blob:'] } },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    const r = await pool.query(`SELECT current_setting('TimeZone') AS tz`);
    res.json({ status: 'UP', db: 'UP', timezone: r.rows[0].tz, time: new Date().toISOString() });
  });

  // Buxgalteriya bo'limlari operatorga yopiq: u faqat /api/leads bilan ishlaydi (serverda, frontend yashirishiga tayanmay)
  const staff = [requireAuth, requireStaff];
  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/users', staff, usersRouter);
  app.use('/api/clients', staff, clientsRouter);
  app.use('/api/settings', staff, settingsRouter);
  app.use('/api/tasks', staff, tasksRouter);
  app.use('/api/task-transfers', staff, transfersRouter);
  app.use('/api/generator', staff, generatorRouter);
  app.use('/api/monthly-grid', staff, gridRouter);
  app.use('/api/works', staff, worksRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/dashboard', staff, dashboardRouter);
  app.use('/api/audit', staff, auditRouter);
  app.use('/api/sheets', staff, sheetsRouter);
  app.use('/api/leads', leadsRouter);
  // Chat hamma rol uchun (operator ham): ruxsat — faqat o'z yozishmalari (router ichida)
  app.use('/api/chat', chatRouter);
  app.get('/api/events', sseHandler);

  app.use('/api', (_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Endpoint topilmadi', details: null });
  });

  // Prod: frontend build'i (apps/web/dist) shu serverdan beriladi — bitta origin,
  // shuning uchun refresh cookie (sameSite=strict) va SSE CORS'siz ishlaydi.
  if (config.isProd) {
    const webDist = path.resolve(__dirname, '../../web/dist');
    if (fs.existsSync(webDist)) {
      // Vite assets nomida hash bor — uzoq keshlash xavfsiz; qolganlari (favicon, rasmlar) oddiy
      app.use('/assets', express.static(path.join(webDist, 'assets'), { maxAge: '1y', immutable: true }));
      app.use(express.static(webDist, { index: false }));
      // SPA: /api bo'lmagan GET so'rovlar index.html'ga (React Router)
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(webDist, 'index.html'));
      });
    }
  }
  app.use(errorHandler);
  return app;
}
