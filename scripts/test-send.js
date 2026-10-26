'use strict';

// Проверка реальной отправки письма через Resend
const mailer = require('../src/mail/mailer');
const config = require('../src/config');
const { closeDb } = require('../src/db/connection');

const recipient = process.argv[2] || 'erder101@gmail.com';

(async () => {
  console.log('Режим:', mailer.getTransport());
  console.log('Сервис:', config.mail.api.provider);
  console.log('Отправитель:', config.mail.fromAddress);
  console.log('Получатель:', recipient);
  console.log('-'.repeat(60));

  const result = await mailer.sendMail({
    to: { address: recipient, name: 'Проверка' },
    subject: 'Проверка отправки — Сервис ПВЗ',
    text: 'Это проверочное письмо из проекта «Сервис трекинга заказов». '
      + 'Если вы его видите, отправка на реальную почту работает.',
    html: '<p>Это проверочное письмо из проекта <strong>«Сервис трекинга заказов»</strong>.</p>'
      + '<p>Если вы его видите, отправка на реальную почту работает.</p>',
  });

  console.log('Результат:', result.status);
  if (result.messageId) console.log('Идентификатор письма:', result.messageId);
  if (result.error) console.log('Ошибка:', result.error);

  closeDb();
  process.exit(result.status === 'sent' ? 0 : 1);
})();
