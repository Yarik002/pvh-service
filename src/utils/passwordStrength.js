'use strict';

/**
 * Оценка надёжности пароля.
 *
 * Модуль решает две задачи:
 *   1) проверяет, что пароль не входит в словарь часто используемых
 *      и не содержит личных данных пользователя (имя, адрес электронной почты);
 *   2) вычисляет оценку стойкости от 0 до 100 и выдаёт рекомендации —
 *      это используется интерфейсом для подсказки пользователю при вводе пароля
 *      (индикатор надёжности появится на 10-м дне практики).
 *
 * Оценка складывается из штрафов за конкретные недостатки, поэтому пользователю
 * можно объяснить, что именно следует исправить, а не просто сообщить
 * «пароль слишком простой».
 */

const {
  COMMON_PASSWORDS_SET,
  COMMON_PASSWORDS,
  COMMON_WORDS,
  KEYBOARD_SEQUENCES,
} = require('../data/commonPasswords');

/** Уровни надёжности пароля. */
const STRENGTH_LEVELS = {
  veryWeak: { level: 'veryWeak', label: 'Очень низкая', color: '#d32f2f' },
  weak: { level: 'weak', label: 'Низкая', color: '#f57c00' },
  medium: { level: 'medium', label: 'Средняя', color: '#fbc02d' },
  strong: { level: 'strong', label: 'Высокая', color: '#388e3c' },
  veryStrong: { level: 'veryStrong', label: 'Очень высокая', color: '#1b5e20' },
};

/**
 * Приводит пароль к нормализованному виду: строчные буквы, только буквы и цифры.
 * Используется для сравнения со словарём и обнаружения «замаскированных» паролей
 * («Qwerty_123» → «qwerty123»).
 */
function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
}

/**
 * Заменяет символы, которыми обычно «маскируют» буквы в паролях,
 * на исходные буквы: «p@ssw0rd» → «password».
 */
function decodeLeet(value) {
  return String(value ?? '')
    .replace(/@/g, 'a')
    .replace(/4/g, 'a')
    .replace(/8/g, 'b')
    .replace(/3/g, 'e')
    .replace(/6/g, 'g')
    .replace(/1/g, 'i')
    .replace(/!/g, 'i')
    .replace(/0/g, 'o')
    .replace(/\$/g, 's')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/\+/g, 't');
}

/**
 * Формирует варианты написания пароля для поиска в словаре:
 * нормализованный вид, вид без цифр в конце и их «расшифровки».
 * @returns {string[]}
 */
function dictionaryCandidates(password) {
  const normalized = normalize(password);
  const candidates = new Set([normalized]);

  // Вариант с дописанными цифрами в конце: «qwerty2026», «password777»
  const withoutTrailingDigits = normalized.replace(/\d+$/, '');
  if (withoutTrailingDigits.length >= 4) candidates.add(withoutTrailingDigits);

  // Варианты с заменой символов на похожие буквы: «p@ssw0rd», «qwerty1»
  const decoded = normalize(decodeLeet(String(password ?? '').toLowerCase()));
  candidates.add(decoded);
  const decodedWithoutTrailingDigits = decoded.replace(/\d+$/, '');
  if (decodedWithoutTrailingDigits.length >= 4) candidates.add(decodedWithoutTrailingDigits);

  return [...candidates];
}

/** Проверяет, входит ли пароль в словарь часто используемых. */
function isCommonPassword(password) {
  return dictionaryCandidates(password).some((candidate) => COMMON_PASSWORDS_SET.has(candidate));
}

/** Проверяет, содержит ли пароль личные данные пользователя. */
function containsPersonalData(password, { name = '', email = '' } = {}) {
  const normalized = normalize(password);
  if (normalized.length === 0) return false;

  const candidates = [];

  // Фрагменты имени длиной от 3 символов (полное имя и отдельные слова)
  const nameParts = String(name).toLowerCase().split(/[\s.-]+/).filter((part) => part.length >= 3);
  candidates.push(...nameParts);

  // Локальная часть адреса электронной почты
  const localPart = String(email).toLowerCase().split('@')[0];
  if (localPart.length >= 3) candidates.push(normalize(localPart));

  return candidates.some((candidate) => {
    const normalizedCandidate = normalize(candidate);
    return normalizedCandidate.length >= 3 && normalized.includes(normalizedCandidate);
  });
}

/** Проверяет, содержит ли пароль длинную последовательность символов подряд. */
function hasKeyboardSequence(password) {
  const normalized = normalize(password);
  if (normalized.length < 4) return false;

  return KEYBOARD_SEQUENCES.some((sequence) => {
    for (let start = 0; start + 4 <= sequence.length; start += 1) {
      const fragment = sequence.slice(start, start + 4);
      if (normalized.includes(fragment)) return true;
      // Обратный порядок: «654321», «ytrewq»
      const reversed = [...fragment].reverse().join('');
      if (normalized.includes(reversed)) return true;
    }
    return false;
  });
}

/** Проверяет, что пароль состоит из одинаковых символов или простого повтора. */
function isRepeatedPattern(password) {
  const text = String(password ?? '');
  if (text.length < 4) return true;

  // Один и тот же символ: «аааааааа», «11111111»
  if (/^(.)\1+$/.test(text)) return true;

  // Длинная цепочка одинаковых символов внутри пароля: «aaaa», «1111»
  if (/(.)\1{3,}/.test(text)) return true;

  // Повтор короткого блока: «abcabcabc», «Abcabcabc1» (регистр не учитывается).
  // Проверяются два варианта: пароль целиком состоит из повторов блока
  // и пароль начинается с повторов блока (остаток может быть цифрами).
  const lowered = text.toLowerCase();
  for (let size = 1; size <= Math.floor(lowered.length / 2); size += 1) {
    const block = lowered.slice(0, size);
    if (block.repeat(Math.ceil(lowered.length / size)).slice(0, lowered.length) === lowered) {
      return true;
    }
    if (size <= 4 && block.repeat(3).length <= lowered.length
        && lowered.startsWith(block.repeat(3))) {
      return true;
    }
  }
  return false;
}

/**
 * Проверяет, содержит ли пароль распространённое словарное слово
 * (в том числе после «расшифровки» символов: «Str0ng!Passw0rd» → «strongpassword»).
 */
function containsCommonWord(password) {
  const decoded = normalize(decodeLeet(String(password ?? '').toLowerCase()));
  const plain = normalize(password);
  return COMMON_WORDS.some((word) => decoded.includes(word) || plain.includes(word));
}

/** Оценивает разнообразие использованных классов символов. */
function countCharacterClasses(password) {
  const text = String(password ?? '');
  let count = 0;
  if (/[a-zа-яё]/.test(text)) count += 1;          // строчные буквы
  if (/[A-ZА-ЯЁ]/.test(text)) count += 1;          // прописные буквы
  if (/\d/.test(text)) count += 1;                 // цифры
  if (/[^A-Za-zА-Яа-яЁё0-9]/.test(text)) count += 1; // специальные символы
  return count;
}

/**
 * Вычисляет оценку надёжности пароля.
 *
 * @param {string} password проверяемый пароль
 * @param {{name?: string, email?: string}} [user] данные пользователя
 * @returns {{
 *   score: number, level: string, label: string, color: string,
 *   checks: Array<{id: string, title: string, passed: boolean, advice: string}>,
 *   warnings: string[]
 * }}
 */
function analyzePassword(password, user = {}) {
  const text = String(password ?? '');
  const length = [...text].length;
  const classes = countCharacterClasses(text);
  const checks = [];

  let score = 0;

  // --- Длина -------------------------------------------------------------
  // Каждый символ длины даёт до 6 баллов, максимум 48 баллов за 8+ символов
  const lengthScore = Math.min(length, 8) * 6;
  score += lengthScore;
  checks.push({
    id: 'length',
    title: 'Длина не менее 8 символов',
    passed: length >= 8,
    advice: length >= 8 ? '' : 'Увеличьте пароль — чем он длиннее, тем сложнее его подобрать',
  });

  // --- Разнообразие символов --------------------------------------------
  // 4 класса символов дают 24 балла (по 6 за каждый)
  score += classes * 6;
  checks.push({
    id: 'classes',
    title: 'Разные типы символов (строчные, прописные, цифры, знаки)',
    passed: classes >= 3,
    advice: classes >= 3 ? '' : 'Добавьте прописные буквы, цифры или специальные знаки',
  });

  // --- Отсутствие в словаре часто используемых паролей -------------------
  const common = isCommonPassword(text);
  if (common) score -= 50;
  checks.push({
    id: 'notCommon',
    title: 'Пароль отсутствует в списке часто используемых',
    passed: !common,
    advice: common ? 'Такой пароль есть в словарях для подбора — выберите другой' : '',
  });

  // --- Отсутствие распространённых словарных слов ------------------------
  const commonWord = !common && containsCommonWord(text);
  if (commonWord) score -= 25;
  checks.push({
    id: 'noCommonWord',
    title: 'Пароль не содержит распространённых слов (password, qwerty и подобных)',
    passed: !commonWord,
    advice: commonWord
      ? 'Слова вроде «password» или «qwerty» проверяются в первую очередь, даже с заменами символов'
      : '',
  });

  // Пароль с распространённым словом не может считаться надёжным,
  // даже если он длинный и содержит разные типы символов
  if (commonWord) score = Math.min(score, 50);

  // --- Отсутствие личных данных ------------------------------------------
  const personal = containsPersonalData(text, user);
  if (personal) score -= 30;
  checks.push({
    id: 'noPersonalData',
    title: 'Пароль не содержит имя и адрес электронной почты',
    passed: !personal,
    advice: personal ? 'Не используйте в пароле своё имя, фамилию или адрес почты' : '',
  });

  // --- Отсутствие клавиатурных последовательностей -----------------------
  const sequence = hasKeyboardSequence(text);
  if (sequence) score -= 20;
  checks.push({
    id: 'noKeyboardSequence',
    title: 'Пароль не содержит последовательностей клавиш (qwerty, 1234)',
    passed: !sequence,
    advice: sequence ? 'Последовательности вида «qwerty» или «1234» подбираются мгновенно' : '',
  });

  // --- Отсутствие повторов -----------------------------------------------
  const repeated = isRepeatedPattern(text);
  if (repeated) score -= 20;
  checks.push({
    id: 'noRepeat',
    title: 'Пароль не состоит из повторяющихся символов',
    passed: !repeated,
    advice: repeated ? 'Избегайте повторов одного символа или блока («аааа», «abcabc»)' : '',
  });

  // --- Бонус за длину -----------------------------------------------------
  if (length >= 12) score += 10;
  if (length >= 16) score += 10;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let level;
  if (score < 20) level = STRENGTH_LEVELS.veryWeak;
  else if (score < 55) level = STRENGTH_LEVELS.weak;
  else if (score < 70) level = STRENGTH_LEVELS.medium;
  else if (score < 85) level = STRENGTH_LEVELS.strong;
  else level = STRENGTH_LEVELS.veryStrong;

  const warnings = checks.filter((check) => !check.passed).map((check) => check.advice);

  return {
    score,
    level: level.level,
    label: level.label,
    color: level.color,
    checks,
    warnings,
  };
}

/**
 * Проверяет, приемлем ли пароль для использования.
 * Возвращает описание первой причины отказа либо null.
 *
 * @param {string} password
 * @param {{name?: string, email?: string}} [user]
 * @returns {{code: string, message: string}|null}
 */
function findWeaknessReason(password, user = {}) {
  const text = String(password ?? '');

  // Более конкретная причина проверяется первой: если пароль содержит личные
  // данные пользователя, сообщение об этом полезнее, чем общее замечание
  // о словаре часто используемых паролей.
  if (containsPersonalData(text, user)) {
    return {
      code: 'CONTAINS_PERSONAL_DATA',
      message: 'Пароль не должен содержать ваше имя, фамилию или адрес электронной почты.',
    };
  }
  if (isCommonPassword(text)) {
    return {
      code: 'COMMON_PASSWORD',
      message: 'Этот пароль входит в список часто используемых и легко подбирается. '
        + 'Выберите другой пароль.',
    };
  }
  if (containsCommonWord(text)) {
    return {
      code: 'CONTAINS_COMMON_WORD',
      message: 'Пароль содержит распространённое слово (например «password» или «qwerty»), '
        + 'которое проверяется при подборе в первую очередь.',
    };
  }
  if (isRepeatedPattern(text)) {
    return {
      code: 'REPEATED_PATTERN',
      message: 'Пароль не должен состоять из повторяющихся символов или блоков.',
    };
  }

  return null;
}

module.exports = {
  analyzePassword,
  findWeaknessReason,
  isCommonPassword,
  containsPersonalData,
  containsCommonWord,
  hasKeyboardSequence,
  isRepeatedPattern,
  countCharacterClasses,
  normalize,
  decodeLeet,
  dictionaryCandidates,
  STRENGTH_LEVELS,
  COMMON_PASSWORDS_COUNT: COMMON_PASSWORDS.length,
  COMMON_WORDS_COUNT: COMMON_WORDS.length,
};
