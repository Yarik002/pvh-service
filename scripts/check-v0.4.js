'use strict';

/**
 * Проверка сборки v0.4 (5-й день практики).
 *
 * Тема дня: настройка SMTP-клиента и отправка письма с токеном подтверждения.
 * Критерий приёмки: письмо с токеном успешно приходит на почтовый ящик.
 *
 * Для проверки поднимается настоящий SMTP-сервер (tests/helpers/testSmtpServer.js):
 * контролируется реальный обмен командами протокола SMTP, от приветствия
 * до приёма тела письма. Это позволяет убедиться в работоспособности отправки
 * без использования чужого почтового ящика.
 *
 * Запуск:  node scripts/check-v0.4.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v04-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '100';
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || '60000';
process.env.MAIL_TRANSPORT = 'smtp';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
process.env.MAIL_FROM = 'no-reply@pvh.local';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_SECURE = 'false';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { TestSmtpServer } = require('../tests/helpers/testSmtpServer');
const mailer = require('../src/mail/mailer');
const { buildMessage, encodeHeader, SmtpError } = require('../src/mail/smtpClient');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3107', 10);
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(method, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

const stamp = Date.now();

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — SMTP-клиент и письмо с токеном`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();
  check('Схема базы данных актуальна', true, TMP_DB);

  // --- Тестовый почтовый сервер ----------------------------------------
  const smtpServer = new TestSmtpServer({
    requireAuth: true,
    user: 'robot@pvh.local',
    password: 'smtp-test-password',
  });
  const smtpPort = await smtpServer.listen();

  mailer.resetForTests({
    SMTP_PORT: smtpPort,
    SMTP_USER: 'robot@pvh.local',
    SMTP_PASSWORD: 'smtp-test-password',
  });

  check('Поднят тестовый SMTP-сервер', true, `127.0.0.1:${smtpPort}`);
  check('Режим отправки почты — smtp',
    mailer.getTransport() === 'smtp', `режим: ${mailer.getTransport()}`);
  check('Обязательные настройки SMTP заполнены',
    mailer.checkSmtpSettings().ok,
    `отсутствуют: ${mailer.checkSmtpSettings().missing.join(', ') || 'нет'}`);

  // --- Проверка соединения и аутентификации -----------------------------
  const connection = await mailer.verifyConnection();
  check('Соединение с почтовым сервером и аутентификация проходят успешно',
    connection.ok, connection.error || `возможности сервера: ${connection.capabilities.length}`);
  check('Сервер сообщает о поддержке аутентификации',
    connection.capabilities.some((c) => c.startsWith('AUTH')),
    connection.capabilities.find((c) => c.startsWith('AUTH')) || 'не найдено');

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер приложения запущен', true, `http://127.0.0.1:${PORT}`);

  const email = `day5_${stamp}@mail.ru`;
  const password = 'Xk9#mQ2$vL7p';

  try {
    // --- 1. Регистрация с отправкой письма -----------------------------
    const created = await request('POST', '/api/auth/register', {
      name: 'Иванов Иван',
      email,
      password,
      passwordConfirm: password,
    });
    check('Регистрация выполняется (201)', created.status === 201, `статус ${created.status}`);
    check('Ответ сообщает об успешной отправке письма',
      created.body?.confirmationEmail?.sent === true,
      `статус отправки: ${created.body?.confirmationEmail?.status}`);
    check('Сообщение предлагает проверить почту',
      /Проверьте почту/.test(created.body?.message || ''));

    // --- 2. Письмо действительно получено почтовым сервером -------------
    check('Почтовый сервер принял письмо', smtpServer.messages.length === 1,
      `писем принято: ${smtpServer.messages.length}`);

    const parsed = smtpServer.parseLastMessage();
    check('Письмо отправлено на адрес зарегистрированного пользователя',
      parsed?.message.to[0] === email, `получатель: ${parsed?.message.to[0]}`);
    check('Письмо отправлено от настроенного адреса',
      parsed?.message.from === 'no-reply@pvh.local', `отправитель: ${parsed?.message.from}`);
    check('Письмо принято после успешной аутентификации',
      parsed?.message.authenticated === true);

    const subject = TestSmtpServer.decodeHeader(parsed.headers.subject);
    check('Тема письма читается корректно (кириллица не повреждена)',
      subject.includes('Подтверждение адреса'), `тема: «${subject}»`);

    // --- 3. Содержимое письма --------------------------------------------
    const parts = TestSmtpServer.extractParts(parsed);
    check('Письмо содержит текстовую и HTML-версию',
      parts.length === 2 && parts.some((p) => p.type === 'text/plain') && parts.some((p) => p.type === 'text/html'),
      `частей: ${parts.length} (${parts.map((p) => p.type).join(', ')})`);

    const plain = parts.find((p) => p.type === 'text/plain');
    const html = parts.find((p) => p.type === 'text/html');

    check('В письме есть ссылка подтверждения с токеном',
      /\/api\/auth\/confirm\?token=[A-Za-z0-9_-]{20,}/.test(plain.text),
      'ссылка вида /api/auth/confirm?token=…');
    check('В HTML-версии ссылка оформлена кнопкой',
      html.text.includes('<a href='), 'найдена ссылка <a href=…>');
    check('В письме указан адрес получателя',
      plain.text.includes(email), email);
    check('В письме есть обращение по имени',
      plain.text.includes('Иванов Иван'));

    // --- 4. Токен из письма соответствует базе данных ---------------------
    const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(plain.text);
    const storedToken = getDb()
      .prepare('SELECT confirm_token FROM Users WHERE email = ?')
      .get(email).confirm_token;
    check('Токен из письма совпадает с сохранённым в базе данных',
      tokenMatch && tokenMatch[1] === storedToken,
      `длина токена: ${storedToken?.length} символов`);

    // --- 5. Пароль не попадает в письмо ----------------------------------
    check('Пароль не содержится в письме',
      parts.every((p) => !p.text.includes(password)) && !parsed.body.includes(password));

    // --- 6. Повторная отправка письма -------------------------------------
    const resend = await request('POST', '/api/auth/resend-confirmation', { email });
    check('Повторная отправка письма выполняется (200)',
      resend.status === 200 && resend.body?.confirmationEmail?.sent === true,
      `статус ${resend.status}`);
    check('Почтовый сервер принял второе письмо',
      smtpServer.messages.length === 2, `писем принято: ${smtpServer.messages.length}`);

    const newToken = getDb()
      .prepare('SELECT confirm_token FROM Users WHERE email = ?')
      .get(email).confirm_token;
    check('При повторной отправке сформирован новый токен',
      newToken !== storedToken, 'токен обновлён');

    const resendMail = TestSmtpServer.extractParts(smtpServer.parseLastMessage())
      .find((p) => p.type === 'text/plain');
    check('В повторном письме ссылка содержит новый токен',
      resendMail.text.includes(newToken));

    // --- 7. Обработка ошибок отправки -------------------------------------
    const unknownResend = await request('POST', '/api/auth/resend-confirmation', {
      email: `nikogo_${stamp}@mail.ru`,
    });
    check('Повторная отправка для неизвестного адреса — ошибка 404',
      unknownResend.status === 404, `статус ${unknownResend.status}`);

    const emptyResend = await request('POST', '/api/auth/resend-confirmation', {});
    check('Повторная отправка без адреса — ошибка 400',
      emptyResend.status === 400, `статус ${emptyResend.status}`);

    // Недоступный почтовый сервер: регистрация не должна прерываться
    const savedPort = smtpPort;
    mailer.resetForTests({ SMTP_PORT: 1 });
    const failEmail = `day5fail_${stamp}@mail.ru`;
    const failRegister = await request('POST', '/api/auth/register', {
      name: 'Петров Пётр',
      email: failEmail,
      password,
      passwordConfirm: password,
    });
    check('Недоступный почтовый сервер не отменяет регистрацию (201)',
      failRegister.status === 201, `статус ${failRegister.status}`);
    check('Ответ сообщает о неудаче отправки письма',
      failRegister.body?.confirmationEmail?.sent === false
      && Boolean(failRegister.body?.confirmationEmail?.error),
      `причина: ${String(failRegister.body?.confirmationEmail?.error).slice(0, 60)}…`);
    check('Пользователь сохранён в базе данных, несмотря на ошибку отправки',
      Boolean(getDb().prepare('SELECT id FROM Users WHERE email = ?').get(failEmail)));
    check('Неудачная отправка не подтверждает учётную запись',
      getDb().prepare('SELECT is_confirmed FROM Users WHERE email = ?').get(failEmail).is_confirmed === 0);
    mailer.resetForTests({ SMTP_PORT: savedPort });

    // --- 8. Режим вывода письма в журнал ----------------------------------
    mailer.resetForTests({ MAIL_TRANSPORT: 'log' });
    check('Режим log выбран корректно',
      mailer.getTransport() === 'log', `режим: ${mailer.getTransport()}`);
    const loggedDelivery = await mailer.sendConfirmationEmail({
      name: 'Тестовый Пользователь',
      email: `log_${stamp}@mail.ru`,
      token: 'test-token-value',
    });
    check('В режиме log письмо не отправляется, а выводится в журнал',
      loggedDelivery.status === 'logged', `статус: ${loggedDelivery.status}`);
    check('Количество писем на сервере не изменилось',
      smtpServer.messages.length === 2, `писем: ${smtpServer.messages.length}`);
    mailer.resetForTests({ MAIL_TRANSPORT: 'smtp' });

    // --- 9. Формат MIME-сообщения ------------------------------------------
    const { message } = buildMessage({
      from: { address: 'no-reply@pvh.local', name: 'Сервис ПВЗ' },
      to: { address: 'ivanov@mail.ru', name: 'Иванов Иван' },
      subject: 'Подтверждение адреса',
      text: 'Текст письма',
      html: '<p>Текст письма</p>',
    });
    check('Сообщение содержит обязательные заголовки MIME',
      ['From:', 'To:', 'Subject:', 'Date:', 'Message-ID:', 'MIME-Version:']
        .every((h) => message.includes(h)));
    check('Строки тела письма не превышают 76 символов',
      message.split('\r\n\r\n')[1].split('\r\n').every((line) => line.length <= 76));
    check('Заголовок с кириллицей кодируется по RFC 2047',
      /^Subject: =\?UTF-8\?B\?/m.test(message));
    check('Служебный заголовок X-Powered-By не попадает в письмо',
      !message.toLowerCase().includes('x-powered-by'));

    // --- 10. Ранее созданные эндпоинты работают ----------------------------
    const health = await request('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && health.body?.status === 'OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await smtpServer.close();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${TMP_DB}${suffix}`, { force: true });
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log('-'.repeat(78));
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);

  if (failed.length === 0) {
    console.log(`РЕЗУЛЬТАТ: сборка v${config.version} соответствует критерию приёмки — `
      + 'SMTP-клиент настроен, письмо с токеном подтверждения доставлено на почтовый сервер.');
    console.log('='.repeat(78));
    return 0;
  }

  console.log('РЕЗУЛЬТАТ: сборка НЕ прошла проверку. Не пройденные проверки:');
  failed.forEach((r) => console.log(`  • ${r.name} (${r.detail})`));
  console.log('='.repeat(78));
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    logger.error('Ошибка выполнения проверки:', error);
    closeDb();
    process.exit(1);
  });
