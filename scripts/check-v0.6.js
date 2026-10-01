'use strict';

/**
 * Проверка сборки v0.6 (7-й день практики).
 *
 * Тема дня: API входа по адресу электронной почты и паролю с выдачей токена.
 * Критерий приёмки: работающая авторизация, пользователь получает токен.
 *
 * Запуск:  node scripts/check-v0.6.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v06-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '200';
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || '60000';
process.env.LOGIN_LIMIT_MAX = process.env.LOGIN_LIMIT_MAX || '200';
process.env.LOGIN_LIMIT_WINDOW_MS = process.env.LOGIN_LIMIT_WINDOW_MS || '60000';
process.env.CONFIRM_LIMIT_MAX = process.env.CONFIRM_LIMIT_MAX || '200';
process.env.RESEND_LIMIT_MAX = process.env.RESEND_LIMIT_MAX || '200';
process.env.MAIL_TRANSPORT = 'log';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
process.env.SESSION_TTL_HOURS = '168';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const userRepository = require('../src/repositories/userRepository');
const sessionRepository = require('../src/repositories/sessionRepository');
const confirmationService = require('../src/services/confirmationService');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3109', 10);
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** HTTP-запрос к серверу проверки. */
async function request(method, endpoint, { body, token, cookie } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return {
    status: response.status,
    body: parsed,
    setCookie: response.headers.get('set-cookie'),
  };
}

const stamp = Date.now();
const PASSWORD = 'Xk9#mQ2$vL7p';

/** Регистрирует пользователя и подтверждает адрес электронной почты. */
async function createConfirmedUser(email, { confirm = true } = {}) {
  await request('POST', '/api/auth/register', {
    body: { name: 'Иванов Иван', email, password: PASSWORD, passwordConfirm: PASSWORD },
  });

  if (confirm) {
    const token = userRepository.findByEmail(email)?.confirmToken;
    confirmationService.confirmEmail(token);
  }

  return email;
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — вход в систему и сессии`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();
  check('Схема базы данных актуальна', true, TMP_DB);

  const tables = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);
  check('Миграция 004 создала таблицу сессий', tables.includes('Sessions'),
    `таблицы: ${tables.join(', ')}`);

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, `http://127.0.0.1:${PORT}`);

  const email = `day7_${stamp}@mail.ru`;

  try {
    // --- 1. Вход до подтверждения адреса ---------------------------------
    await createConfirmedUser(`noconfirm_${stamp}@mail.ru`, { confirm: false });
    const beforeConfirm = await request('POST', '/api/auth/login', {
      body: { email: `noconfirm_${stamp}@mail.ru`, password: PASSWORD },
    });
    check('Вход без подтверждения адреса отклоняется (403)',
      beforeConfirm.status === 403 && beforeConfirm.body?.error?.code === 'EMAIL_NOT_CONFIRMED',
      `статус ${beforeConfirm.status}, код ${beforeConfirm.body?.error?.code}`);
    check('Отказ предлагает завершить подтверждение адреса',
      /подтвержд/i.test(beforeConfirm.body?.error?.message || ''));

    // --- 2. Успешный вход --------------------------------------------------
    await createConfirmedUser(email);
    const login = await request('POST', '/api/auth/login', {
      body: { email, password: PASSWORD },
    });

    check('Вход по верным данным выполняется (200)', login.status === 200,
      `статус ${login.status}`);
    check('Пользователь получает токен сессии',
      typeof login.body?.token === 'string' && login.body.token.length >= 32,
      `длина токена: ${login.body?.token?.length}`);
    check('Ответ содержит тип токена и срок действия',
      login.body?.tokenType === 'Bearer' && Boolean(login.body?.expiresAt),
      `действует до ${login.body?.expiresAt}`);
    check('Ответ содержит данные пользователя с ролью',
      login.body?.user?.role === 'client' && login.body?.user?.isConfirmed === true,
      `роль: ${login.body?.user?.role}`);
    check('Токен установлен в cookie HttpOnly',
      Boolean(login.setCookie) && /HttpOnly/i.test(login.setCookie),
      String(login.setCookie).slice(0, 60));
    check('Ответ входа не содержит хеш пароля',
      !JSON.stringify(login.body).includes('passwordHash'));

    const token = login.body.token;

    // --- 3. Токен в базе данных хранится в виде хеша -----------------------
    const sessionRow = getDb().prepare('SELECT token_hash, user_id, expires_at FROM Sessions').get();
    check('В базе данных хранится хеш токена, а не сам токен',
      sessionRow.token_hash !== token && sessionRow.token_hash.length === 64,
      'SHA-256, 64 шестнадцатеричных символа');
    check('Срок действия сессии сохранён', Boolean(sessionRow.expires_at),
      `до ${sessionRow.expires_at}`);

    // --- 4. Доступ к защищённому маршруту ----------------------------------
    const me = await request('GET', '/api/auth/me', { token });
    check('GET /api/auth/me возвращает данные по токену',
      me.status === 200 && me.body?.user?.email === email,
      `${me.body?.user?.email}, роль ${me.body?.user?.role}`);
    check('Ответ /me содержит сведения о сессии',
      Boolean(me.body?.session?.expiresAt));

    const meByCookie = await request('GET', '/api/auth/me', { cookie: `pvh_session=${token}` });
    check('Токен принимается также из cookie',
      meByCookie.status === 200 && meByCookie.body?.user?.email === email);

    const meNoToken = await request('GET', '/api/auth/me');
    check('Доступ без токена отклоняется (401)',
      meNoToken.status === 401 && meNoToken.body?.error?.code === 'MISSING_TOKEN',
      `код: ${meNoToken.body?.error?.code}`);

    const meBadToken = await request('GET', '/api/auth/me', { token: 'nesushchestvuyushchij' });
    check('Доступ с неверным токеном отклоняется (401)',
      meBadToken.status === 401 && meBadToken.body?.error?.code === 'SESSION_NOT_FOUND',
      `код: ${meBadToken.body?.error?.code}`);

    // --- 5. Неверные учётные данные ----------------------------------------
    const wrongPassword = await request('POST', '/api/auth/login', {
      body: { email, password: 'NevernyjParol1' },
    });
    check('Неверный пароль отклоняется (401)',
      wrongPassword.status === 401 && wrongPassword.body?.error?.code === 'INVALID_CREDENTIALS');

    const unknownEmail = await request('POST', '/api/auth/login', {
      body: { email: `nikogo_${stamp}@mail.ru`, password: PASSWORD },
    });
    check('Несуществующий адрес отклоняется с тем же сообщением',
      unknownEmail.status === 401
      && unknownEmail.body?.error?.message === wrongPassword.body?.error?.message,
      'сообщения совпадают — перебор адресов невозможен');

    const emptyLogin = await request('POST', '/api/auth/login', { body: {} });
    check('Пустая форма входа отклоняется (400)',
      emptyLogin.status === 400
      && Boolean(emptyLogin.body?.error?.details?.email)
      && Boolean(emptyLogin.body?.error?.details?.password));

    // --- 6. Регистр адреса не влияет на вход --------------------------------
    const upperCaseLogin = await request('POST', '/api/auth/login', {
      body: { email: email.toUpperCase(), password: PASSWORD },
    });
    check('Вход не зависит от регистра адреса',
      upperCaseLogin.status === 200, `статус ${upperCaseLogin.status}`);

    // --- 7. Смена пароля требует авторизации --------------------------------
    const changeNoAuth = await request('POST', '/api/password/change', {
      body: { currentPassword: PASSWORD, newPassword: 'Tr9$kLm2#nQ', newPasswordConfirm: 'Tr9$kLm2#nQ' },
    });
    check('Смена пароля без авторизации отклоняется (401)', changeNoAuth.status === 401);

    const secondToken = (await request('POST', '/api/auth/login', {
      body: { email, password: PASSWORD },
    })).body.token;

    const change = await request('POST', '/api/password/change', {
      token,
      body: { currentPassword: PASSWORD, newPassword: 'Tr9$kLm2#nQ', newPasswordConfirm: 'Tr9$kLm2#nQ' },
    });
    check('Смена пароля авторизованным пользователем выполняется (200)',
      change.status === 200, change.body?.message);
    check('Остальные сессии после смены пароля завершаются',
      change.body?.otherSessionsClosed >= 1,
      `завершено сессий: ${change.body?.otherSessionsClosed}`);

    const oldPasswordLogin = await request('POST', '/api/auth/login', {
      body: { email, password: PASSWORD },
    });
    check('Старый пароль после смены не подходит (401)', oldPasswordLogin.status === 401);

    const newPasswordLogin = await request('POST', '/api/auth/login', {
      body: { email, password: 'Tr9$kLm2#nQ' },
    });
    check('Новый пароль подходит для входа (200)', newPasswordLogin.status === 200);

    // --- 8. Выход из системы -------------------------------------------------
    const freshToken = newPasswordLogin.body.token;
    const logout = await request('POST', '/api/auth/logout', { token: freshToken });
    check('Выход из системы выполняется (200)',
      logout.status === 200 && logout.body?.closed === true, logout.body?.message);

    const afterLogout = await request('GET', '/api/auth/me', { token: freshToken });
    check('После выхода токен недействителен (401)',
      afterLogout.status === 401 && afterLogout.body?.error?.code === 'SESSION_NOT_FOUND');

    const logoutAgain = await request('POST', '/api/auth/logout', { token: freshToken });
    check('Повторный выход не считается ошибкой',
      logoutAgain.status === 200 && logoutAgain.body?.closed === false);

    // --- 9. Разные входы создают разные сессии -------------------------------
    const sessionCountBefore = sessionRepository.count();
    const multi1 = await request('POST', '/api/auth/login', { body: { email, password: 'Tr9$kLm2#nQ' } });
    const multi2 = await request('POST', '/api/auth/login', { body: { email, password: 'Tr9$kLm2#nQ' } });
    check('Каждый вход выдаёт новый токен',
      multi1.body.token !== multi2.body.token);
    check('Сессии добавляются в базу данных',
      sessionRepository.count() === sessionCountBefore + 2,
      `сессий: ${sessionRepository.count()}`);

    const logoutFirst = await request('POST', '/api/auth/logout', { token: multi1.body.token });
    const stillValid = await request('GET', '/api/auth/me', { token: multi2.body.token });
    check('Выход завершает только текущую сессию',
      logoutFirst.body?.closed === true && stillValid.status === 200);

    // --- 10. Ранее созданные эндпоинты работают ------------------------------
    const health = await request('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && health.body?.status === 'OK');

    const root = await request('GET', '/');
    check('В перечне эндпоинтов указан вход в систему',
      Boolean(root.body?.endpoints?.login) && Boolean(root.body?.endpoints?.me));
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
      + 'авторизация работает, пользователь получает токен сессии.');
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
