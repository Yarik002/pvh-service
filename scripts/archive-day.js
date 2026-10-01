'use strict';

/**
 * Копирование текущего состояния проекта в архив дня практики.
 *
 * Запуск из корня проекта:
 *   node scripts/archive-day.js 2
 *
 * Результат: каталог «Разработка\день N\Проект» со снимком исходного кода
 * на конец дня. Служебные файлы (node_modules, .git, файлы базы данных,
 * локальный файл .env) в архив не попадают.
 *
 * Такой снимок позволяет восстановить состояние проекта на любой день
 * и наглядно показывает объём работы, выполненной за день.
 */

const fs = require('fs');
const path = require('path');

const logger = require('../src/utils/logger');
const config = require('../src/config');

/** Каталоги, не попадающие в архив */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'coverage', 'dist', 'logs']);

/** Шаблоны имён файлов, не попадающих в архив */
const EXCLUDE_FILE_PATTERNS = [
  /\.db$/i,
  /\.db-(wal|shm|journal)$/i,
  /^\.env$/,
  /^\.env\.(local|.*\.local)$/,
];

/** Проверяет, нужно ли пропустить файл или каталог. */
function isExcluded(name) {
  return EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Рекурсивно копирует каталог, пропуская служебные файлы.
 * @returns {number} количество скопированных файлов
 */
function copyTree(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  let count = 0;

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name) || isExcluded(entry.name)) continue;

    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      count += copyTree(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
      count += 1;
    }
  }

  return count;
}

function main() {
  const day = Number.parseInt(process.argv[2], 10);

  if (!Number.isInteger(day) || day < 1 || day > 99) {
    console.error('Укажите номер дня практики, например:  node scripts/archive-day.js 2');
    process.exit(1);
  }

  const projectRoot = config.rootDir;
  // Корень практики — на два уровня выше каталога проекта
  const practiceRoot = path.resolve(projectRoot, '..');
  const targetDir = path.join(practiceRoot, 'Разработка', `день ${day}`, 'Проект');

  logger.info(`Источник:  ${projectRoot}`);
  logger.info(`Назначение: ${targetDir}`);

  if (fs.existsSync(targetDir)) {
    logger.info('Удаление предыдущей версии архива…');
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  const fileCount = copyTree(projectRoot, targetDir);
  logger.info(`Готово. Скопировано файлов: ${fileCount}`);
}

try {
  main();
} catch (error) {
  logger.error('Не удалось создать архив дня:', error);
  process.exit(1);
}
