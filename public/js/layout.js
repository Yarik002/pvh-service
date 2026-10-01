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

  /** Ключ, под которым выбранная тема сохраняется в localStorage. */
  var THEME_KEY = 'pvh.theme';

  /**
   * Применяет тему оформления.
   * @param {'light'|'dark'} theme
   */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;

    var button = document.getElementById('theme-toggle');
    if (button) {
      var isDark = theme === 'dark';
      button.setAttribute('aria-pressed', String(isDark));
      button.setAttribute('title', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
      button.setAttribute('aria-label', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
      button.innerHTML = '<span aria-hidden="true">' + (isDark ? '☀' : '☾') + '</span>';
    }
  }

  /** Определяет тему: сохранённую пользователем либо системную. */
  function resolveTheme() {
    var saved = null;
    try {
      saved = window.localStorage.getItem(THEME_KEY);
    } catch (error) {
      // Доступ к localStorage может быть запрещён настройками браузера
      saved = null;
    }

    if (saved === 'light' || saved === 'dark') return saved;

    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  }

  /** Переключает тему и сохраняет выбор пользователя. */
  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var next = current === 'dark' ? 'light' : 'dark';

    applyTheme(next);

    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch (error) {
      // Если сохранить не удалось, тема всё равно применена до перезагрузки
    }
  }

  /** Настраивает кнопку переключения темы. */
  function setupTheme() {
    applyTheme(resolveTheme());

    var button = document.getElementById('theme-toggle');
    if (button) button.addEventListener('click', toggleTheme);

    // Если пользователь тему не выбирал, следуем за настройкой системы
    if (window.matchMedia) {
      var query = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        var saved = null;
        try {
          saved = window.localStorage.getItem(THEME_KEY);
        } catch (error) {
          saved = null;
        }
        if (!saved) applyTheme(query.matches ? 'dark' : 'light');
      };

      if (query.addEventListener) query.addEventListener('change', onChange);
      else if (query.addListener) query.addListener(onChange);   // старые браузеры
    }
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

  document.addEventListener('DOMContentLoaded', function () {
    setupTheme();
    setupMenu();
    setupLogout();

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
