const winston = require('winston');
const path = require('path');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

const logger = winston.createLogger({
  level: process.env.DEBUG_MODE === 'true' ? 'debug' : 'info',
  format: logFormat,
  defaultMeta: { service: 'bearbet-tracker' },
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 10485760,
      maxFiles: 10,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/events.log'),
      level: 'info',
      maxsize: 10485760,
      maxFiles: 10,
    }),
  ],
});

// Em desenvolvimento, logar no console também
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: consoleFormat }));
} else {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    level: 'info',
  }));
}

module.exports = logger;
