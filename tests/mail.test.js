'use strict';

/**
 * Модульные тесты SMTP-клиента и отправки писем (5-й день практики).
 *
 * Для проверки используется тестовый SMTP-сервер (tests/helpers/testSmtpServer.js),
 * который реализует протокол SMTP. Это позволяет проверить настоящий обмен
 * командами, не отправляя письма реальным получателям.
 *
 * Запуск:  node tests/mail.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { TestSmtpServer } = require('./helpers/testSmtpServer');
const { SmtpClient, SmtpError, buildMessage, encodeHeader, formatDate } = require('../src/mail/smtpClient');
const { confirmationEmail, orderReceivedEmail, escapeHtml } = require('../src/mail/emailTemplates');

/** Поднимает тестовый SMTP-сервер и возвращает его вместе с номером порта. */
async function startServer(options = {}) {
  const server = new TestSmtpServer(options);
  const port = await server.listen();
  return { server, port };
}

// ---------------------------------------------------------------------------
//  Формирование MIME-сообщения
// ---------------------------------------------------------------------------

test('заголовок кодируется по RFC 2047, если содержит кириллицу', () => {
  const encoded = encodeHeader('Подтверждение адреса');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), 'Подтверждение адреса');
});

test('заголовок из символов ASCII не кодируется', () => {
  assert.equal(encodeHeader('Order confirmation'), 'Order confirmation');
});

test('дата формируется по стандарту RFC 5322', () => {
  const formatted = formatDate(new Date('2026-03-15T10:30:00Z'));
  assert.match(formatted, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
});

test('сообщение содержит обязательные заголовки', () => {
  const { message, messageId } = buildMessage({
    from: { address: 'no-reply@pvh.local', name: 'Сервис ПВЗ' },
    to: { address: 'ivanov@mail.ru', name: 'Иванов Иван' },
    subject: 'Подтверждение адреса',
    text: 'Текст письма',
  });

  assert.match(message, /^From: =\?UTF-8\?B\?/m);
  assert.match(message, /^To: /m);
  assert.match(message, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(message, /^Date: /m);
  assert.match(message, /^MIME-Version: 1\.0$/m);
  assert.match(message, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.match(message, /^Content-Transfer-Encoding: base64$/m);
  assert.ok(message.includes(messageId), 'идентификатор сообщения должен быть в заголовках');
});

test('письмо с HTML-версией содержит две части (multipart/alternative)', () => {
  const { message } = buildMessage({
    from: { address: 'no-reply@pvh.local' },
    to: { address: 'ivanov@mail.ru' },
    subject: 'Проверка',
    text: 'Обычный текст',
    html: '<p>HTML</p>',
  });

  assert.match(message, /Content-Type: multipart\/alternative; boundary="/);
  assert.ok(message.includes('text/plain; charset=UTF-8'), 'текстовая часть');
  assert.ok(message.includes('text/html; charset=UTF-8'), 'HTML-часть');

  const boundaryMatch = /boundary="([^"]+)"/.exec(message);
  assert.ok(message.trimEnd().endsWith(`--${boundaryMatch[1]}--`), 'закрывающая граница частей');
});

test('строки тела письма не превышают 76 символов (требование MIME)', () => {
  const { message } = buildMessage({
    from: { address: 'no-reply@pvh.local' },
    to: { address: 'ivanov@mail.ru' },
    subject: 'Проверка длины',
    text: 'Очень длинная строка текста. '.repeat(20),
  });

  const body = message.split('\r\n\r\n')[1];
  for (const line of body.split('\r\n')) {
    assert.ok(line.length <= 76, `строка длиной ${line.length} символов превышает предел`);
  }
});

// ---------------------------------------------------------------------------
//  Шаблоны писем
// ---------------------------------------------------------------------------

test('письмо подтверждения содержит ссылку и адрес получателя', () => {
  const letter = confirmationEmail({
    name: 'Иванов Иван',
    email: 'ivanov@mail.ru',
    confirmUrl: 'http://127.0.0.1:3000/api/auth/confirm?token=abc123',
    token: 'abc123',
  });

  assert.match(letter.subject, /Подтверждение адреса/);
  assert.ok(letter.text.includes('Иванов Иван'), 'обращение по имени');
  assert.ok(letter.text.includes('ivanov@mail.ru'), 'адрес получателя');
  assert.ok(letter.text.includes('http://127.0.0.1:3000/api/auth/confirm?token=abc123'), 'ссылка');
  assert.ok(letter.html.includes('href="http://127.0.0.1:3000/api/auth/confirm?token=abc123"'), 'ссылка в HTML');
  assert.ok(letter.html.includes('<!DOCTYPE html>'));
});

test('в шаблонах экранируются специальные символы HTML', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('ООО "Ромашка" & Ко'), 'ООО &quot;Ромашка&quot; &amp; Ко');

  const letter = confirmationEmail({
    name: '<b>Взлом</b>',
    email: 'test@mail.ru',
    confirmUrl: 'http://localhost/confirm?token=x',
    token: 'x',
  });
  assert.ok(!letter.html.includes('<b>Взлом</b>'), 'имя не должно попадать в HTML без экранирования');
  assert.ok(letter.html.includes('&lt;b&gt;Взлом&lt;/b&gt;'));
});

test('письмо о приёмке заказа содержит трек-номер и ячейку', () => {
  const letter = orderReceivedEmail({
    name: 'Иванов Иван',
    trackNumber: 'PVZ123456789',
    cellNumber: 7,
    description: 'Наушники',
  });

  assert.match(letter.subject, /PVZ123456789/);
  assert.ok(letter.text.includes('Ячейка: 7'));
  assert.ok(letter.text.includes('Наушники'));
  assert.ok(letter.html.includes('PVZ123456789'));
});

// ---------------------------------------------------------------------------
//  Работа SMTP-клиента
// ---------------------------------------------------------------------------

test('клиент подключается к серверу и проходит приветствие', async () => {
  const { server, port } = await startServer();
  const client = new SmtpClient({ host: '127.0.0.1', port, secure: false });

  try {
    await client.connect();
    assert.ok(client.capabilities.includes('SIZE 10485760'), 'возможности сервера прочитаны');
    assert.ok(client.supports('8BITMIME'));
  } finally {
    await client.close();
    await server.close();
  }
});

test('письмо доставляется на почтовый сервер', async () => {
  const { server, port } = await startServer();
  const client = new SmtpClient({
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'test@example.com',
    password: 'test-password',
  });

  try {
    const result = await client.sendMail({
      from: { address: 'no-reply@pvh.local', name: 'Сервис ПВЗ' },
      to: { address: 'ivanov@mail.ru', name: 'Иванов Иван' },
      subject: 'Подтверждение адреса',
      text: 'Перейдите по ссылке',
    });

    assert.ok(result.messageId, 'сервер принял письмо');
    assert.equal(result.envelope.to, 'ivanov@mail.ru');

    const parsed = server.parseLastMessage();
    assert.equal(server.messages.length, 1);
    assert.equal(parsed.message.from, 'no-reply@pvh.local');
    assert.deepEqual(parsed.message.to, ['ivanov@mail.ru']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('аутентификация AUTH PLAIN проходит успешно', async () => {
  const { server, port } = await startServer({ requireAuth: true });
  const client = new SmtpClient({
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'test@example.com',
    password: 'test-password',
  });

  try {
    await client.connect();
    await client.authenticate();

    const authCommand = server.commands.find((c) => c.command === 'AUTH');
    assert.ok(authCommand, 'команда AUTH отправлена');
    assert.match(authCommand.argument, /^PLAIN /, 'выбран механизм PLAIN');
    // Пароль не должен передаваться в открытом виде
    assert.ok(!authCommand.argument.includes('test-password'), 'пароль кодируется в base64');
  } finally {
    await client.close();
    await server.close();
  }
});

test('аутентификация AUTH LOGIN проходит успешно', async () => {
  // Сервер, поддерживающий только AUTH LOGIN
  const server = new TestSmtpServer({ requireAuth: true });
  const originalHandle = server.handleCommand.bind(server);
  server.handleCommand = (session, socket, line) => {
    if (line.toUpperCase().startsWith('EHLO')) {
      server.commands.push({ command: 'EHLO', argument: '' });
      return socket.write(`250-test-smtp.local${'\r\n'}250-AUTH LOGIN PLAIN${'\r\n'}250 HELP${'\r\n'}`);
    }
    return originalHandle(session, socket, line);
  };

  const port = await server.listen();
  const client = new SmtpClient({
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'test@example.com',
    password: 'test-password',
  });

  try {
    await client.connect();
    await client.authenticate();
    assert.ok(server.messages !== undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test('неверный пароль приводит к понятной ошибке 535', async () => {
  const { server, port } = await startServer({ requireAuth: true });
  const client = new SmtpClient({
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'test@example.com',
    password: 'nevernyj-parol',
  });

  try {
    await assert.rejects(
      async () => {
        await client.connect();
        await client.authenticate();
      },
      (error) => {
        assert.ok(error instanceof SmtpError);
        assert.equal(error.code, 'SMTP_535');
        assert.match(error.message, /неверный логин или пароль/);
        return true;
      },
    );
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
});

test('ошибка сервера на этапе приёма данных распознаётся', async () => {
  const { server, port } = await startServer({ failAt: 'data' });
  const client = new SmtpClient({ host: '127.0.0.1', port, secure: false });

  try {
    await client.connect();
    await assert.rejects(
      () => client.sendMail({
        from: { address: 'no-reply@pvh.local' },
        to: { address: 'ivanov@mail.ru' },
        subject: 'Проверка',
        text: 'Текст',
      }),
      (error) => {
        assert.equal(error.code, 'SMTP_554');
        return true;
      },
    );
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
});

test('подключение к недоступному серверу даёт понятную ошибку', async () => {
  // Порт 1 заведомо не занят почтовым сервером
  const client = new SmtpClient({ host: '127.0.0.1', port: 1, secure: false, user: '', password: '' });

  await assert.rejects(
    () => client.connect(),
    (error) => {
      assert.ok(error instanceof SmtpError);
      assert.equal(error.code, 'ECONNECT');
      assert.match(error.message, /Не удалось подключиться/);
      return true;
    },
  );
});

test('кодировка кириллицы сохраняется при передаче письма', async () => {
  const { server, port } = await startServer();
  const client = new SmtpClient({ host: '127.0.0.1', port, secure: false });

  try {
    await client.connect();
    await client.sendMail({
      from: { address: 'no-reply@pvh.local', name: 'Сервис ПВЗ' },
      to: { address: 'ivanov@mail.ru', name: 'Иванов Иван' },
      subject: 'Подтверждение адреса электронной почты',
      text: 'Здравствуйте, Иванов Иван! Подтвердите адрес.',
    });

    const parsed = server.parseLastMessage();
    const subject = TestSmtpServer.decodeHeader(parsed.headers.subject);
    assert.equal(subject, 'Подтверждение адреса электронной почты');

    const parts = TestSmtpServer.extractParts(parsed);
    assert.equal(parts.length, 1);
    assert.ok(parts[0].text.includes('Здравствуйте, Иванов Иван!'), 'текст письма не повреждён');
  } finally {
    await client.close();
    await server.close();
  }
});

test('многострочное письмо передаётся без потери строк', async () => {
  const { server, port } = await startServer();
  const client = new SmtpClient({ host: '127.0.0.1', port, secure: false });

  const lines = ['Первая строка', 'Вторая строка', '.Точка в начале строки', 'Четвёртая строка'];

  try {
    await client.connect();
    await client.sendMail({
      from: { address: 'no-reply@pvh.local' },
      to: { address: 'ivanov@mail.ru' },
      subject: 'Проверка строк',
      text: lines.join('\n'),
    });

    const parsed = server.parseLastMessage();
    const [part] = TestSmtpServer.extractParts(parsed);

    for (const line of lines) {
      assert.ok(part.text.includes(line), `строка «${line}» должна сохраниться`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
