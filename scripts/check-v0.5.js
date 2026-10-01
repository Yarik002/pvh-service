'use strict';

/**
 * Проверка сборки v0.5 (6-й день практики).
 *
 * Тема дня: активация учётной записи по токену из письма.
 * Критерий приёмки: при переходе по ссылке из письма статус аккаунта
 * меняется на подтверждённый.
 *
 * Запуск:  node scripts/check-v0.5.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v05-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '100';
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || '60000';
process.env.CONFIRM_LIMIT_MAX = process.env.CONFIRM_LIMIT_MAX || '100';
process.env.RESEND_LIMIT_MAX = process.env.RESEND_LIMIT_MAX || '100';
process.env.MAIL_TRANSPORT = 'log';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
process.env.MAIL_CONFIRM_TTL_HOURS = '24';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const userRepository = require('../src/repositories/userRepository');
const confirmationService = require('../src/services/confirmationService');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3108', 10);
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** HTTP-запрос к серверу проверки. */
async function request(method, endpoint, { body, accept = 'application/json' } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method,
    headers: {
      Accept: accept,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('json')
    ? await response.json()
    : await response.text();

  return { status: response.status, body: payload, contentType };
}

const stamp = Date.now();

/** Регистрирует пользователя и возвращает его адрес и токен. */
async function registerUser(prefix) {
  const email = `${prefix}_${stamp}@mail.ru`;
  const password = 'Xk9#mQ2$vL7p';

  const response = await request('POST', '/api/auth/register', {
    body: { name: 'Иванов Иван', email, password, passwordConfirm: password },
  });

  const token = userRepository.findByEmail(email)?.confirmToken;
  return { email, token, response };
}

/** Сдвигает дату формирования токена в прошлое. */
function ageToken(email, hours) {
  const user = userRepository.findByEmail(email);
  getDb()
    .prepare("UPDATE Users SET confirm_token_created_at = datetime('now', ?) WHERE id = ?")
    .run(`-${hours} hours`, user.id);
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — активация аккаунта по токену`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();
  check('Схема базы данных актуальна', true, TMP_DB);

  const columns = getDb().prepare('PRAGMA table_info(Users)').all().map((c) => c.name);
  check('Миграция 003 добавила поля подтверждения',
    columns.includes('confirm_token_created_at') && columns.includes('confirm_attempts'),
    `поля: ${columns.filter((c) => c.startsWith('confirm')).join(', ')}`);

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, `http://127.0.0.1:${PORT}`);

  try {
    // --- 1. Успешное подтверждение по ссылке -----------------------------
    const first = await registerUser('confirm');
    check('Пользователь зарегистрирован и получил токен',
      first.response.status === 201 && Boolean(first.token),
      `длина токена: ${first.token?.length}`);

    const beforeRow = getDb()
      .prepare('SELECT is_confirmed FROM Users WHERE email = ?').get(first.email);
    check('До подтверждения адрес не подтверждён', beforeRow.is_confirmed === 0);

    const confirm = await request('GET', `/api/auth/confirm?token=${encodeURIComponent(first.token)}`);
    check('GET /api/auth/confirm подтверждает адрес (200)',
      confirm.status === 200 && confirm.body?.status === 'confirmed',
      `статус: ${confirm.body?.status}`);
    check('Ответ содержит признак подтверждения',
      confirm.body?.user?.isConfirmed === true, `isConfirmed=${confirm.body?.user?.isConfirmed}`);
    check('Сообщение понятно пользователю',
      /подтверждён/i.test(confirm.body?.message || ''), confirm.body?.message);

    const afterRow = getDb()
      .prepare('SELECT is_confirmed, confirm_token FROM Users WHERE email = ?').get(first.email);
    check('Статус аккаунта в базе данных изменён на подтверждённый',
      afterRow.is_confirmed === 1);
    check('Использованный токен удалён из базы данных',
      afterRow.confirm_token === null);

    // --- 2. Повторное использование ссылки --------------------------------
    const reuse = await request('GET', `/api/auth/confirm?token=${encodeURIComponent(first.token)}`);
    check('Повторный переход по использованной ссылке отклоняется (400)',
      reuse.status === 400 && reuse.body?.status === 'invalid',
      `статус: ${reuse.body?.status}`);

    // --- 3. Ошибочные ситуации --------------------------------------------
    const invalid = await request('GET', '/api/auth/confirm?token=nesushchestvuyushchij');
    check('Недействительный токен отклоняется (400)',
      invalid.status === 400 && invalid.body?.status === 'invalid');

    const missing = await request('GET', '/api/auth/confirm');
    check('Отсутствующий токен отклоняется (400)',
      missing.status === 400 && missing.body?.status === 'missing');

    // --- 4. Срок действия ссылки -------------------------------------------
    const expired = await registerUser('expired');
    ageToken(expired.email, 25);       // срок действия — 24 часа
    const expiredResult = await request('GET',
      `/api/auth/confirm?token=${encodeURIComponent(expired.token)}`);
    check('Просроченная ссылка отклоняется (410)',
      expiredResult.status === 410 && expiredResult.body?.status === 'expired',
      `статус: ${expiredResult.status}/${expiredResult.body?.status}`);
    check('Просроченная ссылка не подтверждает учётную запись',
      getDb().prepare('SELECT is_confirmed FROM Users WHERE email = ?')
        .get(expired.email).is_confirmed === 0);

    const withinTtl = await registerUser('ttl');
    ageToken(withinTtl.email, 23);
    const withinResult = await request('GET',
      `/api/auth/confirm?token=${encodeURIComponent(withinTtl.token)}`);
    check('Ссылка в пределах срока действия принимается',
      withinResult.status === 200 && withinResult.body?.status === 'confirmed');

    // --- 5. Проверка ссылки без подтверждения -------------------------------
    const checker = await registerUser('check');
    const checkLink = await request('GET',
      `/api/auth/confirm/check?token=${encodeURIComponent(checker.token)}`);
    check('GET /api/auth/confirm/check сообщает о действительности ссылки',
      checkLink.status === 200 && checkLink.body?.status === 'valid',
      `осталось времени: ${checkLink.body?.timeLeftHours} ч`);
    check('Проверка ссылки не подтверждает учётную запись',
      getDb().prepare('SELECT is_confirmed FROM Users WHERE email = ?')
        .get(checker.email).is_confirmed === 0);

    // --- 6. Подтверждение через POST ---------------------------------------
    const poster = await registerUser('post');
    const postResult = await request('POST', '/api/auth/confirm', { body: { token: poster.token } });
    check('POST /api/auth/confirm подтверждает адрес (200)',
      postResult.status === 200 && postResult.body?.status === 'confirmed');
    check('POST-подтверждение возвращает данные пользователя с ролью',
      postResult.body?.user?.role === 'client',
      `роль: ${postResult.body?.user?.role}`);

    // --- 7. HTML-страница для браузера -------------------------------------
    const htmlResult = await request('GET', `/api/auth/confirm?token=${encodeURIComponent(poster.token)}`,
      { accept: 'text/html' });
    check('Ссылка из письма открывается как HTML-страница',
      htmlResult.status === 400 && htmlResult.contentType.includes('text/html'),
      `Content-Type: ${htmlResult.contentType}`);
    check('Страница содержит понятный заголовок и стили',
      typeof htmlResult.body === 'string'
      && htmlResult.body.includes('<h1>')
      && htmlResult.body.includes('<style>'),
      'страница оформлена автономно');

    const successHtml = await request('GET',
      `/api/auth/confirm?token=${encodeURIComponent((await registerUser('html')).token)}`,
      { accept: 'text/html' });
    check('Страница успешного подтверждения содержит данные пользователя',
      successHtml.status === 200 && successHtml.body.includes('подтверждён'),
      'найдено сообщение об успехе');

    // --- 8. Повторная отправка письма --------------------------------------
    const resender = await registerUser('resend6');
    ageToken(resender.email, 30);

    const resend = await request('POST', '/api/auth/resend-confirmation', { body: { email: resender.email } });
    check('Повторная отправка письма выполняется (200)', resend.status === 200);

    const newToken = userRepository.findByEmail(resender.email).confirmToken;
    check('Повторная отправка формирует новый токен', newToken !== resender.token);
    check('Новая ссылка действует, несмотря на истёкший срок предыдущей',
      confirmationService.checkToken(newToken).status === 'valid');

    const confirmNew = await request('GET', `/api/auth/confirm?token=${encodeURIComponent(newToken)}`);
    check('Новый токен подтверждает учётную запись',
      confirmNew.status === 200 && confirmNew.body?.status === 'confirmed');

    const resendConfirmed = await request('POST', '/api/auth/resend-confirmation',
      { body: { email: resender.email } });
    check('Повторная отправка для подтверждённой записи отклоняется (409)',
      resendConfirmed.status === 409, `статус ${resendConfirmed.status}`);

    // --- 9. Защита данных ---------------------------------------------------
    const leaked = await request('GET', `/api/auth/confirm?token=${encodeURIComponent(postResult.body.user.email)}`);
    check('Ответ подтверждения не содержит хеш пароля и токен',
      leaked.status === 400
      && !JSON.stringify(postResult.body).includes('passwordHash')
      && !JSON.stringify(postResult.body).includes('confirmToken'));

    // --- 10. Ранее созданные эндпоинты работают -----------------------------
    const health = await request('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && health.body?.status === 'OK');

    const root = await request('GET', '/api');
    check('В перечне эндпоинтов указано подтверждение адреса',
      Boolean(root.body?.endpoints?.confirm));
    check('Подтверждение адреса больше не числится в плане',
      !(root.body?.planned || []).some((item) => item.includes('confirm')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
      + 'при переходе по ссылке из письма статус аккаунта меняется на подтверждённый.');
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
