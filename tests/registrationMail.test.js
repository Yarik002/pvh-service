'use strict';

/**
 * Интеграционные тесты отправки письма при регистрации (5-й день практики).
 *
 * Проверяется полная цепочка: регистрация пользователя → формирование письма
 * со ссылкой подтверждения → передача письма почтовому серверу по протоколу SMTP.
 *
 * Для проверки поднимается настоящий SMTP-сервер (tests/helpers/testSmtpServer.js),
 * поэтому контролируется реальный обмен данными.
 *
 * Запуск:  node tests/registrationMail.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';

const { TestSmtpServer } = require('./helpers/testSmtpServer');

// Настройки почтового сервера должны быть заданы до загрузки конфигурации
process.env.MAIL_TRANSPORT = 'smtp';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
process.env.MAIL_FROM = 'no-reply@pvh.local';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_SECURE = 'false';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const authService = require('../src/services/authService');
const userRepository = require('../src/repositories/userRepository');
const mailer = require('../src/mail/mailer');

/** Готовит чистую схему базы данных. */
function prepareDatabase() {
  runMigrations();
  getDb().exec('DELETE FROM Orders; DELETE FROM Users;');
}

/** Формирует корректные данные для регистрации. */
function validPayload(overrides = {}) {
  return {
    name: 'Иванов Иван',
    email: 'ivanov@mail.ru',
    password: 'Xk9#mQ2$vL7p',
    passwordConfirm: 'Xk9#mQ2$vL7p',
    ...overrides,
  };
}

/** Поднимает тестовый SMTP-сервер и настраивает на него отправку. */
async function startMailServer(options = {}) {
  const server = new TestSmtpServer(options);
  const port = await server.listen();
  // Перечитываем настройки, чтобы mailer использовал порт запущенного сервера
  mailer.resetForTests({
    SMTP_PORT: port,
    SMTP_USER: options.user || '',
    SMTP_PASSWORD: options.password || '',
  });
  return { server, port };
}

test('при регистрации отправляется письмо со ссылкой подтверждения', async () => {
  prepareDatabase();
  const { server } = await startMailServer({
    requireAuth: true,
    user: 'robot@pvh.local',
    password: 'smtp-test-password',
  });

  try {
    const { user, confirmToken, delivery } = await authService.register(validPayload());

    assert.equal(delivery.status, 'sent', `письмо должно быть отправлено (${delivery.error || 'без ошибок'})`);
    assert.equal(server.messages.length, 1, 'почтовый сервер принял одно письмо');

    const parsed = server.parseLastMessage();
    assert.equal(parsed.message.to[0], 'ivanov@mail.ru');
    assert.equal(parsed.message.from, 'no-reply@pvh.local');
    assert.equal(parsed.message.authenticated, true, 'письмо принято после аутентификации');

    const [part] = TestSmtpServer.extractParts(parsed);
    const url = `http://127.0.0.1:3000/api/auth/confirm?token=${confirmToken}`;

    assert.ok(part.text.includes(url), 'в письме есть ссылка подтверждения с верным токеном');
    assert.ok(part.text.includes(user.name), 'в письме есть обращение по имени');
  } finally {
    await server.close();
  }
});

test('токен из письма соответствует токену в базе данных', async () => {
  prepareDatabase();
  const { server } = await startMailServer();

  try {
    const { user } = await authService.register(validPayload({ email: 'token@mail.ru' }));

    const [part] = TestSmtpServer.extractParts(server.parseLastMessage());
    const match = /token=([A-Za-z0-9_-]+)/.exec(part.text);
    assert.ok(match, 'ссылка содержит параметр token');

    const row = getDb().prepare('SELECT confirm_token FROM Users WHERE id = ?').get(user.id);
    assert.equal(match[1], row.confirm_token, 'токен из письма совпадает с сохранённым');
  } finally {
    await server.close();
  }
});

test('письмо содержит текстовую и HTML-версию', async () => {
  prepareDatabase();
  const { server } = await startMailServer();

  try {
    await authService.register(validPayload({ email: 'html@mail.ru' }));

    const parsed = server.parseLastMessage();
    assert.match(parsed.headers['content-type'], /multipart\/alternative/);

    const parts = TestSmtpServer.extractParts(parsed);
    assert.equal(parts.length, 2, 'письмо состоит из двух частей');

    const plain = parts.find((p) => p.type === 'text/plain');
    const html = parts.find((p) => p.type === 'text/html');

    assert.ok(plain, 'есть текстовая версия');
    assert.ok(html, 'есть HTML-версия');
    assert.ok(html.text.includes('<a href='), 'в HTML-версии есть ссылка-кнопка');
    assert.ok(html.text.includes('<!DOCTYPE html>'));
  } finally {
    await server.close();
  }
});

test('имя пользователя не ломает HTML-разметку письма', async () => {
  prepareDatabase();
  const { server } = await startMailServer();

  try {
    await authService.register(validPayload({
      email: 'escape@mail.ru',
      name: '<b>Взлом</b> Тест',
    }));

    const parts = TestSmtpServer.extractParts(server.parseLastMessage());
    const html = parts.find((p) => p.type === 'text/html');

    assert.ok(!html.text.includes('<b>Взлом</b>'), 'опасные символы экранированы');
    assert.ok(html.text.includes('&lt;b&gt;Взлом&lt;/b&gt;'));
  } finally {
    await server.close();
  }
});

test('недоступный почтовый сервер не отменяет регистрацию', async () => {
  prepareDatabase();
  // Порт 1 заведомо не занят почтовым сервером
  mailer.resetForTests({ SMTP_PORT: 1, SMTP_USER: '', SMTP_PASSWORD: '' });

  const { user, delivery } = await authService.register(validPayload({ email: 'fail@mail.ru' }));

  assert.equal(delivery.status, 'failed', 'отправка должна завершиться неудачей');
  assert.ok(delivery.error, 'причина неудачи передана клиенту');

  const saved = userRepository.findByEmail('fail@mail.ru');
  assert.ok(saved, 'пользователь должен быть сохранён в базе данных');
  assert.equal(saved.isConfirmed, false, 'учётная запись остаётся неподтверждённой');
  assert.ok(saved.confirmToken, 'токен подтверждения сохранён');
});

test('повторная отправка письма формирует новый токен', async () => {
  prepareDatabase();
  const { server } = await startMailServer();

  try {
    const { user } = await authService.register(validPayload({ email: 'resend@mail.ru' }));
    const firstToken = getDb().prepare('SELECT confirm_token FROM Users WHERE id = ?').get(user.id).confirm_token;

    const { delivery } = await authService.resendConfirmation('resend@mail.ru');

    assert.equal(delivery.status, 'sent');
    assert.equal(server.messages.length, 2, 'отправлено второе письмо');

    const secondToken = getDb().prepare('SELECT confirm_token FROM Users WHERE id = ?').get(user.id).confirm_token;
    assert.notEqual(firstToken, secondToken, 'токен обновлён');
  } finally {
    await server.close();
  }
});

test('повторная отправка для подтверждённой учётной записи отклоняется', async () => {
  prepareDatabase();
  const { server } = await startMailServer();

  try {
    const { user } = await authService.register(validPayload({ email: 'confirmed@mail.ru' }));
    userRepository.confirm(user.id);

    await assert.rejects(
      () => authService.resendConfirmation('confirmed@mail.ru'),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.details.email.code, 'ALREADY_CONFIRMED');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('повторная отправка для неизвестного адреса отклоняется', async () => {
  prepareDatabase();
  const { server } = await startMailServer();

  try {
    await assert.rejects(
      () => authService.resendConfirmation('nikogo@mail.ru'),
      (error) => error.status === 404,
    );

    await assert.rejects(
      () => authService.resendConfirmation(''),
      (error) => error.status === 400,
    );
  } finally {
    await server.close();
  }
});

test('пароль не попадает в текст письма', async () => {
  prepareDatabase();
  const { server } = await startMailServer();

  try {
    const password = 'Xk9#mQ2$vL7p';
    await authService.register(validPayload({ email: 'nopass@mail.ru', password, passwordConfirm: password }));

    const parsed = server.parseLastMessage();
    const parts = TestSmtpServer.extractParts(parsed);

    for (const part of parts) {
      assert.ok(!part.text.includes(password), 'пароль не должен попадать в письмо');
    }
    assert.ok(!parsed.body.includes(password));
  } finally {
    await server.close();
  }
});

test('режим вывода в журнал не обращается к почтовому серверу', async () => {
  prepareDatabase();
  try {
    mailer.resetForTests({ MAIL_TRANSPORT: 'log' });
    const { delivery } = await authService.register(validPayload({ email: 'logmode@mail.ru' }));
    assert.equal(delivery.status, 'logged', 'письмо выведено в журнал');
    assert.equal(delivery.error, null);
  } finally {
    mailer.resetForTests({ MAIL_TRANSPORT: 'smtp' });
  }
});

test('завершение работы: соединение с базой данных закрывается', () => {
  closeDb();
});
