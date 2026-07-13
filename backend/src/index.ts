import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';

import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import creatorRoutes from './routes/creators';
import contentRoutes from './routes/content';
import subscriptionRoutes from './routes/subscriptions';
import chatRoutes from './routes/chat';

import { connectDB, disconnectDB } from './config/database';
import { setupSocketHandlers } from './socket/chatHandlers';
import { logger, registerProcessErrorHandlers } from './utils/logger';
import { cache } from './utils/cache';

dotenv.config();
registerProcessErrorHandlers();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

connectDB();

// Middleware
app.use(helmet());
app.use(compression()); // gzip de las respuestas -> menos ancho de banda bajo carga
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging de cada request (nivel http para no ensuciar logs de negocio)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.http('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// Rate limiting general (lectura) - generoso
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Demasiadas peticiones desde esta IP, por favor intenta más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting estricto para auth (frena fuerza bruta de login/registro)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Demasiados intentos de autenticación, espera unos minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth', authLimiter);
app.use('/api/', generalLimiter);

// Rutas API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/creators', creatorRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/chat', chatRoutes);

// Servir archivos estáticos para contenido subido
app.use('/uploads', express.static('uploads'));

// Health check: separado de /api para que un load balancer o k8s
// pueda chequear salud sin contar contra el rate limit de negocio.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: process.uptime(),
    cache: cache.stats(),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Manejo de errores centralizado
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Error no capturado en request', {
    message: err.message,
    stack: err.stack,
    path: req.path,
  });
  res.status(500).json({
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Algo salió mal'
  });
});

setupSocketHandlers(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Servidor corriendo en puerto ${PORT}`, {
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
    env: process.env.NODE_ENV || 'development',
  });
});

// Apagado ordenado: deja de aceptar conexiones nuevas, cierra sockets y Mongo
// antes de morir. Sin esto, un restart/deploy corta requests a la mitad.
async function gracefulShutdown(signal: string) {
  logger.info(`Señal ${signal} recibida, cerrando servidor de forma ordenada...`);
  server.close(async () => {
    await disconnectDB();
    logger.info('Servidor cerrado. Adiós.');
    process.exit(0);
  });

  // Si algo se cuelga, forzar salida a los 10s
  setTimeout(() => {
    logger.error('No se pudo cerrar ordenadamente a tiempo, forzando salida');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
