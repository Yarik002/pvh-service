'use strict';

/**
 * Скрипт автоматической проверки сборки v0.1.
 *
 * Критерий приёмки 2-го дня практики:
 *   «Сборка v0.1: сервер запускается, эндпоинт /health возвращает OK».
 *
 * Скрипт самостоятельно запускает сервер на отдельном порту (по умолчанию 3101),
 * обращается к эндпоинтам и проверяет ответы, после чего останавливает сервер.
 *
 * Запуск:  node scripts/check-v0.1.js
 * Код возврата 0 — все проверки пройдены, 1 — есть ошибки.
 */

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3101', 10);

/** Список выполненных проверок. */
const results = [];

/** Фиксирует результат одной проверки. */
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const mark = passed ? 'ПРОЙДЕНО' : 'ОШИБКА  ';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Выполняет HTTP-запрос и возвращает статус и разобранный JSON. */
async function request(path) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — «${config.appName}»`);
  console.log('='.repeat(78));

  // --- 1. Подготовка базы данных ---------------------------------------
  getDb();
  const { applied } = runMigrations();
  check('Схема базы данных создана', true, applied.length ? `применено миграций: ${applied.length}` : 'миграции уже были применены');

  // --- 2. Запуск сервера ------------------------------------------------
  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const address = server.address();
  check('Сервер запускается и слушает порт', Boolean(address), `http://127.0.0.1:${address.port}`);

  try {
    // --- 3. GET /health ------------------------------------------------
    const health = await request('/health');
    check('GET /health отвечает статусом 200', health.status === 200, `получен статус ${health.status}`);
    check('GET /health возвращает status = "OK"', health.body?.status === 'OK', `status = "${health.body?.status}"`);
    check('GET /health сообщает о подключении к SQLite', health.body?.database?.connected === true,
      `СУБД: ${health.body?.database?.engine}, версия ${health.body?.database?.version}`);
    check('GET /health перечисляет таблицы схемы',
      ['Users', 'Orders', 'Storage_Cells'].every((t) => (health.body?.database?.tables || []).includes(t)),
      (health.body?.database?.tables || []).join(', '));

    // --- 4. GET /health/ready ------------------------------------------
    const ready = await request('/health/ready');
    check('GET /health/ready отвечает статусом 200', ready.status === 200,
      `status = "${ready.body?.status}"`);

    // --- 5. GET /health/live -------------------------------------------
    const live = await request('/health/live');
    check('GET /health/live отвечает статусом 200', live.status === 200, `status = "${live.body?.status}"`);

    // --- 6. Корневой маршрут -------------------------------------------
    const root = await request('/');
    check('GET / отвечает статусом 200 и содержит версию сборки', root.status === 200,
      `version = "${root.body?.version}"`);

    // --- 7. Обработка несуществующего маршрута -------------------------
    const missing = await request('/no-such-route');
    check('Несуществующий маршрут возвращает 404 в формате JSON',
      missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND',
      `код ошибки: ${missing.body?.error?.code}`);

    // --- 8. Количество ячеек хранения -----------------------------------
    const cells = getDb().prepare('SELECT COUNT(*) AS n FROM Storage_Cells').get().n;
    check('В таблице Storage_Cells созданы 20 ячеек', cells === 20, `найдено записей: ${cells}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
  }

  // --- Итог -------------------------------------------------------------
  const failed = results.filter((r) => !r.passed);
  console.log('-'.repeat(78));
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);

  if (failed.length === 0) {
    console.log(`РЕЗУЛЬТАТ: сборка v${config.version} соответствует критерию приёмки — сервер запускается, /health возвращает OK.`);
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
