'use strict';

/**
 * Конфигурация приложения.
 *
 * Все настройки читаются из переменных окружения (файл .env, см. .env.example),
 * поэтому один и тот же код работает в режимах разработки, тестирования
 * и опытной эксплуатации без правок исходников.
 */

const path = require('path');
const fs = require('fs');

// Корень проекта — на два уровня выше каталога src/config
const ROOT_DIR = path.resolve(__dirname, '..', '..');

// Загружаем .env до чтения переменных окружения.
// quiet: true — библиотека dotenv не выводит служебное сообщение о загрузке файла.
require('dotenv').config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

/** Читает целое число из переменной окружения с проверкой. */
function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`Некорректное значение переменной окружения ${name}: "${raw}" (ожидается целое число)`);
  }
  return value;
}

/** Читает булево значение из переменной окружения. */
function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Читает строку из переменной окружения. */
function readString(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw.trim();
}

const nodeEnv = readString('NODE_ENV', 'development');
const dbFile = readString('DB_FILE', './data/pvh.db');

const config = {
  /** Абсолютный путь к корню проекта */
  rootDir: ROOT_DIR,

  /** Версия сборки (совпадает с version в package.json) */
  version: require(path.join(ROOT_DIR, 'package.json')).version,

  /** Имя приложения — используется в логах и ответах API */
  appName: 'Сервис трекинга заказов и инвентаря для ПВЗ',

  env: nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',

  server: {
    port: readInt('PORT', 3000),
    host: readString('HOST', '127.0.0.1'),
  },

  database: {
    /** ':memory:' для тестов либо абсолютный путь к файлу БД */
    file: dbFile === ':memory:' ? ':memory:' : path.resolve(ROOT_DIR, dbFile),
    verbose: readBool('DB_VERBOSE', false),
    autoMigrate: readBool('DB_AUTO_MIGRATE', true),
    /** Каталог с SQL-миграциями */
    migrationsDir: path.join(__dirname, '..', 'db', 'migrations'),
  },

  logging: {
    level: readString('LOG_LEVEL', nodeEnv === 'test' ? 'error' : 'info'),
  },

  /** Адрес приложения — используется для ссылок в письмах. */
  appBaseUrl: readString('APP_BASE_URL', `http://127.0.0.1:${readInt('PORT', 3000)}`),

  /**
   * Настройки отправки почты.
   *
   * Режимы работы (параметр MAIL_TRANSPORT):
   *   log  — письмо не отправляется, а выводится в журнал (режим по умолчанию;
   *          позволяет проверять регистрацию без реального почтового ящика);
   *   smtp — письмо отправляется через почтовый сервер по протоколу SMTP.
   */
  mail: {
    transport: readString('MAIL_TRANSPORT', 'log').toLowerCase(),

    /** Учётные данные и адрес отправителя */
    fromName: readString('MAIL_FROM_NAME', 'Сервис трекинга заказов и инвентаря для ПВЗ'),
    fromAddress: readString('MAIL_FROM', 'no-reply@pvh-service.local'),
    replyTo: readString('MAIL_REPLY_TO', ''),

    smtp: {
      host: readString('SMTP_HOST', ''),
      port: readInt('SMTP_PORT', 465),
      /** Неявное шифрование TLS (порт 465 — true, порт 587 — false) */
      secure: readBool('SMTP_SECURE', true),
      /** Запрещать работу без шифрования */
      requireTls: readBool('SMTP_REQUIRE_TLS', false),
      user: readString('SMTP_USER', ''),
      password: readString('SMTP_PASSWORD', ''),
      /** Таймаут ожидания ответа почтового сервера, мс */
      timeout: readInt('SMTP_TIMEOUT', 20000),
    },

    /** Срок действия ссылки подтверждения, часов */
    confirmTokenTtlHours: readInt('MAIL_CONFIRM_TTL_HOURS', 24),
  },

  /** Настройки сессий авторизации. */
  session: {
    /** Срок действия сессии, часов (по умолчанию 7 суток) */
    ttlHours: readInt('SESSION_TTL_HOURS', 168),
  },

  /** Учётная запись администратора для начальной настройки (npm run seed). */
  seed: {
    adminEmail: readString('ADMIN_EMAIL', 'admin@pvh.local'),
    adminName: readString('ADMIN_NAME', 'Администратор ПВЗ'),
    adminPassword: readString('ADMIN_PASSWORD', ''),
  },

  /** Каталог со статическими файлами клиентской части (добавится на 9-й день) */
  publicDir: path.join(ROOT_DIR, 'public'),
};

// Создаём каталог для файла БД заранее, иначе SQLite не сможет его открыть
if (config.database.file !== ':memory:') {
  fs.mkdirSync(path.dirname(config.database.file), { recursive: true });
}

module.exports = config;
