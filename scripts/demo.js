'use strict';

/**
 * Запуск проекта для показа: npm run demo
 *
 * Сценарий готовит всё необходимое и запускает сервер:
 *   1) проверяет настройки и зависимости;
 *   2) при необходимости создаёт файл настроек и базу данных;
 *   3) применяет миграции;
 *   4) создаёт учётную запись администратора и справочник ячеек;
 *   5) запускает перехватчик писем (если он есть);
 *   6) запускает сервер и открывает страницы в браузере.
 *
 * После запуска открываются три вкладки: сайт, перехватчик писем
 * и сведения о сборке.
 */

const { spawn } = require('child_process');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const config = require('../src/config');
const logger = require('../src/utils/logger');

/** Каталог с программой перехватчика писем. */
const TOOLS_DIR = path.join(config.rootDir, 'tools');

/** Адрес сайта. */
const SITE_URL = 'http://127.0.0.1:3000';

/** Адрес панели перехватчика писем. */
const MAIL_URL = 'http://127.0.0.1:8025';

const children = [];

/** Выводит заголовок раздела. */
function section(title) {
  logger.info('');
  logger.info('='.repeat(74));
  logger.info(title);
  logger.info('='.repeat(74));
}

/** Проверяет, свободен ли порт. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** Проверяет, отвечает ли адрес. */
async function isResponding(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Выполняет сценарий проекта и дожидается его завершения. */
function runScript(script) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(config.rootDir, 'scripts', script)], {
      cwd: config.rootDir,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${script}: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Открывает адрес в браузере по умолчанию. */
function openBrowser(url) {
  const commands = {
    win32: ['cmd', ['/c', 'start', '', url]],
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]],
  };

  const [command, args] = commands[process.platform] || commands.linux;

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Если открыть браузер не удалось, адрес всё равно выведен в консоль
  }
}

async function main() {
  section('ЗАПУСК ПРОЕКТА ДЛЯ ПОКАЗА');
  logger.info(`Проект:  ${config.appName}`);
  logger.info(`Сборка:  v${config.version}`);
  logger.info(`Каталог: ${config.rootDir}`);

  // --- 1. Файл настроек -------------------------------------------------
  section('1. ПРОВЕРКА НАСТРОЕК');

  const envPath = path.join(config.rootDir, '.env');
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(path.join(config.rootDir, '.env.example'), envPath);
    logger.info('Создан файл настроек .env (скопирован из .env.example)');
  } else {
    logger.info('Файл настроек .env на месте');
  }

  logger.info(`Режим отправки почты: ${config.mail.transport}`);
  if (config.mail.transport === 'smtp') {
    logger.info(`Почтовый сервер: ${config.mail.smtp.host}:${config.mail.smtp.port}`);
  } else {
    logger.warn('Письма выводятся в журнал сервера, а не отправляются.');
    logger.warn('Для показа с почтовым ящиком укажите MAIL_TRANSPORT=smtp в файле .env.');
  }

  // --- 2. База данных ---------------------------------------------------
  section('2. ПОДГОТОВКА БАЗЫ ДАННЫХ');

  await runScript('migrate.js');
  logger.info('Миграции применены');

  await runScript('seed.js');
  logger.info('Начальные данные готовы');

  // --- 3. Перехватчик писем ---------------------------------------------
  section('3. ПЕРЕХВАТЧИК ПИСЕМ');

  const mailpitBinary = ['mailpit.exe', 'mailpit']
    .map((name) => path.join(TOOLS_DIR, name))
    .find((full) => fs.existsSync(full));

  let mailReady = await isResponding(`${MAIL_URL}/api/v1/info`);

  if (mailReady) {
    logger.info('Перехватчик писем уже запущен');
  } else if (!mailpitBinary) {
    logger.warn('Программа перехватчика не найдена — письма будут выводиться в журнал сервера.');
  } else if (!(await isPortFree(8025)) || !(await isPortFree(1025))) {
    logger.warn('Порты 1025 или 8025 заняты другой программой.');
    logger.warn('Если это контейнер Docker, письма смотрите в его панели.');
  } else {
    children.push(spawn(mailpitBinary, [
      '--smtp', '127.0.0.1:1025',
      '--listen', '127.0.0.1:8025',
      '--database', path.join(config.rootDir, 'data', 'mailpit.db'),
      '--max', '200',
    ], { stdio: 'ignore' }));

    // Ожидание запуска перехватчика
    for (let attempt = 0; attempt < 16 && !mailReady; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      mailReady = await isResponding(`${MAIL_URL}/api/v1/info`);
    }

    logger.info(mailReady
      ? 'Перехватчик писем запущен'
      : 'Перехватчик писем не ответил — письма будут выводиться в журнал сервера');
  }

  if (mailReady) {
    logger.info(`Письма принимаются по адресу 127.0.0.1:1025, смотреть: ${MAIL_URL}`);
  }

  // --- 4. Сервер --------------------------------------------------------
  section('4. ЗАПУСК СЕРВЕРА');

  if (!(await isPortFree(3000))) {
    logger.warn('Порт 3000 занят: возможно, сервер уже запущен.');
    logger.warn(`Откройте сайт: ${SITE_URL}`);
  } else {
    children.push(spawn(process.execPath, [path.join(config.rootDir, 'src', 'server.js')], {
      cwd: config.rootDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    }));

    let siteReady = false;
    for (let attempt = 0; attempt < 24 && !siteReady; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      siteReady = await isResponding(`${SITE_URL}/health`);
    }

    if (!siteReady) {
      logger.error('Сервер не ответил на проверку работоспособности.');
      return 1;
    }
  }

  // --- 5. Итог -----------------------------------------------------------
  section('ПРОЕКТ ГОТОВ К ПОКАЗУ');

  logger.info(`Сайт:                 ${SITE_URL}`);
  logger.info(`Эндпоинт проверки:    ${SITE_URL}/health`);
  logger.info(`Сведения о сборке:    ${SITE_URL}/api`);
  if (mailReady) {
    logger.info(`Письма (перехватчик): ${MAIL_URL}`);
  }
  logger.info('');
  logger.info('Учётная запись администратора:');
  logger.info(`  адрес:  ${config.seed.adminEmail}`);
  logger.info(`  пароль: ${config.seed.adminPassword || 'Admin#2026Pvh'}`);
  logger.info('');
  logger.info('Порядок показа описан в файле docs/Как_показать_проект.md');
  logger.info('');
  logger.info('Для остановки нажмите Ctrl+C.');
  logger.info('='.repeat(74));

  if (process.env.DEMO_NO_BROWSER !== '1') {
    openBrowser(SITE_URL);
    if (mailReady) {
      setTimeout(() => openBrowser(MAIL_URL), 1200);
    }
  }

  // --- Остановка ---------------------------------------------------------
  const shutdown = () => {
    logger.info('');
    logger.info('Остановка проекта…');
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // Процесс уже завершён
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return null;
}

main()
  .then((code) => {
    if (code !== null && code !== undefined) process.exit(code);
  })
  .catch((error) => {
    logger.error('Не удалось запустить проект:', error.message);
    process.exit(1);
  });
