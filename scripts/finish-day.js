'use strict';

/**
 * Завершение рабочего дня практики.
 *
 * Скрипт проверяет, что состояние проекта зафиксировано в системе контроля
 * версий: показывает незакоммиченные изменения и напоминает о необходимости
 * коммита и тега версии.
 *
 * Копии проекта в каталоги дней практики НЕ создаются: весь исходный код
 * ведётся только в основном каталоге проекта (pvh-service), а история
 * изменений хранится в Git — в любой момент можно получить состояние кода
 * на конец конкретного дня командой git checkout <тег>.
 *
 * Запуск:  node scripts/finish-day.js <номер дня>
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const logger = require('../src/utils/logger');

/** Каталог отчётов по дням практики. */
const PRACTICE_ROOT = path.resolve(config.rootDir, '..');
const REPORTS_ROOT = path.join(PRACTICE_ROOT, 'Разработка');

/** Выполняет команду Git и возвращает её вывод. */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: config.rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return `(команда git ${args.join(' ')} завершилась ошибкой: ${error.message})`;
  }
}

/** Проверяет наличие отчёта за указанный день. */
function reportStatus(day) {
  const dayDir = path.join(REPORTS_ROOT, `день ${day}`);

  if (!fs.existsSync(dayDir)) {
    return { ok: false, message: `каталог отсутствует: ${dayDir}` };
  }

  const files = fs.readdirSync(dayDir);
  const wordReport = files.find((name) => name.toLowerCase().endsWith('.docx'));
  const markdownReport = files.find((name) => name.toLowerCase().endsWith('.md'));

  if (!wordReport) {
    return { ok: false, message: 'нет отчёта в формате Word' };
  }

  return {
    ok: true,
    message: `отчёт: ${wordReport}${markdownReport ? `, ${markdownReport}` : ''}`,
  };
}

function main() {
  const day = Number.parseInt(process.argv[2], 10);

  if (!Number.isInteger(day) || day < 1 || day > 99) {
    console.error('Укажите номер дня практики, например:  node scripts/finish-day.js 7');
    process.exit(1);
  }

  logger.info('='.repeat(74));
  logger.info(`ЗАВЕРШЕНИЕ ${day}-ГО ДНЯ ПРАКТИКИ`);
  logger.info('='.repeat(74));

  // --- Состояние репозитория -------------------------------------------
  const status = git(['status', '--short']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const lastCommit = git(['log', '-1', '--pretty=format:%h %s']);
  const tags = git(['tag', '--sort=version:refname']).split('\n').filter(Boolean);

  logger.info(`Ветка:            ${branch}`);
  logger.info(`Последний коммит: ${lastCommit}`);
  logger.info(`Теги версий:      ${tags.join(', ') || '(нет)'}`);

  if (status === '') {
    logger.info('Незакоммиченных изменений нет');
  } else {
    logger.warn('Есть незакоммиченные изменения:');
    for (const line of status.split('\n')) logger.warn(`  ${line}`);
    logger.warn('Выполните коммит:  git add -A && git commit -m "День N: …"');
  }

  // --- Отчёт за день ----------------------------------------------------
  const report = reportStatus(day);
  if (report.ok) {
    logger.info(`Отчёт за ${day}-й день: ${report.message}`);
  } else {
    logger.warn(`Отчёт за ${day}-й день: ${report.message}`);
  }

  // --- Итог -------------------------------------------------------------
  logger.info('-'.repeat(74));
  logger.info('Напоминание: отчёты по дням хранятся только в каталоге «Разработка»,');
  logger.info('исходный код — только в основном каталоге проекта. Состояние кода на конец');
  logger.info('любого дня доступно из истории Git:  git checkout <тег>');
  logger.info('='.repeat(74));
}

try {
  main();
} catch (error) {
  logger.error('Ошибка при завершении дня:', error);
  process.exit(1);
}
