'use strict';

/**
 * Проверка сборки v0.2 (3-й день практики).
 *
 * Критерий приёмки: «Работающий API регистрации, проверенный в Postman».
 * Скрипт выполняет те же запросы, что и коллекция Postman, и проверяет ответы:
 *   1) успешная регистрация — 201;
 *   2) повторная регистрация на тот же Email — 409;
 *   3) пустые поля — 400 с перечнем ошибок;
 *   4) неверный формат Email — 400;
 *   5) короткий пароль и несовпадение паролей — 400;
 *   6) пароль сохраняется в виде хеша, а не в открытом виде;
 *   7) регистрация с другим регистром Email распознаётся как дубликат;
 *   8) защита от перебора — 429 после превышения предела запросов.
 *
 * Запуск:  node scripts/check-v0.2.js
 * Код возврата 0 — все проверки пройдены, 1 — есть ошибки.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Проверка выполняется на отдельной базе данных во временном каталоге,
// чтобы не затрагивать рабочую базу проекта
const TMP_DB = path.join(os.tmpdir(), `pvh-check-v02-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
// Пределы частоты запросов на время проверки: их нужно превысить,
// чтобы убедиться в работе защиты от перебора
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '25';
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || '60000';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { isPasswordHash } = require('../src/utils/password');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3102', 10);
const results = [];

/** Фиксирует результат проверки. */
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Выполняет HTTP-запрос к серверу проверки. */
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

/** Отметка времени для формирования уникальных адресов электронной почты. */
const stamp = Date.now();

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — API регистрации пользователей`);
  console.log('='.repeat(78));

  // --- Подготовка чистой базы данных -----------------------------------
  getDb();
  runMigrations();
  check('Подготовлена база данных для проверки', true, TMP_DB);

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, `http://127.0.0.1:${PORT}`);

  const email = `student${stamp}@mail.ru`;
  const password = 'parol12345';

  try {
    // --- 1. Успешная регистрация ---------------------------------------
    const created = await request('POST', '/api/auth/register', {
      name: 'Иванов Иван',
      email,
      password,
      passwordConfirm: password,
    });
    check('POST /api/auth/register создаёт пользователя (201)',
      created.status === 201, `получен статус ${created.status}`);
    check('Ответ содержит данные пользователя без хеша пароля',
      created.body?.user?.email === email && created.body?.user?.passwordHash === undefined,
      `id=${created.body?.user?.id}, role=${created.body?.user?.role}`);
    check('Новый пользователь создаётся со статусом «не подтверждён»',
      created.body?.user?.isConfirmed === false,
      `isConfirmed=${created.body?.user?.isConfirmed}`);

    // --- 2. Повторная регистрация на тот же Email ----------------------
    const duplicate = await request('POST', '/api/auth/register', {
      name: 'Петров Пётр',
      email,
      password,
      passwordConfirm: password,
    });
    check('Повторная регистрация на тот же Email отклоняется (409)',
      duplicate.status === 409 && duplicate.body?.error?.code === 'CONFLICT',
      `код ошибки: ${duplicate.body?.error?.code}`);

    // --- 3. Регистр адреса не влияет на проверку дубликата ---------------
    const upperCase = await request('POST', '/api/auth/register', {
      name: 'Петров Пётр',
      email: email.toUpperCase(),
      password,
      passwordConfirm: password,
    });
    check('Email в другом регистре распознаётся как дубликат (409)',
      upperCase.status === 409, `получен статус ${upperCase.status}`);

    // --- 4. Пустые поля -------------------------------------------------
    const empty = await request('POST', '/api/auth/register', {});
    check('Пустая форма отклоняется (400)', empty.status === 400,
      `получен статус ${empty.status}`);
    check('Ответ содержит ошибки по каждому незаполненному полю',
      ['name', 'email', 'password', 'passwordConfirm']
        .every((f) => empty.body?.error?.details?.[f]),
      `поля с ошибками: ${Object.keys(empty.body?.error?.details || {}).join(', ')}`);

    // --- 5. Некорректный формат Email -----------------------------------
    for (const badEmail of ['ivanov', 'ivanov@', '@mail.ru', 'ivanov@mail', 'ivanov mail@mail.ru']) {
      const res = await request('POST', '/api/auth/register', {
        name: 'Иванов Иван',
        email: badEmail,
        password,
        passwordConfirm: password,
      });
      const rejected = res.status === 400 && res.body?.error?.details?.email;
      check(`Email «${badEmail}» отклоняется (400)`, rejected,
        `статус ${res.status}, код: ${res.body?.error?.details?.email?.code}`);
    }

    // --- 6. Короткий пароль ---------------------------------------------
    const shortPassword = await request('POST', '/api/auth/register', {
      name: 'Иванов Иван',
      email: `short${stamp}@mail.ru`,
      password: 'parol1',
      passwordConfirm: 'parol1',
    });
    check('Короткий пароль отклоняется (400)',
      shortPassword.status === 400 && shortPassword.body?.error?.details?.password,
      `код: ${shortPassword.body?.error?.details?.password?.code}`);

    // --- 7. Пароль без цифр ---------------------------------------------
    const noDigit = await request('POST', '/api/auth/register', {
      name: 'Иванов Иван',
      email: `nodigit${stamp}@mail.ru`,
      password: 'parolparol',
      passwordConfirm: 'parolparol',
    });
    check('Пароль без цифр отклоняется (400)',
      noDigit.status === 400 && noDigit.body?.error?.details?.password?.code === 'NO_DIGIT',
      `код: ${noDigit.body?.error?.details?.password?.code}`);

    // --- 8. Несовпадение пароля и повтора --------------------------------
    const mismatch = await request('POST', '/api/auth/register', {
      name: 'Иванов Иван',
      email: `mismatch${stamp}@mail.ru`,
      password: 'parol12345',
      passwordConfirm: 'parol54321',
    });
    check('Несовпадение пароля и его повтора отклоняется (400)',
      mismatch.status === 400 && mismatch.body?.error?.details?.passwordConfirm?.code === 'MISMATCH',
      `код: ${mismatch.body?.error?.details?.passwordConfirm?.code}`);

    // --- 9. Слишком короткое имя -----------------------------------------
    const shortName = await request('POST', '/api/auth/register', {
      name: 'И',
      email: `name${stamp}@mail.ru`,
      password,
      passwordConfirm: password,
    });
    check('Слишком короткое имя отклоняется (400)',
      shortName.status === 400 && shortName.body?.error?.details?.name?.code === 'TOO_SHORT',
      `код: ${shortName.body?.error?.details?.name?.code}`);

    // --- 10. Пароль хранится в виде хеша ---------------------------------
    const row = getDb()
      .prepare('SELECT password_hash, confirm_token, is_confirmed FROM Users WHERE email = ?')
      .get(email);
    check('Пароль сохранён в виде хеша, а не в открытом виде',
      row && isPasswordHash(row.password_hash) && !row.password_hash.includes(password),
      `формат хеша: ${row ? row.password_hash.slice(0, 24) : '—'}…`);
    check('Для подтверждения Email сформирован токен',
      Boolean(row?.confirm_token), `длина токена: ${row?.confirm_token?.length}`);

    // --- 11. Ограничение частоты запросов --------------------------------
    let lastStatus = 0;
    let attempts = 0;
    for (let i = 0; i < 40; i += 1) {
      const res = await request('POST', '/api/auth/register', {
        name: 'Тестовый Пользователь',
        email: `flood${stamp}_${i}@mail.ru`,
        password,
        passwordConfirm: password,
      });
      attempts += 1;
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    check('Защита от перебора: превышение частоты запросов даёт 429',
      lastStatus === 429, `запросов до отказа: ${attempts}, последний статус ${lastStatus}`);

    // --- 12. Существующие эндпоинты продолжают работать -------------------
    const health = await request('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && health.body?.status === 'OK',
      `status = "${health.body?.status}"`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    // Удаляем временную базу данных
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${TMP_DB}${suffix}`, { force: true });
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log('-'.repeat(78));
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);

  if (failed.length === 0) {
    console.log(`РЕЗУЛЬТАТ: сборка v${config.version} соответствует критерию приёмки — `
      + 'API регистрации работает, проверки пройдены.');
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
