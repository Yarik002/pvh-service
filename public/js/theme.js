'use strict';

/**
 * Тема оформления: светлая, тёмная или «как в системе».
 *
 * Файл подключается в <head> БЕЗ атрибута defer, до таблицы стилей.
 * Поэтому он выполняется раньше, чем браузер отрисует страницу, и сразу
 * выставляет нужную тему. Если подключить его в конце страницы, при каждой
 * загрузке сначала мелькала бы светлая тема, а затем включалась тёмная.
 *
 * Выбор пользователя хранится в localStorage под ключом pvh.theme:
 *   light  — всегда светлая тема;
 *   dark   — всегда тёмная тема;
 *   system — тема следует настройке операционной системы (по умолчанию).
 *
 * Кнопка переключения в шапке подключается в layout.js и использует
 * функции этого модуля (window.PVH_THEME).
 */

(function (window, document) {
  'use strict';

  /** Ключ, под которым выбор хранится в localStorage. */
  var STORAGE_KEY = 'pvh.theme';

  /** Режимы в порядке переключения кнопкой. */
  var MODES = ['light', 'dark', 'system'];

  /** Подписи режимов для кнопки и подсказок. */
  var LABELS = {
    light: 'светлая',
    dark: 'тёмная',
    system: 'как в системе',
  };

  /** Значки режимов на кнопке. */
  var ICONS = {
    light: '☀',
    dark: '☾',
    system: '◐',
  };

  var root = document.documentElement;

  /**
   * Читает сохранённый режим.
   * Неизвестное значение или недоступное хранилище — режим «как в системе».
   * @returns {'light'|'dark'|'system'}
   */
  function readMode() {
    var saved = null;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      // Хранилище может быть запрещено настройками браузера
      saved = null;
    }
    return MODES.indexOf(saved) >= 0 ? saved : 'system';
  }

  /**
   * Сохраняет выбранный режим.
   * @param {'light'|'dark'|'system'} mode
   * @returns {boolean} удалось ли сохранить
   */
  function saveMode(mode) {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
      return true;
    } catch (error) {
      // Тема всё равно применится, но не сохранится до перезагрузки
      return false;
    }
  }

  /** Тема, выбранная в операционной системе. */
  function systemTheme() {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? 'dark' : 'light';
  }

  /**
   * Определяет фактическую тему для режима.
   * @param {'light'|'dark'|'system'} mode
   * @returns {'light'|'dark'}
   */
  function resolve(mode) {
    return mode === 'system' ? systemTheme() : mode;
  }

  /**
   * Применяет режим к странице.
   *
   * Атрибут data-theme содержит фактическую тему (по нему работает таблица
   * стилей), атрибут data-theme-mode — выбор пользователя (по нему
   * оформляется кнопка).
   *
   * @param {'light'|'dark'|'system'} mode
   * @returns {'light'|'dark'} применённая тема
   */
  function apply(mode) {
    var theme = resolve(mode);
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-mode', mode);
    root.style.colorScheme = theme;
    return theme;
  }

  /** Следующий режим по кругу: светлая → тёмная → как в системе. */
  function nextMode(mode) {
    var index = MODES.indexOf(mode);
    return MODES[(index + 1) % MODES.length];
  }

  // Тема применяется сразу при загрузке файла, до отрисовки страницы
  apply(readMode());

  window.PVH_THEME = {
    STORAGE_KEY: STORAGE_KEY,
    MODES: MODES,
    LABELS: LABELS,
    ICONS: ICONS,
    readMode: readMode,
    saveMode: saveMode,
    systemTheme: systemTheme,
    resolve: resolve,
    apply: apply,
    nextMode: nextMode,
  };
}(window, document));
