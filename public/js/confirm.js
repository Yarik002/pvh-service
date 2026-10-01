'use strict';

/**
 * Страница подтверждения адреса электронной почты.
 *
 * Если пользователь пришёл по ссылке вида /api/auth/confirm?token=…,
 * сервер сам выполняет проверку токена и перенаправляет сюда, передавая
 * результат в параметрах запроса. Этот сценарий дополняет страницу:
 * подставляет адрес электронной почты в форму повторной отправки письма.
 */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  var form = document.getElementById('resend-form');
  if (!form) return;

  var emailInput = form.querySelector('[name="email"]');
  var submitButton = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (window.PVH) window.PVH.clearAlerts();

    var email = String(emailInput.value || '').trim();
    if (email === '') {
      window.PVH_FORM.setFieldError('email', 'Укажите адрес электронной почты');
      return;
    }

    window.PVH_FORM.setBusy(submitButton, true, 'Отправка…');

    window.PVH_API.resendConfirmation({ email: email })
      .then(function (data) {
        window.PVH_FORM.setBusy(submitButton, false);

        var mail = (data && data.confirmationEmail) || {};

        if (mail.sent) {
          window.PVH.showAlert('success',
            'Письмо со ссылкой подтверждения отправлено. Проверьте почту.', 'Готово');
          return;
        }

        window.PVH.showAlert('warning',
          mail.logged
            ? 'Отправка писем не настроена. Ссылка для подтверждения выведена '
              + 'в журнал сервера.'
            : 'Не удалось отправить письмо' + (mail.error ? ': ' + mail.error : '.'),
          'Письмо не отправлено');
      })
      .catch(function (error) {
        window.PVH_FORM.setBusy(submitButton, false);
        window.PVH_FORM.reportError(error);
      });
  });
});
