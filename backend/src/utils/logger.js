const winston = require('winston');
const path = require('path');

const SPLAT = Symbol.for('splat');
function extras(info) {
  const rest = info[SPLAT];
  if (!rest || !rest.length) return '';
  return ' ' + rest.map(a => (a instanceof Error ? a.stack : typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
      const { timestamp, level, message, stack } = info;
      return `${timestamp} [${level.toUpperCase()}] ${message}${extras(info)}${stack ? '\n' + stack : ''}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) =>
          `${info.timestamp} ${info.level}: ${info.message}${extras(info)}`)
      )
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log')
    })
  ]
});

module.exports = logger;
