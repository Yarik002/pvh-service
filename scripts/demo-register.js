'use strict';

/**
 * Демонстрация работы API регистрации: последовательность запросов
 * с выводом фактических ответов сервера.
 *
 * Используется для иллюстрации работы API (скриншоты ответов для отчёта).
 * Запуск:  node scripts/demo-register.js
 */

const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-demo-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = 'error';       // вывод сервера не засоряет демонстрацию
process.env.RATE_LIMIT_MAX = '50';

const fs = require('fs');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

const PORT = 3103;
const BASE = `http://127.0.0.1:${PORT}`;

async function call(title, body) {
  const response = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();

  console.log('\n' + '='.repeat(76));
  console.log(`${title}`);
  console.log('='.repeat(76));
  console.log('ЗАПРОС:');
  console.log(`POST /api/auth/register`);
  console.log(JSON.stringify(body, null, 2));
  console.log(`\nОТВЕТ (HTTP ${response.status}):`);
  console.log(JSON.stringify(json, null, 2));
}

async function main() {
  getDb();
  runMigrations();

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  try {
    await call('1. Успешная регистрация', {
      name: 'Иванов Иван',
      email: 'ivanov@mail.ru',
      password: 'parol12345',
      passwordConfirm: 'parol12345',
    });

    await call('2. Повторная регистрация на тот же Email', {
      name: 'Петров Пётр',
      email: 'ivanov@mail.ru',
      password: 'parol12345',
      passwordConfirm: 'parol12345',
    });

    await call('3. Некорректный формат Email', {
      name: 'Иванов Иван',
      email: 'ivanov-mail.ru',
      password: 'parol12345',
      passwordConfirm: 'parol12345',
    });

    await call('4. Пароль и подтверждение не совпадают', {
      name: 'Иванов Иван',
      email: 'petrov@mail.ru',
      password: 'parol12345',
      passwordConfirm: 'parol54321',
    });

    await call('5. Пустая форма', {});

    // Показываем, что сохранено в базе данных
    const row = getDb()
      .prepare('SELECT id, name, email, role, is_confirmed, password_hash, confirm_token FROM Users')
      .get();

    console.log('\n' + '='.repeat(76));
    console.log('ЗАПИСЬ В БАЗЕ ДАННЫХ (таблица Users)');
    console.log('='.repeat(76));
    console.log(`id            : ${row.id}`);
    console.log(`name          : ${row.name}`);
    console.log(`email         : ${row.email}`);
    console.log(`role          : ${row.role}`);
    console.log(`is_confirmed  : ${row.is_confirmed}`);
    console.log(`password_hash : ${row.password_hash}`);
    console.log(`confirm_token : ${row.confirm_token}`);
    console.log(`\nПароль «parol12345» в базе данных отсутствует: ${!row.password_hash.includes('parol12345')}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${TMP_DB}${suffix}`, { force: true });
    }
  }
}

main().catch((error) => {
  console.error('Ошибка демонстрации:', error);
  process.exit(1);
});
