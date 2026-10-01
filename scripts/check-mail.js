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
    console.log('Соединение установлено, аутентификация пройдена.');
    if (result.capabilities.length > 0) {
      console.log('\nВозможности сервера:');
      for (const capability of result.capabilities) {
        console.log(`  ${capability}`);
      }
    }
    console.log('\nНастройки корректны — письма будут отправляться через этот сервер.');
  } else {
    console.log('Не удалось установить соединение или пройти аутентификацию.');
    console.log(`Причина: ${result.error}`);
    console.log('\nПроверьте значения SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD.');
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
