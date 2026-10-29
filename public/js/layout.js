'use strict';

/**
 * Общие сценарии интерфейса: переключение меню на мобильных устройствах,
 * смена темы оформления, работа с уведомлениями.
 *
 * Файл подключается на каждой странице приложения. Он не зависит
 * от библиотек и написан на чистом JavaScript.
 */

(function () {
  'use strict';

  /**
   * Ключ, под которым выбранная тема сохраняется в localStorage.
   * Совпадает с ключом в модуле theme.js.
   */
  var THEME_KEY = 'pvh.theme';

  /** Сколько длится плавная смена цветов при переключении темы, мс. */
  var THEME_TRANSITION_MS = 300;

  /**
   * Модуль темы (public/js/theme.js). Он подключается в <head> раньше
   * этого файла и к моменту загрузки страницы уже применил тему.
   */
  function themeModule() {
    return window.PVH_THEME || null;
  }

  /**
   * Обновляет вид кнопки: значок, подсказку и состояние для программ
   * чтения с экрана. На кнопке показывается текущий режим, а в подсказке —
   * какой режим включится по нажатию.
   *
   * @param {'light'|'dark'|'system'} mode
   */
  function updateThemeButton(mode) {
    var button = document.getElementById('theme-toggle');
    var theme = themeModule();
    if (!button || !theme) return;

    var next = theme.nextMode(mode);
    var text = 'Тема: ' + theme.LABELS[mode] + '. Нажмите, чтобы выбрать: ' + theme.LABELS[next];

    button.setAttribute('aria-pressed', String(theme.resolve(mode) === 'dark'));
    button.setAttribute('title', text);
    button.setAttribute('aria-label', text);
    button.setAttribute('data-mode', mode);
    button.innerHTML = '<span aria-hidden="true">' + theme.ICONS[mode] + '</span>';
  }

  /**
   * Включает плавную смену цветов на время переключения темы.
   * Пользователям, отключившим анимацию в системе, смена показывается сразу.
   */
  function withThemeTransition(change) {
    var root = document.documentElement;
    var reduceMotion = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduceMotion) {
      change();
      return;
    }

    root.classList.add('theme-transition');
    change();
    window.setTimeout(function () {
      root.classList.remove('theme-transition');
    }, THEME_TRANSITION_MS);
  }

  /**
   * Применяет режим темы: светлая, тёмная или «как в системе».
   * Оставлена для совместимости со сценариями страниц.
   *
   * @param {'light'|'dark'|'system'} mode
   */
  function applyTheme(mode) {
    var theme = themeModule();

    if (theme) {
      theme.apply(mode);
    } else {
      // Модуль темы не загрузился: применяем светлую или тёмную тему напрямую
      var value = mode === 'dark' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', value);
      document.documentElement.style.colorScheme = value;
    }

    updateThemeButton(mode);
  }

  /** Переключает режим по кругу и сохраняет выбор пользователя в localStorage. */
  function toggleTheme() {
    var theme = themeModule();
    if (!theme) return;

    var next = theme.nextMode(theme.readMode());
    theme.saveMode(next);

    withThemeTransition(function () {
      applyTheme(next);
    });

    // Сообщение для программ чтения с экрана: значок на кнопке им не виден
    var status = document.getElementById('theme-status');
    if (status) status.textContent = 'Тема оформления: ' + theme.LABELS[next];
  }

  /** Настраивает кнопку переключения темы. */
  function setupTheme() {
    var theme = themeModule();
    if (!theme) return;

    updateThemeButton(theme.readMode());

    var button = document.getElementById('theme-toggle');
    if (button) button.addEventListener('click', toggleTheme);

    // В режиме «как в системе» тема меняется вслед за настройкой системы,
    // например при автоматическом включении тёмной темы вечером
    if (window.matchMedia) {
      var query = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (theme.readMode() === 'system') applyTheme('system');
      };

      if (query.addEventListener) query.addEventListener('change', onChange);
      else if (query.addListener) query.addListener(onChange);   // старые браузеры
    }

    // Выбор, сделанный в другой вкладке, сразу применяется и в этой:
    // браузер сообщает об изменении localStorage событием storage
    window.addEventListener('storage', function (event) {
      if (event.key === THEME_KEY || event.key === null) {
        applyTheme(theme.readMode());
      }
    });
  }

  /** Закрывает меню на мобильных устройствах. */
  function closeMenu() {
    var nav = document.getElementById('main-nav');
    var toggle = document.getElementById('menu-toggle');
    if (!nav || !toggle) return;

    nav.classList.remove('nav--open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  /** Настраивает кнопку меню на мобильных устройствах. */
  function setupMenu() {
    var nav = document.getElementById('main-nav');
    var toggle = document.getElementById('menu-toggle');
    if (!nav || !toggle) return;

    toggle.addEventListener('click', function () {
      var isOpen = nav.classList.toggle('nav--open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });

    // Закрываем меню после перехода по ссылке
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeMenu();
    });

    // Закрываем меню по клавише Esc
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
    });

    // При переходе на широкий экран меню должно вернуться в обычное состояние
    window.addEventListener('resize', function () {
      if (window.innerWidth > 768) closeMenu();
    });
  }

  /**
   * Показывает уведомление на странице.
   *
   * @param {string} type 'success' | 'warning' | 'danger' | 'info'
   * @param {string} message текст сообщения
   * @param {string} [title] заголовок уведомления
   */
  function showAlert(type, message, title) {
    var container = document.getElementById('alerts');
    if (!container) return;

    var icons = { success: '✓', warning: '!', danger: '✕', info: 'i' };

    var alert = document.createElement('div');
    alert.className = 'alert alert--' + type;
    alert.setAttribute('role', type === 'danger' ? 'alert' : 'status');

    var icon = document.createElement('span');
    icon.className = 'alert__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = icons[type] || 'i';

    var body = document.createElement('div');
    body.className = 'alert__body';

    if (title) {
      var heading = document.createElement('strong');
      heading.className = 'alert__title';
      heading.textContent = title;
      body.appendChild(heading);
    }

    body.appendChild(document.createTextNode(message));
    alert.appendChild(icon);
    alert.appendChild(body);
    container.appendChild(alert);

    return alert;
  }

  /** Убирает все показанные уведомления. */
  function clearAlerts() {
    var container = document.getElementById('alerts');
    if (container) container.textContent = '';
  }

  /**
   * Переключает видимость пароля в поле ввода.
   * @param {HTMLInputElement} input
   * @param {HTMLButtonElement} button
   */
  function setupPasswordToggle(input, button) {
    button.addEventListener('click', function () {
      var isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      button.textContent = isHidden ? 'Скрыть' : 'Показать';
      button.setAttribute('aria-label', isHidden ? 'Скрыть пароль' : 'Показать пароль');
    });
  }

  /**
   * Подключает обработку кнопки выхода из системы.
   *
   * Сессия завершается на сервере (POST /api/auth/logout), после чего
   * пользователь возвращается на главную страницу. Токен хранится
   * в cookie, поэтому дополнительно передавать его не требуется.
   */
  function setupLogout() {
    var button = document.getElementById('logout-button');
    if (!button) return;

    button.addEventListener('click', function () {
      button.disabled = true;
      button.textContent = 'Выход…';

      window.fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
        .then(function () {
          window.location.href = '/';
        })
        .catch(function () {
          // Даже при ошибке сети возвращаемся на главную: серверная сессия
          // будет завершена по истечении срока действия
          window.location.href = '/';
        });
    });
  }

  // --- Инициализация при загрузке страницы -------------------------------

  /**
   * Подключает все кнопки «Показать пароль» на странице.
   * Кнопка связана с полем атрибутом data-password-toggle="<id поля>".
   */
  function setupPasswordToggles() {
    var buttons = document.querySelectorAll('[data-password-toggle]');

    Array.prototype.forEach.call(buttons, function (button) {
      // Повторное подключение исключается: иначе одно нажатие
      // переключало бы поле дважды и ничего бы не менялось
      if (button.getAttribute('data-toggle-ready') === 'true') return;

      var input = document.getElementById(button.getAttribute('data-password-toggle'));
      if (!input) return;

      setupPasswordToggle(input, button);
      button.setAttribute('data-toggle-ready', 'true');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    setupTheme();
    setupMenu();
    setupLogout();
    setupPasswordToggles();

    // Показываем сохранённое уведомление из sessionStorage: используется
    // при переходе между страницами (например, после регистрации)
    try {
      var pending = window.sessionStorage.getItem('pvh.alert');
      if (pending) {
        var parsed = JSON.parse(pending);
        showAlert(parsed.type, parsed.message, parsed.title);
        window.sessionStorage.removeItem('pvh.alert');
      }
    } catch (error) {
      // Некорректные данные игнорируются
    }
  });

  // --- Публичный интерфейс модуля ---------------------------------------
  // Используется сценариями отдельных страниц (регистрация, вход)
  window.PVH = {
    showAlert: showAlert,
    clearAlerts: clearAlerts,
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,
    setupPasswordToggle: setupPasswordToggle,
    setupPasswordToggles: setupPasswordToggles,
    setupLogout: setupLogout,
    setPendingAlert: function (type, message, title) {
      try {
        window.sessionStorage.setItem('pvh.alert', JSON.stringify({
          type: type, message: message, title: title,
        }));
      } catch (error) {
        // Если сохранить не удалось, сообщение будет показано на текущей странице
      }
    },
    THEME_KEY: THEME_KEY,
  };
}());
