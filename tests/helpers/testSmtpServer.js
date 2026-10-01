'use strict';

/**
 * Тестовый SMTP-сервер.
 *
 * Минимальная реализация протокола SMTP, достаточная для проверки работы
 * клиента: приветствие, EHLO, AUTH LOGIN и AUTH PLAIN, приём письма командой
 * DATA. Полученные письма сохраняются в памяти, поэтому их можно проверить
 * в тестах.
 *
 * Используется в контрольном сценарии и модульных тестах: он позволяет
 * проверить настоящий обмен данными по протоколу SMTP без внешнего сервера
 * и без отправки писем реальным получателям.
 *
 * Поддерживаемые настройки:
 *   port        — порт прослушивания (0 — выбрать свободный автоматически);
 *   requireAuth — требовать аутентификацию перед приёмом письма;
 *   failAt      — имитация сбоя на определённом этапе (например 'auth'),
 *                 используется для проверки обработки ошибок.
 */

const net = require('net');
const { EventEmitter } = require('events');

const CRLF = '\r\n';

class TestSmtpServer extends EventEmitter {
  /**
   * @param {{port?: number, host?: string, requireAuth?: boolean, failAt?: string,
   *          user?: string, password?: string}} [options]
   */
  constructor(options = {}) {
    super();
    this.options = {
      host: '127.0.0.1',
      port: options.port ?? 0,
      requireAuth: options.requireAuth === true,
      failAt: options.failAt || null,
      user: options.user || 'test@example.com',
      password: options.password || 'test-password',
    };

    /** @type {Array<{from: string, to: string[], data: string, authenticated: boolean}>} */
    this.messages = [];
    /** @type {Array<{command: string, argument: string}>} */
    this.commands = [];

    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  /** Запускает сервер и возвращает фактический порт. */
  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.removeListener('error', reject);
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  /** Останавливает сервер. */
  close() {
    return new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
      // Принудительно закрываем оставшиеся соединения
      for (const socket of this.sockets || []) socket.destroy();
    });
  }

  /** Обслуживает одно подключение. */
  handleConnection(socket) {
    this.sockets = this.sockets || [];
    this.sockets.push(socket);

    const session = {
      authenticated: false,
      from: null,
      to: [],
      inData: false,
      dataLines: [],
      expectingUser: false,
      expectingPassword: false,
    };

    socket.setEncoding('utf8');
    socket.write(`220 test-smtp.local ESMTP Test Server${CRLF}`);

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk;

      // Обработка тела письма: читаем до строки с единственной точкой
      if (session.inData) {
        const lines = buffer.split(CRLF);
        buffer = lines.pop();

        for (const line of lines) {
          if (line === '.') {
            session.inData = false;
            this.acceptMessage(session, socket);
            break;
          }
          // Обратное преобразование удвоенной точки
          session.dataLines.push(line.startsWith('..') ? line.slice(1) : line);
        }
        return;
      }

      // Обработка команд: каждая строка завершается CRLF
      let index;
      while ((index = buffer.indexOf(CRLF)) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + CRLF.length);
        this.handleCommand(session, socket, line);
        if (session.inData) break;
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets = (this.sockets || []).filter((s) => s !== socket);
    });
  }

  /** Обрабатывает одну команду протокола. */
  handleCommand(session, socket, line) {
    const [rawCommand, ...rest] = line.split(' ');
    const command = rawCommand.toUpperCase();
    const argument = rest.join(' ');

    this.commands.push({ command, argument });

    // Продолжение аутентификации AUTH LOGIN
    if (session.expectingUser) {
      session.expectingUser = false;
      session.expectingPassword = true;
      return socket.write(`334 UGFzc3dvcmQ6${CRLF}`);
    }
    if (session.expectingPassword) {
      session.expectingPassword = false;
      const password = Buffer.from(argument, 'base64').toString('utf8');
      if (password === this.options.password) {
        session.authenticated = true;
        return socket.write(`235 2.7.0 Authentication successful${CRLF}`);
      }
      return socket.write(`535 5.7.8 Authentication credentials invalid${CRLF}`);
    }

    switch (command) {
      case 'EHLO':
      case 'HELO': {
        const capabilities = ['250-test-smtp.local', '250-SIZE 10485760', '250-8BITMIME'];
        if (this.options.requireAuth || true) capabilities.push('250-AUTH LOGIN PLAIN');
        capabilities.push('250 HELP');
        return socket.write(`${capabilities.join(CRLF)}${CRLF}`);
      }

      case 'AUTH': {
        const [mechanism, token] = argument.split(' ');
        const upper = (mechanism || '').toUpperCase();

        if (this.options.failAt === 'auth') {
          return socket.write(`535 5.7.8 Authentication failed (тестовый сбой)${CRLF}`);
        }

        if (upper === 'PLAIN') {
          let payload = token;
          if (!payload) {
            return socket.write(`334 ${CRLF}`);
          }
          const decoded = Buffer.from(payload, 'base64').toString('utf8');
          const parts = decoded.split('\u0000');
          const password = parts[parts.length - 1];
          if (password === this.options.password) {
            session.authenticated = true;
            return socket.write(`235 2.7.0 Authentication successful${CRLF}`);
          }
          return socket.write(`535 5.7.8 Authentication credentials invalid${CRLF}`);
        }

        if (upper === 'LOGIN') {
          if (token) {
            // Логин передан сразу вместе с механизмом
            session.expectingPassword = true;
            return socket.write(`334 UGFzc3dvcmQ6${CRLF}`);
          }
          session.expectingUser = true;
          return socket.write(`334 VXNlcm5hbWU6${CRLF}`);
        }

        return socket.write(`504 5.5.4 Unrecognized authentication type${CRLF}`);
      }

      case 'MAIL': {
        if (this.options.requireAuth && !session.authenticated) {
          return socket.write(`530 5.7.0 Authentication required${CRLF}`);
        }
        const match = /FROM:\s*<([^>]*)>/i.exec(argument);
        session.from = match ? match[1] : null;
        session.to = [];
        session.dataLines = [];
        return socket.write(`250 2.1.0 Sender OK${CRLF}`);
      }

      case 'RCPT': {
        const match = /TO:\s*<([^>]*)>/i.exec(argument);
        if (!match) return socket.write(`501 5.1.3 Bad recipient address syntax${CRLF}`);
        session.to.push(match[1]);
        return socket.write(`250 2.1.5 Recipient OK${CRLF}`);
      }

      case 'DATA': {
        if (this.options.failAt === 'data') {
          return socket.write(`554 5.3.0 Transaction failed (тестовый сбой)${CRLF}`);
        }
        session.inData = true;
        session.dataLines = [];
        return socket.write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`);
      }

      case 'RSET':
        session.from = null;
        session.to = [];
        session.dataLines = [];
        return socket.write(`250 2.0.0 OK${CRLF}`);

      case 'NOOP':
        return socket.write(`250 2.0.0 OK${CRLF}`);

      case 'QUIT':
        socket.write(`221 2.0.0 Bye${CRLF}`);
        return socket.end();

      default:
        return socket.write(`502 5.5.2 Command not implemented${CRLF}`);
    }
  }

  /** Сохраняет принятое письмо и подтверждает приём. */
  acceptMessage(session, socket) {
    const data = session.dataLines.join(CRLF);

    this.messages.push({
      from: session.from,
      to: [...session.to],
      data,
      authenticated: session.authenticated,
      receivedAt: new Date(),
    });

    this.emit('message', this.messages[this.messages.length - 1]);
    socket.write(`250 2.0.0 Message accepted for delivery${CRLF}`);
  }

  /** Возвращает последнее принятое письмо. */
  getLastMessage() {
    return this.messages[this.messages.length - 1] || null;
  }

  /** Разбирает последнее письмо на заголовки и тело. */
  parseLastMessage() {
    const message = this.getLastMessage();
    if (!message) return null;

    const separator = message.data.indexOf(`${CRLF}${CRLF}`);
    const headerPart = separator === -1 ? message.data : message.data.slice(0, separator);
    const bodyPart = separator === -1 ? '' : message.data.slice(separator + 4);

    const headers = {};
    let currentHeader = null;

    for (const line of headerPart.split(CRLF)) {
      if (/^\s/.test(line) && currentHeader) {
        headers[currentHeader] += ` ${line.trim()}`;
        continue;
      }
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      currentHeader = line.slice(0, colon).toLowerCase();
      headers[currentHeader] = line.slice(colon + 1).trim();
    }

    return { headers, body: bodyPart, message };
  }

  /** Декодирует значение заголовка, закодированное по RFC 2047. */
  static decodeHeader(value) {
    const encodedWords = String(value).split(/\s+/);
    let result = '';

    for (const word of encodedWords) {
      const match = /^=\?UTF-8\?B\?(.+)\?=$/i.exec(word);
      result += (result ? ' ' : '') + (match
        ? Buffer.from(match[1], 'base64').toString('utf8')
        : word);
    }

    return result;
  }

  /** Извлекает из письма все текстовые части в декодированном виде. */
  static extractParts(parsed) {
    const contentType = parsed.headers['content-type'] || '';
    const parts = [];

    // Тело кодируется в base64 с переносами строк по 76 символов (требование MIME),
    // поэтому перед декодированием переносы удаляются, а полученный текст
    // приводится к переносам строк вида \n
    const decode = (text) => Buffer
      .from(String(text).replace(/\s/g, ''), 'base64')
      .toString('utf8')
      .replace(/\r\n/g, '\n');

    if (contentType.includes('multipart')) {
      const boundaryMatch = /boundary="?([^";]+)"?/.exec(contentType);
      if (!boundaryMatch) return parts;
      const boundary = `--${boundaryMatch[1]}`;

      const chunks = parsed.body.split(boundary);
      for (const chunk of chunks) {
        const separator = chunk.indexOf(`${CRLF}${CRLF}`);
        if (separator === -1) continue;
        const head = chunk.slice(0, separator);
        const body = chunk.slice(separator + 4).replace(new RegExp(`${CRLF}--\\s*$`), '').trim();
        const type = /Content-Type:\s*([^;\r\n]+)/i.exec(head);
        const encoding = /Content-Transfer-Encoding:\s*(\S+)/i.exec(head);
        if (!type) continue;
        parts.push({
          type: type[1].trim().toLowerCase(),
          text: encoding && /base64/i.test(encoding[1]) ? decode(body) : body.replace(/\r\n/g, '\n'),
        });
      }
    } else {
      // Заголовок Content-Transfer-Encoding относится ко всему сообщению
      // и находится в его заголовочной части
      const encoding = parsed.headers['content-transfer-encoding'];
      parts.push({
        type: contentType.split(';')[0].trim().toLowerCase() || 'text/plain',
        text: encoding && /base64/i.test(encoding)
          ? decode(parsed.body)
          : parsed.body.replace(/\r\n/g, '\n'),
      });
    }

    return parts;
  }
}

module.exports = { TestSmtpServer };
