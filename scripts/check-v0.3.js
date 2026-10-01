'use strict';

/**
 * Проверка сборки v0.3 (4-й день практики).
 *
 * Тема дня: хеширование паролей и сохранение пользователя в базу данных.
 * Дополнительно проверяется оценка надёжности пароля и смена пароля.
 *
 * Проверяются следующие утверждения:
 *   1) пароль сохраняется в виде хеша scrypt, а не в открытом виде;
 *   2) хеш уникален для каждого пользователя (случайная соль);
 *   3) пароль можно проверить по сохранённому хешу;
 *   4) при регистрации отклоняются ненадёжные пароли (словарные, с личными данными);
 *   5) эндпоинт оценки надёжности возвращает оценку и рекомендации;
 *   6) стойкий пароль получает высокую оценку, слабый — низкую;
 *   7) пароль можно сменить, и старый перестаёт подходить;
 *   8) при смене пароля проверяется текущий пароль;
 *   9) новый пароль не должен совпадать с текущим;
 *  10) данные о смене пароля сохраняются в базе данных.
 *
 * Запуск:  node scripts/check-v0.3.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v03-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '100';
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || '60000';
process.env.PASSWORD_CHECK_MAX = process.env.PASSWORD_CHECK_MAX || '200';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { isPasswordHash, verifyPassword } = require('../src/utils/password');
const passwordService = require('../src/services/passwordService');
const AppError = require('../src/utils/AppError');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3104', 10);
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
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — хеширование паролей и смена пароля`);
  console.log('='.repeat(78));

  getDb();
  const { applied, skipped } = runMigrations();
  check('Схема базы данных актуальна',
    true,
    `применено миграций: ${applied.length}, уже было применено: ${skipped.length}`);

  const columns = getDb().prepare('PRAGMA table_info(Users)').all().map((c) => c.name);
  check('Миграция 002 добавила поля для работы с паролями',
    columns.includes('password_changed_at') && columns.includes('must_change_password'),
    `поля таблицы Users: ${columns.join(', ')}`);

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, `http://127.0.0.1:${PORT}`);

  const email = `day4_${stamp}@mail.ru`;
  const strongPassword = 'Xk9#mQ2$vL7p';

  try {
    // --- 1. Регистрация со стойким паролем ------------------------------
    const created = await request('POST', '/api/auth/register', {
      name: 'Иванов Иван',
      email,
      password: strongPassword,
      passwordConfirm: strongPassword,
    });
    check('Регистрация со стойким паролем выполняется (201)',
      created.status === 201, `статус ${created.status}`);

    // --- 2. Пароль хранится в виде хеша ---------------------------------
    const row = getDb()
      .prepare('SELECT id, password_hash, password_changed_at, must_change_password FROM Users WHERE email = ?')
      .get(email);
    check('Пароль сохранён в виде хеша scrypt',
      isPasswordHash(row.password_hash), `формат: ${row.password_hash.slice(0, 20)}…`);
    check('Пароль в открытом виде отсутствует в базе',
      !row.password_hash.includes(strongPassword));
    check('Хеш содержит случайную соль',
      row.password_hash.split('$')[4].length === 32,
      `длина соли: ${row.password_hash.split('$')[4].length} символов (16 байт)`);

    // --- 3. Проверка пароля по хешу -------------------------------------
    check('Сохранённый хеш подтверждает верный пароль',
      await verifyPassword(strongPassword, row.password_hash));
    check('Сохранённый хеш отклоняет неверный пароль',
      (await verifyPassword('NevernyjParol1', row.password_hash)) === false);

    // --- 4. Один и тот же пароль даёт разные хеши ------------------------
    const secondEmail = `day4b_${stamp}@mail.ru`;
    await request('POST', '/api/auth/register', {
      name: 'Петров Пётр',
      email: secondEmail,
      password: strongPassword,
      passwordConfirm: strongPassword,
    });
    const secondRow = getDb()
      .prepare('SELECT password_hash FROM Users WHERE email = ?')
      .get(secondEmail);
    check('Одинаковые пароли дают разные хеши (случайная соль)',
      row.password_hash !== secondRow.password_hash);

    // --- 5. Ненадёжные пароли отклоняются при регистрации ----------------
    const weakCases = [
      ['qwerty123', 'COMMON_PASSWORD', 'часто используемый пароль'],
      ['password1', 'COMMON_PASSWORD', 'словарное слово'],
      ['Str0ng!Passw0rd', 'CONTAINS_COMMON_WORD', 'слово «password» с заменами'],
      ['Иванов2026!', 'CONTAINS_PERSONAL_DATA', 'личные данные пользователя'],
      ['abcabcabc1', 'REPEATED_PATTERN', 'повторяющийся блок'],
    ];
    for (const [password, expectedCode, description] of weakCases) {
      const response = await request('POST', '/api/auth/register', {
        name: 'Иванов Иван',
        email: `weak_${stamp}_${expectedCode}@mail.ru`,
        password,
        passwordConfirm: password,
      });
      const actualCode = response.body?.error?.details?.password?.code;
      check(`Отклоняется ненадёжный пароль (${description})`,
        response.status === 400 && actualCode === expectedCode,
        `статус ${response.status}, код ${actualCode}`);
    }

    // --- 6. Оценка надёжности через API ---------------------------------
    const strengthStrong = await request('POST', '/api/password/strength', {
      password: strongPassword,
      name: 'Иванов Иван',
      email,
    });
    check('POST /api/password/strength возвращает оценку стойкого пароля',
      strengthStrong.status === 200 && strengthStrong.body?.strength?.score >= 70,
      `оценка ${strengthStrong.body?.strength?.score} из 100, уровень «${strengthStrong.body?.strength?.label}»`);

    const strengthWeak = await request('POST', '/api/password/strength', { password: 'qwerty123' });
    check('Оценка слабого пароля существенно ниже',
      strengthWeak.body?.strength?.score < 40,
      `оценка ${strengthWeak.body?.strength?.score} из 100, уровень «${strengthWeak.body?.strength?.label}»`);
    check('Оценка сопровождается рекомендациями по улучшению',
      Array.isArray(strengthWeak.body?.strength?.warnings) && strengthWeak.body.strength.warnings.length > 0,
      `замечаний: ${strengthWeak.body?.strength?.warnings?.length}`);
    check('Оценка содержит перечень выполненных проверок',
      Array.isArray(strengthStrong.body?.strength?.checks) && strengthStrong.body.strength.checks.length >= 5,
      `проверок: ${strengthStrong.body?.strength?.checks?.length}`);
    check('Ответ оценки надёжности не содержит сам пароль',
      !JSON.stringify(strengthStrong.body).includes(strongPassword));
    check('Пароль не указан — запрос отклоняется (400)',
      (await request('POST', '/api/password/strength', {})).status === 400);

    // --- 7. Смена пароля -------------------------------------------------
    const newPassword = 'Tr9$kLm2#nQ';
    const { user: updated } = await passwordService.changePassword(row.id, {
      currentPassword: strongPassword,
      newPassword,
      newPasswordConfirm: newPassword,
    });
    check('Смена пароля выполнена успешно', updated.id === row.id);
    check('Хеш пароля обновлён в базе данных',
      await verifyPassword(newPassword, getDb()
        .prepare('SELECT password_hash FROM Users WHERE id = ?').get(row.id).password_hash));
    check('Старый пароль больше не подходит',
      (await verifyPassword(strongPassword, getDb()
        .prepare('SELECT password_hash FROM Users WHERE id = ?').get(row.id).password_hash)) === false);

    // --- 8. Дата смены пароля --------------------------------------------
    const changedAt = getDb()
      .prepare('SELECT password_changed_at FROM Users WHERE id = ?')
      .get(row.id).password_changed_at;
    check('Дата смены пароля сохранена в базе данных', Boolean(changedAt), `значение: ${changedAt}`);

    // --- 9. Неверный текущий пароль --------------------------------------
    let wrongCurrentError = null;
    try {
      await passwordService.changePassword(row.id, {
        currentPassword: 'SovsemDrug0j#1',
        newPassword: 'Bn7!xT4@vD9',
        newPasswordConfirm: 'Bn7!xT4@vD9',
      });
    } catch (error) {
      wrongCurrentError = error;
    }
    check('Смена пароля с неверным текущим паролем отклоняется (401)',
      wrongCurrentError instanceof AppError && wrongCurrentError.status === 401,
      `код: ${wrongCurrentError?.code}`);

    // --- 10. Новый пароль не должен совпадать с текущим -------------------
    let sameError = null;
    try {
      await passwordService.changePassword(row.id, {
        currentPassword: newPassword,
        newPassword,
        newPasswordConfirm: newPassword,
      });
    } catch (error) {
      sameError = error;
    }
    check('Совпадение нового пароля с текущим отклоняется (400)',
      sameError instanceof AppError && sameError.details?.newPassword?.code === 'NOT_DIFFERENT',
      `код: ${sameError?.details?.newPassword?.code}`);

    // --- 11. Смена пароля не возвращает служебные поля ---------------------
    const { user: afterChange } = await passwordService.changePassword(row.id, {
      currentPassword: newPassword,
      newPassword: 'Wq5%zR8&mK3',
      newPasswordConfirm: 'Wq5%zR8&mK3',
    });
    check('Ответ смены пароля не содержит хеш и токен',
      afterChange.passwordHash === undefined && afterChange.confirmToken === undefined,
      `поля ответа: ${Object.keys(afterChange).join(', ')}`);

    // --- 12. Ранее созданные эндпоинты работают --------------------------
    const health = await request('GET', '/health');
    check('Эндпоинт /health по-прежнему возвращает OK',
      health.status === 200 && health.body?.status === 'OK');
    check('В перечне эндпоинтов указана оценка надёжности пароля',
      health.status === 200
      && Boolean((await request('GET', '/')).body?.endpoints?.passwordStrength));
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
      + 'пароли хешируются, пользователи сохраняются, смена пароля работает.');
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
