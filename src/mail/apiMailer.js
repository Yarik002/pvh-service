'use strict';

/**
 * Отправка писем через HTTPS-API почтового сервиса.
 *
 * Зачем это нужно
 * ---------------
 * Протокол SMTP (порты 25, 465, 587) часто блокируется провайдерами
 * и VPN-сервисами: TCP-соединение устанавливается, но почтовый сервер
 * не отвечает. Тогда обычная отправка невозможна, хотя интернет работает.
 *
 * Многие почтовые сервисы (Resend, Brevo и подобные) принимают письма
 * не по SMTP, а обычным HTTPS-запросом. HTTPS блокируется гораздо реже,
 * поэтому такой способ работает там, где SMTP недоступен.
 *
 * Поддерживаются сервисы:
 *   resend — https://api.resend.com/emails
 *   brevo  — https://api.brevo.com/v3/smtp/email
 *
 * Настройки (в файле .env или переменных окружения):
 *   MAIL_TRANSPORT=api
 *   MAIL_API_PROVIDER=resend | brevo
 *   MAIL_API_KEY=<ключ из личного кабинета сервиса>
 *   MAIL_FROM=<адрес отправителя, подтверждённый в сервисе>
 */

const config = require('../config');
const logger = require('../utils/logger');

/** Результат отправки. */
const STATUS = {
  SENT: 'sent',
  FAILED: 'failed',
};

/** Описание поддерживаемых сервисов. */
const PROVIDERS = {
  resend: {
    title: 'Resend',
    url: 'https://api.resend.com/emails',
    buildHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    buildBody: (letter, from) => ({
      from: from.name ? `${from.name} <${from.address}>` : from.address,
      to: [letter.to.address],
      subject: letter.subject,
      text: letter.text,
      ...(letter.html ? { html: letter.html } : {}),
    }),
    getMessageId: (data) => data.id || null,
  },

  brevo: {
    title: 'Brevo',
    url: 'https://api.brevo.com/v3/smtp/email',
    buildHeaders: (apiKey) => ({
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    buildBody: (letter, from) => ({
      sender: { email: from.address, name: from.name },
      to: [{ email: letter.to.address, name: letter.to.name || undefined }],
      subject: letter.subject,
      textContent: letter.text,
      ...(letter.html ? { htmlContent: letter.html } : {}),
    }),
    getMessageId: (data) => data.messageId || null,
  },
};

/**
 * Проверяет, что настройки отправки через API заполнены.
 * @returns {{ok: boolean, missing: string[]}}
 */
function checkApiSettings() {
  const missing = [];
  const provider = String(config.mail.api.provider || '').toLowerCase();

  if (!provider) missing.push('MAIL_API_PROVIDER');
  else if (!PROVIDERS[provider]) missing.push('MAIL_API_PROVIDER (допустимо: resend, brevo)');

  if (!config.mail.api.key) missing.push('MAIL_API_KEY');
  if (!config.mail.fromAddress || config.mail.fromAddress.endsWith('.local')) {
    missing.push('MAIL_FROM (укажите адрес, подтверждённый в сервисе)');
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Отправляет письмо через HTTPS-API выбранного сервиса.
 *
 * @param {{to: {address: string, name?: string}, subject: string,
 *          text: string, html?: string}} letter
 * @returns {Promise<{status: string, messageId: string|null, error: string|null}>}
 */
async function sendMail(letter) {
  const settings = checkApiSettings();

  if (!settings.ok) {
    const error = 'Не заполнены настройки отправки через API: ' + settings.missing.join(', ');
    logger.error(error);
    return { status: STATUS.FAILED, messageId: null, error };
  }

  const providerName = String(config.mail.api.provider).toLowerCase();
  const provider = PROVIDERS[providerName];
  const from = { address: config.mail.fromAddress, name: config.mail.fromName };

  const body = provider.buildBody(letter, from);

  try {
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: provider.buildHeaders(config.mail.api.key),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.mail.api.timeout),
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const reason = (data && (data.message || data.error))
        || `сервис вернул код ${response.status}`;
      logger.error(`Не удалось отправить письмо через ${provider.title}: ${reason}`);
      return { status: STATUS.FAILED, messageId: null, error: reason };
    }

    const messageId = provider.getMessageId(data || {});
    logger.info(`Письмо отправлено через ${provider.title} на ${letter.to.address}`);

    return { status: STATUS.SENT, messageId, error: null };
  } catch (error) {
    const reason = error.name === 'TimeoutError'
      ? 'превышено время ожидания ответа сервиса'
      : `ошибка обращения к сервису: ${error.message}`;

    logger.error(`Не удалось отправить письмо через ${provider.title}: ${reason}`);
    return { status: STATUS.FAILED, messageId: null, error: reason };
  }
}

/**
 * Проверяет доступность сервиса и правильность ключа.
 * Отправляет запрос без письма: сервис отвечает ошибкой авторизации,
 * если ключ неверный.
 *
 * @returns {Promise<{ok: boolean, provider: string, error: string|null}>}
 */
async function verifyConnection() {
  const settings = checkApiSettings();
  const providerName = String(config.mail.api.provider || '').toLowerCase();

  if (!settings.ok) {
    return {
      ok: false,
      provider: providerName,
      error: 'Не заполнены настройки: ' + settings.missing.join(', '),
    };
  }

  const provider = PROVIDERS[providerName];

  // Запрос с заведомо пустым телом: проверяется доступность и ключ.
  // Ответ об ошибке проверки данных означает, что ключ принят.
  try {
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: provider.buildHeaders(config.mail.api.key),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(config.mail.api.timeout),
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        provider: provider.title,
        error: 'ключ API отклонён сервисом. Проверьте MAIL_API_KEY',
      };
    }

    // 400 или 422 — ключ верный, но данные письма неполные (ожидаемо)
    if (response.status === 400 || response.status === 422 || response.ok) {
      return { ok: true, provider: provider.title, error: null };
    }

    return {
      ok: false,
      provider: provider.title,
      error: `сервис вернул неожиданный код ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      provider: provider.title,
      error: `не удалось связаться с сервисом: ${error.message}`,
    };
  }
}

module.exports = { sendMail, verifyConnection, checkApiSettings, PROVIDERS };
