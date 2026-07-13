import winston from 'winston'
import path from 'path'

const { combine, timestamp, printf, colorize, errors, json } = winston.format

const isProd = process.env.NODE_ENV === 'production'

// Formato legible para consola (dev)
const consoleFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
    return `${timestamp} [${level}] ${stack || message}${metaStr}`
  })
)

// Formato JSON estructurado para producción (parseable por agregadores tipo Datadog/ELK)
const jsonFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
)

const logsDir = path.join(__dirname, '..', '..', 'logs')

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  format: isProd ? jsonFormat : consoleFormat,
  defaultMeta: { service: 'super-hot-backend' },
  transports: [
    new winston.transports.Console(),
    // En producción además persistimos a archivo con rotación por tamaño
    ...(isProd
      ? [
          new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5,
          }),
          new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5,
          }),
        ]
      : []),
  ],
  exitOnError: false,
})

// Captura de errores no manejados para que el proceso no muera en silencio
export function registerProcessErrorHandlers() {
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection', { reason })
  })

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception - cerrando proceso de forma ordenada', {
      message: err.message,
      stack: err.stack,
    })
    // Dejamos que un process manager (PM2/systemd/k8s) reinicie el proceso
    process.exit(1)
  })
}
