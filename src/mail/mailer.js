'use strict';

/**
 * Сервис отправки почты.
 *
 * Поддерживаются два режима работы (параметр MAIL_TRANSPORT в файле .env):
 *
 *   log  — письмо не отправляется, а выводится в журнал. Режим используется
 *          при разработке и на защите проекта: регистрацию и подтверждение
 *          адреса электронной почты можно проверить без реального почтового
 *          ящика и без риска попадания писем в чужую почту.
 *
 *   smtp — письмо отправляется через почтовый сервер по протоколу SMTP
 *          (используется собственная реализация SMTP-клиента).
 *
 * Ошибка отправки не прерывает регистрацию пользователя: учётная запись уже
 * создана в базе данных, а повторная регистрация на тот же адрес запрещена.
 * Пользователь получает уведомление о неудаче и может запросить письмо повторно.
 */

const config = require('../config');
const logger = require('../utils/logger');
const { SmtpClient, SmtpError } = require('./smtpClient');
const apiMailer = require('./apiMailer');

/**
 * Сбрасывает кэш настроек.
 *
 * Функция предназначена только для тестов: в них номер порта тестового
 * почтового сервера становится известен лишь после его запуска, поэтому
 * конфигурацию требуется перечитать заново.
 *
 * @param {object} [overrides] значения переменных окружения, задаваемые перед перечитыванием
 */
function resetForTests(overrides) {
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === null) delete process.env[key];
      else process.env[key] = String(value);
    }
  }

  // Удаляем модуль конфигурации из кэша, чтобы он прочитал переменные заново
  const configPath = require.resolve('../config');
  delete require.cache[configPath];

  // Перечитываем настройки в этом модуле
  Object.assign(config, require('../config'));
}

/** Результат отправки письма. */
const DELIVERY_STATUS = {
  SENT: 'sent',         // письмо передано почтовому серверу
  LOGGED: 'logged',     // письмо выведено в журнал (режим log)
  SKIPPED: 'skipped',   // отправка отключена в настройках
  FAILED: 'failed',     // отправка не удалась
};

/**
 * Проверяет, что обязательные настройки SMTP заполнены.
 *
 * Обязателен только адрес сервера: логин и пароль могут отсутствовать, если
 * используется внутренний сервер пересылки или локальный сервер для проверки
 * (аутентификация в этом случае не выполняется).
 *
 * @returns {{ok: boolean, missing: string[]}}
 */
function checkSmtpSettings() {
  const { host } = config.mail.smtp;
  const missing = [];
  if (!host) missing.push('SMTP_HOST');
  return { ok: missing.length === 0, missing };
}

/** Возвращает текущий режим отправки почты. */
function getTransport() {
  const mode = config.mail.transport;
  if (!['log', 'smtp', 'api'].includes(mode)) {
    logger.warn(`Неизвестный режим отправки почты «${mode}», используется режим log`);
    return 'log';
  }

  // Если выбран режим smtp, но адрес сервера не указан, работаем в режиме log
  if (mode === 'smtp' && !checkSmtpSettings().ok) {
    logger.warn('Режим отправки smtp выбран, но адрес почтового сервера не указан '
      + '(SMTP_HOST) — письма будут выводиться в журнал');
    return 'log';
  }

  // То же для отправки через HTTPS-API: без ключа и сервиса письма не уйдут
  if (mode === 'api' && !apiMailer.checkApiSettings().ok) {
    logger.warn('Режим отправки api выбран, но настройки не заполнены '
      + `(${apiMailer.checkApiSettings().missing.join(', ')}) — `
      + 'письма будут выводиться в журнал');
    return 'log';
  }

  return mode;
}

/**
 * Выводит письмо в журнал — используется в режиме log.
 * Текст письма приводится полностью, чтобы его можно было прочитать в консоли.
 */
function logEmail({ to, subject, text, html }) {
  const line = '='.repeat(78);
  logger.info(line);
  logger.info('ПИСЬМО (режим вывода в журнал, отправка не выполняется)');
  logger.info(`Кому:    ${to.address}${to.name ? ` (${to.name})` : ''}`);
  logger.info(`От:      ${config.mail.fromAddress}`);
  logger.info(`Тема:    ${subject}`);
  logger.info(`Формат:  обычный текст${html ? ' и HTML' : ''}`);
  logger.info('-'.repeat(78));
  for (const textLine of String(text).split('\n')) {
    logger.info(`| ${textLine}`);
  }
  logger.info(line);
}

/**
 * Отправляет письмо.
 *
 * @param {{to: {address: string, name?: string}, subject: string,
 *          text: string, html?: string}} letter
 * @returns {Promise<{status: string, messageId: string|null, error: string|null}>}
 */
async function sendMail(letter) {
  const transport = getTransport();
  const from = { address: config.mail.fromAddress, name: config.mail.fromName };
  const replyTo = config.mail.replyTo || undefined;

  if (transport === 'log') {
    logEmail(letter);
    logger.info(`Письмо для ${letter.to.address} выведено в журнал (режим log)`);
    return { status: DELIVERY_STATUS.LOGGED, messageId: null, error: null };
  }

  // Отправка через HTTPS-API почтового сервиса: применяется, когда
  // протокол SMTP блокируется провайдером
  if (transport === 'api') {
    return apiMailer.sendMail(letter);
  }

  const client = new SmtpClient({
    host: config.mail.smtp.host,
    port: config.mail.smtp.port,
    secure: config.mail.smtp.secure,
    requireTls: config.mail.smtp.requireTls,
    user: config.mail.smtp.user,
    password: config.mail.smtp.password,
    clientName: config.appBaseUrl.replace(/^https?:\/\//, '').split(':')[0] || 'localhost',
  });

  try {
    await client.connect();
    const result = await client.sendMail({
      from,
      to: letter.to,
      subject: letter.subject,
      text: letter.text,
      html: letter.html,
      replyTo,
    });

    logger.info(`Письмо отправлено на ${letter.to.address} `
      + `(сервер ${config.mail.smtp.host}:${config.mail.smtp.port}, размер ${result.envelope.size} байт)`);

    return { status: DELIVERY_STATUS.SENT, messageId: result.messageId, error: null };
  } catch (error) {
    const reason = error instanceof SmtpError
      ? error.message
      : `непредвиденная ошибка: ${error.message}`;

    logger.error(`Не удалось отправить письмо на ${letter.to.address}: ${reason}`);
    return { status: DELIVERY_STATUS.FAILED, messageId: null, error: reason };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Отправляет письмо с ссылкой подтверждения адреса электронной почты.
 *
 * @param {{name: string, email: string, token: string}} user
 * @returns {Promise<{status: string, messageId: string|null, error: string|null, confirmUrl: string}>}
 */
async function sendConfirmationEmail({ name, email, token }) {
  // Ссылка ведёт на эндпоинт подтверждения (будет реализован на 6-м дне)
  const confirmUrl = `${config.appBaseUrl}/api/auth/confirm?token=${encodeURIComponent(token)}`;

  const { confirmationEmail } = require('./emailTemplates');
  const letter = confirmationEmail({
    name,
    email,
    confirmUrl,
    token,
    expiresInHours: config.mail.confirmTokenTtlHours,
  });

  const result = await sendMail({
    to: { address: email, name },
    subject: letter.subject,
    text: letter.text,
    html: letter.html,
  });

  return { ...result, confirmUrl };
}

/**
 * Отправляет клиенту письмо о поступлении заказа в пункт выдачи
 * (шаблон подготовлен на 5-м дне, отправка подключена на 14-м).
 *
 * @param {{name: string, email: string, trackNumber: string,
 *          cellNumber: number, description?: string|null}} data
 * @returns {Promise<{status: string, messageId: string|null, error: string|null}>}
 */
async function sendOrderReceivedEmail({ name, email, trackNumber, cellNumber, description }) {
  const { orderReceivedEmail } = require('./emailTemplates');
  const letter = orderReceivedEmail({ name, trackNumber, cellNumber, description });

  return sendMail({
    to: { address: email, name },
    subject: letter.subject,
    text: letter.text,
    html: letter.html,
  });
}

/**
 * Проверяет соединение с почтовым сервером (используется диагностикой).
 * @returns {Promise<{ok: boolean, mode: string, error: string|null, capabilities: string[]}>}
 */
async function verifyConnection() {
  const transport = getTransport();

  if (transport === 'log') {
    return {
      ok: true,
      mode: 'log',
      error: null,
      capabilities: [],
    };
  }

  // Проверка отправки через HTTPS-API
  if (transport === 'api') {
    const result = await apiMailer.verifyConnection();
    return {
      ok: result.ok,
      mode: 'api',
      error: result.error,
      capabilities: result.provider ? [`Сервис: ${result.provider}`] : [],
    };
  }

  const client = new SmtpClient({
    host: config.mail.smtp.host,
    port: config.mail.smtp.port,
    secure: config.mail.smtp.secure,
    requireTls: config.mail.smtp.requireTls,
    user: config.mail.smtp.user,
    password: config.mail.smtp.password,
  });

  try {
    await client.connect();
    await client.authenticate();

    const capabilities = client.capabilities || [];
    const capabilitiesText = capabilities.join(' ');

    // Сервер может принять соединение без проверки входа, но отказать
    // в отправке письма: Gmail отвечает на приветствие кодом 220, а на
    // попытку отправить письмо без аутентификации — кодом 530.
    // Поэтому дополнительно проверяется, что вход действительно выполнен,
    // если сервер заявляет о поддержке аутентификации.
    const supportsAuth = /AUTH\b/.test(capabilitiesText);
    const authenticated = Boolean(client.authenticated);

    await client.close();

    if (supportsAuth && !authenticated) {
      return {
        ok: false,
        mode: 'smtp',
        error: `Сервер ${config.mail.smtp.host} требует аутентификацию, `
          + 'а логин или пароль не указаны. Письма отправляться не будут.',
        capabilities,
        authenticated: false,
      };
    }

    return { ok: true, mode: 'smtp', error: null, capabilities, authenticated };
  } catch (error) {
    await client.close().catch(() => {});
    return {
      ok: false,
      mode: 'smtp',
      error: error instanceof SmtpError ? error.message : error.message,
      capabilities: [],
      authenticated: false,
    };
  }
}

module.exports = {
  sendMail,
  sendConfirmationEmail,
  sendOrderReceivedEmail,
  verifyConnection,
  checkSmtpSettings,
  getTransport,
  resetForTests,
  DELIVERY_STATUS,
};
