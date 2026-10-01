'use strict';

/**
 * Базовые тесты сборки v0.1 (сервер, база данных, эндпоинт /health).
 *
 * Запуск:  npm test   (используется встроенный модуль node:test, версия Node.js >= 20)
 *
 * Примечание: полноценный набор Unit-тестов серверной логики создаётся
 * на 23-й день практики. Этот файл фиксирует работоспособность каркаса.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Тестовое окружение: отдельная база данных в памяти, минимальный уровень логов
process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';

const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

/** Поднимает приложение на свободном порту и возвращает адрес и функцию остановки. */
async function startTestServer() {
  getDb();
  runMigrations();

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('GET /health возвращает 200 и status = OK', async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.status, 'OK');
    assert.equal(body.database.engine, 'SQLite');
    assert.equal(body.database.connected, true);
  } finally {
    await stop();
  }
});

test('GET /health/ready подтверждает наличие всех трёх таблиц', async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/health/ready`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'READY');
    for (const table of ['Users', 'Orders', 'Storage_Cells']) {
      assert.ok(body.tables.includes(table), `в ответе отсутствует таблица ${table}`);
    }
  } finally {
    await stop();
  }
});

test('Схема базы данных создаёт 20 свободных ячеек хранения', () => {
  getDb();
  runMigrations();

  const row = getDb()
    .prepare("SELECT COUNT(*) AS total, SUM(status = 'Свободна') AS free FROM Storage_Cells")
    .get();

  assert.equal(row.total, 20);
  assert.equal(row.free, 20);
  closeDb();
});

test('Несуществующий маршрут возвращает 404 в формате JSON', async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/unknown`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'NOT_FOUND');
  } finally {
    await stop();
  }
});
