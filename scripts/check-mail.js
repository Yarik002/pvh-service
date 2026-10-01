'use strict';

/**
 * Диагностика настроек отправки почты.
 *
 * Проверяет, что параметры почтового сервера заполнены, устанавливает
 * соединение, проходит аутентификацию и выводит поддерживаемые сервером
 * возможности. Письма при этом не отправляются.
 *
 * Использование:
 *   npm run mail:check
 *
 * Типичные причины ошибок:
 *   535 — неверный пароль; для внешних сервисов требуется «пароль приложения»,
 *         а не пароль от почтового ящика;
 *   530 — сервер требует аутентификацию, а логин не указан;
 *   ECONNECT — неверный адрес или порт, либо соединение блокирует брандмауэр.
 */

const config = require('../src/config');
const logger = require('../src/utils/logger');
const mailer = require('../src/mail/mailer');

async function main() {
  console.log('='.repeat(74));
  console.log('ДИАГНОСТИКА ОТПРАВКИ ПОЧТЫ');
  console.log('='.repeat(74));

  const mode = mailer.getTransport();
  console.log(`Режим отправки (MAIL_TRANSPORT): ${config.mail.transport}`);
  console.log(`Фактически используется:        ${mode}`);
  console.log(`Адрес отправителя:              ${config.mail.fromAddress}`);
  console.log(`Адрес приложения:               ${config.appBaseUrl}`);
  console.log(`Срок действия ссылки:           ${config.mail.confirmTokenTtlHours} ч`);

  const settings = mailer.checkSmtpSettings();
  if (!settings.ok) {
    console.log(`\nНе заполнены обязательные настройки: ${settings.missing.join(', ')}`);
  }

  // --- Частые ошибки в настройках --------------------------------------
  // Проверки помогают сразу увидеть причину, по которой письма не уходят,
  // вместо разбора ответов почтового сервера
  const hints = [];

  const isGmail = /(^|\.)gmail\.com$/i.test(config.mail.smtp.host || '');
  const password = config.mail.smtp.password || '';

  if (!config.mail.fromAddress || config.mail.fromAddress.endsWith('.local')) {
    hints.push('Не указан MAIL_FROM. Укажите реальный адрес отправителя: '
      + 'многие почтовые серверы не принимают письма с вымышленных адресов.');
  }

  if (config.mail.smtp.user && config.mail.fromAddress
      && config.mail.fromAddress.toLowerCase() !== config.mail.smtp.user.toLowerCase()) {
    hints.push('Адрес отправителя (MAIL_FROM) не совпадает с логином (SMTP_USER). '
      + 'Gmail и большинство серверов подменяют адрес отправителя на свой — '
      + 'лучше указать их одинаковыми.');
  }

  if (isGmail && password) {
    // Пароль приложения Google состоит из 16 букв; пробелы в нём необязательны
    const normalized = password.replace(/\s+/g, '');
    if (!/^[A-Za-z]{16}$/.test(normalized)) {
      hints.push('Для Gmail в SMTP_PASSWORD указывается пароль приложения '
        + 'из 16 букв, а не обычный пароль от почты. '
        + 'Получение: myaccount.google.com → Безопасность → '
        + 'Двухэтапная аутентификация → Пароли приложений.');
    }
  }

  if (hints.length > 0) {
    console.log('\nНа что обратить внимание:');
    hints.forEach((hint) => console.log(`  • ${hint}`));
  }

  if (mode === 'log') {
    console.log('\nПисьма не отправляются, а выводятся в журнал сервера.');
    console.log('Чтобы включить реальную отправку, укажите в файле .env:');
    console.log('  MAIL_TRANSPORT=smtp');
    console.log('  SMTP_HOST=<адрес почтового сервера>');
    console.log('  SMTP_PORT=465');
    console.log('  SMTP_SECURE=true');
    console.log('  SMTP_USER=<логин>');
    console.log('  SMTP_PASSWORD=<пароль приложения>');
    console.log('='.repeat(74));
    return 0;
  }

  console.log(`\nПочтовый сервер: ${config.mail.smtp.host}:${config.mail.smtp.port}`
    + ` (${config.mail.smtp.secure ? 'шифрование TLS' : 'без шифрования'})`);
  console.log(`Логин: ${config.mail.smtp.user || '(не указан, вход без аутентификации)'}`);
  console.log('\nПроверка соединения…');

  const result = await mailer.verifyConnection();

  if (result.ok) {
    console.log(result.authenticated
      ? 'Соединение установлено, вход выполнен.'
      : 'Соединение установлено, вход не требуется.');

    if (result.capabilities.length > 0) {
      console.log('\nВозможности сервера:');
      for (const capability of result.capabilities) {
        console.log(`  ${capability}`);
      }
    }

    console.log('\nНастройки корректны — письма будут отправляться через этот сервер.');
  } else {
    console.log('Отправка письма невозможна.');
    console.log(`Причина: ${result.error}`);

    // Подсказки по коду ответа почтового сервера
    const errorText = String(result.error || '');

    if (/530|Authentication Required|требуется аутентификация/i.test(errorText)) {
      console.log('\nСервер требует вход. Заполните в файле .env:');
      console.log('  SMTP_USER=<полный адрес почтового ящика>');
      console.log('  SMTP_PASSWORD=<пароль приложения>');
    } else if (/535|неверный логин или пароль/i.test(errorText)) {
      console.log('\nЛогин или пароль отклонены сервером. Наиболее вероятные причины:');
      console.log('  • используется обычный пароль вместо пароля приложения;');
      console.log('  • в пароле приложения не включена двухэтапная аутентификация;');
      console.log('  • в SMTP_USER указан не полный адрес, а только имя ящика.');
    } else if (/ENOTFOUND|ECONNECT|ETIMEDOUT/i.test(errorText)) {
      console.log('\nНе удалось подключиться. Проверьте SMTP_HOST, SMTP_PORT '
        + 'и доступность сети.');
    } else {
      console.log('\nПроверьте значения SMTP_HOST, SMTP_PORT, SMTP_SECURE, '
        + 'SMTP_USER, SMTP_PASSWORD.');
    }
  }

  console.log('='.repeat(74));
  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    logger.error('Ошибка диагностики почты:', error);
    process.exit(1);
  });
