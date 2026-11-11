'use strict';

/**
 * Проверка сборки v0.22 (23-й день практики).
 *
 * Тема дня: Unit-тесты для валидации данных, назначения ячеек и смены статусов.
 * Критерий приёмки: написано не менее 15 тестов, все они проходят успешно.
 *
 * Сценарий запускает файл tests/unit.test.js отдельным процессом, разбирает
 * результат (протокол TAP встроенного тест-раннера Node.js) и проверяет
 * количество тестов по каждой теме. Затем запускаются все тесты проекта.
 *
 * Запуск:  node scripts/check-v0.22.js
 */

const path = require('path');
const { spawnSync } = require('child_process');

const config = require('../src/config');

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Запускает файл тестов и возвращает список пройденных и упавших тестов. */
function runTestFile(file) {
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });
  const lines = (result.stdout || '').split('\n');
  const passed = lines.filter((line) => /^ok \d+ - /.test(line)).map((line) => line.replace(/^ok \d+ - /, ''));
  const failed = lines.filter((line) => /^not ok \d+ - /.test(line)).map((line) => line.replace(/^not ok \d+ - /, ''));
  return { status: result.status, passed, failed };
}

function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — модульные тесты бизнес-логики`);
  console.log('='.repeat(78));

  const unit = runTestFile(path.join(config.rootDir, 'tests', 'unit.test.js'));
  const total = unit.passed.length + unit.failed.length;

  check('Файл модульных тестов tests/unit.test.js запускается', unit.status !== null);
  check('Написано не менее 15 тестов', total >= 15, `тестов: ${total}`);
  check('Все модульные тесты пройдены', unit.failed.length === 0 && unit.status === 0,
    unit.failed.length ? unit.failed.join('; ') : `пройдено: ${unit.passed.length}`);

  const topics = [
    ['валидация данных', 'валидация:', 5],
    ['назначение ячеек', 'ячейки:', 5],
    ['смена статусов', 'статусы:', 5],
  ];
  for (const [label, prefix, minimum] of topics) {
    const count = unit.passed.filter((name) => name.startsWith(prefix)).length;
    check(`Тема «${label}»: не менее ${minimum} тестов`, count >= minimum, `тестов: ${count}`);
  }

  unit.passed.forEach((name) => console.log(`           • ${name}`));

  // Все тесты проекта: новые тесты не должны ломать прежние
  const all = spawnSync(process.execPath, [path.join(config.rootDir, 'scripts', 'run-tests.js')], {
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });
  const sum = (key) => (all.stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'gm')) || [])
    .reduce((acc, line) => acc + Number(line.split(' ')[2]), 0);
  check('Все тесты проекта пройдены', all.status === 0, `тестов: ${sum('tests')}, ошибок: ${sum('fail')}`);

  const failed = results.filter((r) => !r.passed);
  console.log('-'.repeat(78));
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);
  if (failed.length === 0) {
    console.log(`РЕЗУЛЬТАТ: сборка v${config.version} соответствует критерию приёмки — `
      + `модульных тестов: ${total}, все проходят.`);
    console.log('='.repeat(78));
    return 0;
  }
  console.log('РЕЗУЛЬТАТ: сборка НЕ прошла проверку. Не пройденные проверки:');
  failed.forEach((r) => console.log(`  • ${r.name} (${r.detail})`));
  console.log('='.repeat(78));
  return 1;
}

process.exit(main());
