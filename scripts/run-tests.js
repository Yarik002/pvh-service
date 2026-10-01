'use strict';

/**
 * Запуск всех модульных тестов проекта.
 *
 * Скрипт последовательно запускает каждый файл tests/*.test.js в отдельном
 * процессе (как это делает встроенный тест-раннер Node.js) и подводит итог.
 *
 * Собственный запуск используется по двум причинам:
 *   • тест-раннер Node.js при передаче каталога требует явного указания файлов
 *     или маски, что неудобно при добавлении новых тестов;
 *   • каждый файл тестов получает собственное окружение (свою базу данных),
 *     поэтому тесты не влияют друг на друга.
 *
 * Запуск:  npm test
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.join(__dirname, '..', 'tests');

/** Находит файлы тестов, отсортированные по имени. */
function listTestFiles() {
  if (!fs.existsSync(TESTS_DIR)) return [];
  return fs
    .readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join(TESTS_DIR, name));
}

function main() {
  const files = listTestFiles();

  if (files.length === 0) {
    console.error('Файлы тестов не найдены в каталоге tests/');
    return 1;
  }

  console.log('='.repeat(78));
  console.log(`ЗАПУСК МОДУЛЬНЫХ ТЕСТОВ — файлов: ${files.length}`);
  console.log('='.repeat(78));

  const failed = [];

  for (const file of files) {
    const relative = path.relative(path.join(__dirname, '..'), file);
    console.log(`\n--- ${relative} ---\n`);

    // stdio: 'inherit' — вывод теста направляется напрямую в консоль
    const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });

    if (result.error) {
      console.error(`Не удалось запустить ${relative}: ${result.error.message}`);
      failed.push(relative);
    } else if (result.status !== 0) {
      failed.push(relative);
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  if (failed.length === 0) {
    console.log(`ИТОГ: все тесты пройдены (файлов: ${files.length})`);
    console.log('='.repeat(78));
    return 0;
  }

  console.log(`ИТОГ: тесты не пройдены в файлах: ${failed.join(', ')}`);
  console.log('='.repeat(78));
  return 1;
}

process.exit(main());
