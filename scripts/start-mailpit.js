'use strict';

/**
 * Запуск перехватчика писем Mailpit.
 *
 * Mailpit принимает письма по протоколу SMTP и показывает их в браузере.
 * Он нужен для показа работы приложения: письмо с ссылкой подтверждения
 * реально отправляется по SMTP, но не уходит в интернет, а остаётся
 * в локальном ящике — его видно и можно проверить.
 *
 * Использование:
 *   npm run mail:start
 *
 * Затем открыть панель: http://127.0.0.1:8025
 *
 * Программа mailpit.exe находится в каталоге tools. Если её там нет,
 * сценарий сообщит, откуда её скачать.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const config = require('../src/config');

/** Каталог с программой перехватчика. */
const TOOLS_DIR = path.join(config.rootDir, 'tools');

/** Возможные имена программы в зависимости от системы. */
const CANDIDATES = ['mailpit.exe', 'mailpit'];

/** Порт панели просмотра писем. */
const UI_PORT = 8025;

/** Порт приёма писем по SMTP. */
const SMTP_PORT = 1025;

/** Находит программу перехватчика. */
function findBinary() {
  for (const name of CANDIDATES) {
    const full = path.join(TOOLS_DIR, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
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

/** Проверяет, отвечает ли уже запущенная панель. */
async function isAlreadyRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${UI_PORT}/api/v1/info`, {
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log('='.repeat(74));
  console.log('ПЕРЕХВАТЧИК ПИСЕМ MAILPIT');
  console.log('='.repeat(74));

  if (await isAlreadyRunning()) {
    console.log('Перехватчик уже запущен.');
    console.log(`Панель просмотра писем: http://127.0.0.1:${UI_PORT}`);
    return 0;
  }

  const binary = findBinary();

  if (!binary) {
    console.error(`Программа перехватчика не найдена в каталоге: ${TOOLS_DIR}`);
    console.error('');
    console.error('Скачайте архив mailpit-windows-amd64.zip со страницы:');
    console.error('  https://github.com/axllent/mailpit/releases/latest');
    console.error(`и распакуйте файл mailpit.exe в каталог: ${TOOLS_DIR}`);
    console.error('');
    console.error('Либо запустите проект в контейнерах: docker compose up -d');
    return 1;
  }

  for (const [port, label] of [[SMTP_PORT, 'приёма писем'], [UI_PORT, 'панели просмотра']]) {
    if (!(await isPortFree(port))) {
      console.error(`Порт ${port} (${label}) уже занят другой программой.`);
      console.error('Закройте программу, занимающую порт, и повторите запуск.');
      return 1;
    }
  }

  // Почтовый ящик хранится в файле в каталоге проекта: системный каталог
  // временных файлов может быть недоступен для записи
  const dataDir = path.join(config.rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const database = path.join(dataDir, 'mailpit.db');

  console.log(`Программа: ${binary}`);
  console.log(`Приём писем:  127.0.0.1:${SMTP_PORT}`);
  console.log(`Панель писем: http://127.0.0.1:${UI_PORT}`);
  console.log('-'.repeat(74));
  console.log('Оставьте это окно открытым. Для остановки нажмите Ctrl+C.');
  console.log('='.repeat(74));

  const child = spawn(binary, [
    '--smtp', `127.0.0.1:${SMTP_PORT}`,
    '--listen', `127.0.0.1:${UI_PORT}`,
    '--database', database,
    '--max', '200',
  ], { stdio: 'inherit' });

  child.on('exit', (code) => {
    console.log(`\nПерехватчик писем остановлен (код ${code}).`);
    process.exit(code ?? 0);
  });

  // При остановке сценария останавливается и перехватчик
  const stop = () => {
    child.kill();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return null;
}

main()
  .then((code) => {
    if (code !== null && code !== undefined) process.exit(code);
  })
  .catch((error) => {
    console.error('Ошибка запуска перехватчика:', error.message);
    process.exit(1);
  });
