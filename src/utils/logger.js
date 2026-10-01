'use strict';

/**
 * Минимальный логгер с уровнями.
 *
 * Собственная реализация выбрана сознательно: для учебного проекта
 * подключение сторонней библиотеки логирования избыточно, а формат вывода
 * полностью контролируется.
 */

const config = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const currentLevel = LEVELS[config.logging.level] ?? LEVELS.info;

/** Приводит значение к строке, не падая на объектах и циклических ссылках. */
function formatValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level, args) {
  if (LEVELS[level] > currentLevel) return;
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level.toUpperCase().padEnd(5)}] ${args.map(formatValue).join(' ')}`;
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

module.exports = {
  error: (...args) => write('error', args),
  warn: (...args) => write('warn', args),
  info: (...args) => write('info', args),
  debug: (...args) => write('debug', args),
  level: config.logging.level,
};
