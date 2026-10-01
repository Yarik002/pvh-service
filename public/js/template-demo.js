'use strict';

/**
 * Сценарий страницы проверки шаблона.
 *
 * На странице демонстрируются все элементы оформления. Этот файл включает
 * интерактивные элементы, которые в обычных условиях настраиваются
 * сценариями конкретных страниц: переключатель видимости пароля
 * и кнопку вывода уведомления.
 */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  // Переключатель видимости пароля в демонстрационном поле
  var toggles = document.querySelectorAll('[data-password-toggle]');

  Array.prototype.forEach.call(toggles, function (button) {
    var inputId = button.getAttribute('data-password-toggle');
    var input = document.getElementById(inputId);

    if (input && window.PVH) {
      window.PVH.setupPasswordToggle(input, button);
    }
  });

  // Кнопки вывода уведомлений: показывают, как сообщения появляются
  // в реальных сценариях (например, после отправки формы)
  var demoButtons = [
    { id: 'demo-alert-success', type: 'success', title: 'Операция выполнена', text: 'Так выглядит сообщение об успешном действии.' },
    { id: 'demo-alert-danger', type: 'danger', title: 'Ошибка', text: 'Так выглядит сообщение об ошибке.' },
  ];

  Array.prototype.forEach.call(demoButtons, function (config) {
    var button = document.getElementById(config.id);
    if (!button) return;

    button.addEventListener('click', function () {
      if (window.PVH) window.PVH.showAlert(config.type, config.text, config.title);
    });
  });
});
