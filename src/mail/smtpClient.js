'use strict';

/**
 * Простой SMTP-клиент на встроенных модулях Node.js (net, tls).
 *
 * Собственная реализация выбрана сознательно: сторонние библиотеки
 * (nodemailer и подобные) добавляют десятки зависимостей, тогда как для отправки
 * одного типа писем достаточно реализовать небольшой набор команд протокола
 * SMTP. Это упрощает развёртывание проекта и делает весь код проверяемым.
 *
 * Поддерживается:
 *   • режим без шифрования (для локальных тестовых серверов и отладки);
 *   • неявное шифрование TLS (порт 465, параметр secure = true);
 *   • переход на шифрование по команде STARTTLS (порт 587, по умолчанию);
 *   • аутентификация AUTH LOGIN и AUTH PLAIN;
 *   • протокол SMTPUTF8 не используется: тема письма кодируется по RFC 2047,
 *     что совместимо с любым сервером.
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

/** Коды ответов SMTP, означающие успешное выполнение команды. */
const OK_CODES = { 220: 'greeting', 250: 'ok', 235: 'auth-ok', 334: 'auth-continue', 354: 'data-start', 221: 'bye' };

/** Таймауты соединения в миллисекундах. */
const TIMEOUTS = {
  connect: 10000,   // установка соединения и приветствие
  command: 15000,   // ответ на одну команду
  data: 30000,      // передача тела письма
};

/** Ошибка протокола SMTP с кодом ответа сервера. */
class SmtpError extends Error {
  constructor(message, code, response) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.response = response;
  }
}

/**
 * Приводит дату к формату RFC 5322 (требуется стандартом для заголовка Date).
 * @param {Date} [date]
 */
function formatDate(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');

  // Смещение местного времени относительно UTC
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}${pad(absOffset % 60)}`;

  return `${days[date.getDay()]}, ${pad(date.getDate())} ${months[date.getMonth()]} `
    + `${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`;
}

/**
 * Кодирует значение заголовка по RFC 2047, если оно содержит символы вне ASCII.
 * Иначе возвращает значение без изменений.
 */
function encodeHeader(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;

  const base64 = Buffer.from(text, 'utf8').toString('base64');
  return `=?UTF-8?B?${base64}?=`;
}

/**
 * Кодирует тело письма в base64 с разбивкой на строки по 76 символов
 * (требование стандарта MIME, часть 2). Такое кодирование выбрано вместо
 * quoted-printable: оно проще и гарантирует сохранность любых символов
 * и переносов строк.
 */
function encodeBodyBase64(text) {
  const base64 = Buffer.from(String(text), 'utf8').toString('base64');
  return base64.replace(/(.{76})/g, '$1\r\n');
}

/** Формирует значение заголовка From/To с отображаемым именем. */
function formatAddress(address, name) {
  if (!name) return address;
  return `${encodeHeader(name)} <${address}>`;
}

/**
 * Собирает MIME-сообщение.
 *
 * @param {{from: {address: string, name?: string}, to: {address: string, name?: string},
 *          subject: string, text: string, html?: string, replyTo?: string}} options
 * @returns {{message: string, messageId: string}}
 */
function buildMessage(options) {
  const { from, to, subject, text, html, replyTo } = options;

  const boundary = `----=_Part_${crypto.randomBytes(12).toString('hex')}`;
  const messageId = `<${crypto.randomUUID()}@${from.address.split('@')[1] || 'localhost'}>`;

  const headers = [
    `From: ${formatAddress(from.address, from.name)}`,
    `To: ${formatAddress(to.address, to.name)}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${formatDate()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];

  if (replyTo) headers.push(`Reply-To: ${replyTo}`);

  let body;

  if (html) {
    // Письмо из двух частей: обычный текст и HTML-версия
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    body = [
      'Это письмо в формате MIME, состоящее из нескольких частей.',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBodyBase64(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBodyBase64(html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    body = encodeBodyBase64(text);
  }

  return { message: `${headers.join('\r\n')}\r\n\r\n${body}`, messageId };
}

/**
 * SMTP-клиент.
 *
 * Пример использования:
 *   const client = new SmtpClient({ host: 'smtp.mail.ru', port: 465, secure: true,
 *                                   user: 'user@mail.ru', password: 'пароль' });
 *   const result = await client.sendMail({ from, to, subject, text, html });
 *   await client.close();
 */
class SmtpClient {
  /**
   * @param {{host: string, port: number, secure?: boolean, requireTls?: boolean,
   *          user?: string, password?: string, clientName?: string}} options
   */
  constructor(options) {
    this.options = {
      host: options.host,
      port: options.port,
      secure: options.secure !== false,
      requireTls: options.requireTls === true,
      user: options.user || '',
      password: options.password || '',
      clientName: options.clientName || 'localhost',
    };

    /** @type {import('net').Socket | import('tls').TLSSocket | null} */
    this.socket = null;
    /** Признак успешно выполненного входа: нужен диагностике. */
    this.authenticated = false;
    /** @type {Array<{resolve: Function, reject: Function, codes: string[]}>} */
    this.waiters = [];
    this.buffer = '';
    this.transcript = [];
  }

  /** Записывает строку диалога (используется для диагностики). */
  log(direction, line) {
    this.transcript.push(`${direction} ${line}`);
  }

  /** Возвращает журнал диалога с сервером. */
  getTranscript() {
    return [...this.transcript];
  }

  /** Устанавливает соединение с почтовым сервером. */
  async connect() {
    const { host, port, secure, clientName } = this.options;

    this.socket = await new Promise((resolve, reject) => {
      const onError = (error) => reject(new SmtpError(
        `Не удалось подключиться к ${host}:${port} — ${error.message}`, 'ECONNECT', null,
      ));

      const socket = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });

      socket.setTimeout(TIMEOUTS.connect);
      socket.once('error', onError);
      socket.once('timeout', () => onError(new Error('превышено время ожидания')));

      socket.once(secure ? 'secureConnect' : 'connect', () => {
        socket.removeListener('error', onError);
        socket.setTimeout(0);
        resolve(socket);
      });
    });

    this.attachHandlers();

    // Приветствие сервера (код 220)
    const greeting = await this.readResponse(['220']);
    this.log('S', greeting);

    const ehlo = await this.command(`EHLO ${clientName}`, ['250']);
    this.capabilities = this.parseCapabilities(ehlo);

    // Переход на шифрование по команде STARTTLS, если сервер его поддерживает
    if (!secure && this.capabilities.includes('STARTTLS')) {
      await this.command('STARTTLS', ['220']);
      this.socket = await this.upgradeToTls();
      this.attachHandlers();
      const ehlo2 = await this.command(`EHLO ${clientName}`, ['250']);
      this.capabilities = this.parseCapabilities(ehlo2);
    } else if (!secure && this.options.requireTls) {
      throw new SmtpError(
        'Сервер не поддерживает STARTTLS, а передача данных без шифрования запрещена',
        'ENOTLS', null,
      );
    }

    return this;
  }

  /** Переводит существующее соединение на шифрование TLS. */
  upgradeToTls() {
    const { host } = this.options;
    return new Promise((resolve, reject) => {
      const secureSocket = tls.connect({ socket: this.socket, servername: host }, () => {
        secureSocket.removeListener('error', reject);
        resolve(secureSocket);
      });
      secureSocket.once('error', (error) => reject(new SmtpError(
        `Ошибка перехода на TLS — ${error.message}`, 'ETLS', null,
      )));
    });
  }

  /** Подписывается на события сокета и складывает полученные данные в буфер. */
  attachHandlers() {
    this.buffer = '';

    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.flushWaiters();
    });

    this.socket.on('error', (error) => {
      const smtpError = error instanceof SmtpError
        ? error
        : new SmtpError(`Ошибка соединения — ${error.message}`, 'ESOCKET', null);
      this.rejectWaiters(smtpError);
    });

    this.socket.on('close', () => {
      this.rejectWaiters(new SmtpError('Соединение с почтовым сервером закрыто', 'ECLOSED', null));
    });
  }

  /**
   * Извлекает из ответа список поддерживаемых возможностей (после EHLO).
   *
   * Каждая строка многострочного ответа начинается с кода 250 и разделителя
   * («-» для промежуточных строк, « » для последней), поэтому код и разделитель
   * необходимо отбросить: «250-AUTH LOGIN PLAIN» → «AUTH LOGIN PLAIN».
   */
  parseCapabilities(response) {
    return String(response)
      .split('\n')
      .slice(1)                                  // первая строка — приветствие сервера
      .map((line) => line.replace(/^\d{3}[-\s]?/, '').trim().toUpperCase())
      .filter(Boolean);
  }

  /**
   * Проверяет буфер на наличие полного ответа сервера.
   * Ответ SMTP может состоять из нескольких строк; последняя содержит пробел
   * после кода, промежуточные — дефис.
   */
  flushWaiters() {
    while (this.waiters.length > 0) {
      const lines = this.buffer.split('\r\n');
      // Последний элемент — незавершённая строка
      if (lines.length < 2) return;

      let complete = false;
      let endIndex = -1;
      for (let i = 0; i < lines.length - 1; i += 1) {
        if (/^\d{3} /.test(lines[i])) {
          complete = true;
          endIndex = i;
          break;
        }
      }
      if (!complete) return;

      const response = lines.slice(0, endIndex + 1).join('\n');
      this.buffer = lines.slice(endIndex + 1).join('\r\n');

      const waiter = this.waiters.shift();
      const code = Number.parseInt(response.slice(0, 3), 10);
      this.log('S', response.replace(/\n/g, ' | '));

      if (waiter.codes.includes(String(code))) {
        waiter.resolve(response);
      } else {
        waiter.reject(this.buildError(code, response));
      }
    }
  }

  /** Формирует понятное описание ошибки по коду ответа SMTP. */
  buildError(code, response) {
    const hints = {
      421: 'сервер временно недоступен',
      450: 'запрошенное действие не выполнено: занято',
      451: 'локальная ошибка обработки на сервере',
      452: 'недостаточно места на сервере',
      454: 'временная ошибка аутентификации',
      500: 'сервер не понял команду',
      501: 'ошибка в параметрах команды',
      502: 'команда не поддерживается сервером',
      503: 'нарушена последовательность команд',
      504: 'параметр команды не поддерживается',
      530: 'требуется аутентификация',
      534: 'выбранный способ аутентификации не поддерживается',
      535: 'неверный логин или пароль приложения',
      550: 'адрес получателя отклонён сервером',
      552: 'превышен допустимый размер письма',
      553: 'некорректный адрес отправителя',
      554: 'письмо отклонено сервером',
    };

    const hint = hints[code] ? ` (${hints[code]})` : '';
    const detail = String(response).replace(/\n/g, ' ').trim();

    return new SmtpError(
      `Почтовый сервер вернул ошибку ${code}${hint}: ${detail}`,
      `SMTP_${code}`,
      response,
    );
  }

  /** Ожидает ответ сервера с одним из указанных кодов. */
  readResponse(codes) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject, codes: codes.map(String) });
      this.flushWaiters();
    });
  }

  /** Отправляет команду и ожидает успешный ответ. */
  async command(line, codes = ['250']) {
    if (line !== null) {
      this.log('C', line);
      this.socket.write(`${line}\r\n`);
    }
    return this.readResponse(codes);
  }

  /** Выполняет аутентификацию, если заданы логин и пароль. */
  async authenticate() {
    const { user, password } = this.options;
    if (!user) return;

    const authLine = (this.capabilities || []).find((c) => c.startsWith('AUTH')) || '';
    const supportsPlain = authLine.includes('PLAIN');
    const supportsLogin = authLine.includes('LOGIN');

    if (supportsPlain) {
      // AUTH PLAIN: логин и пароль одной строкой в base64
      const token = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64');
      try {
        await this.command(`AUTH PLAIN ${token}`, ['235']);
        this.authenticated = true;
        return;
      } catch (error) {
        if (!supportsLogin) throw error;
      }
    }

    if (supportsLogin) {
      // AUTH LOGIN: логин и пароль запрашиваются отдельными командами
      await this.command('AUTH LOGIN', ['334']);
      await this.command(Buffer.from(user, 'utf8').toString('base64'), ['334']);
      await this.command(Buffer.from(password, 'utf8').toString('base64'), ['235']);
      this.authenticated = true;
      return;
    }

    throw new SmtpError(
      'Сервер не поддерживает аутентификацию AUTH PLAIN или AUTH LOGIN',
      'ENOAUTH', null,
    );
  }

  /**
   * Отправляет письмо.
   *
   * @param {{from: {address: string, name?: string}, to: {address: string, name?: string},
   *          subject: string, text: string, html?: string, replyTo?: string}} options
   * @returns {Promise<{messageId: string, response: string, envelope: object}>}
   */
  async sendMail(options) {
    if (!this.socket || this.socket.destroyed) {
      await this.connect();
    }

    const { message, messageId } = buildMessage(options);

    await this.authenticate();

    await this.command(`MAIL FROM:<${options.from.address}>`, ['250']);
    await this.command(`RCPT TO:<${options.to.address}>`, ['250', '251']);
    await this.command('DATA', ['354']);

    // Точка в начале строки экранируется удвоением (требование протокола)
    const escaped = message.replace(/\r\n\./g, '\r\n..');
    const terminated = escaped.endsWith('\r\n') ? `${escaped}.` : `${escaped}\r\n.`;

    this.log('C', `<тело письма, ${Buffer.byteLength(message, 'utf8')} байт>`);
    this.socket.write(terminated);
    this.socket.write('\r\n');

    const response = await this.readResponse(['250']);

    return {
      messageId,
      response,
      envelope: {
        from: options.from.address,
        to: options.to.address,
        subject: options.subject,
        size: Buffer.byteLength(message, 'utf8'),
      },
    };
  }

  /** Завершает сеанс связи. */
  async close() {
    if (!this.socket || this.socket.destroyed) return;
    try {
      await this.command('QUIT', ['221']);
    } catch {
      // Сервер может закрыть соединение самостоятельно — это не ошибка
    } finally {
      this.socket.end();
      this.socket = null;
    }
  }

  /** Предикат: поддерживает ли сервер указанную возможность. */
  supports(feature) {
    return Boolean(this.capabilities?.includes(String(feature).toUpperCase()));
  }

  /** Отклоняет все ожидающие ответы промисы (при обрыве связи). */
  rejectWaiters(error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}

module.exports = {
  SmtpClient,
  SmtpError,
  buildMessage,
  formatDate,
  encodeHeader,
  encodeBodyBase64,
  formatAddress,
  OK_CODES,
};
