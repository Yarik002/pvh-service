'use strict';

/**
 * Словарь часто используемых (ненадёжных) паролей.
 *
 * Пароли из этого списка первыми проверяют злоумышленники при подборе, поэтому
 * они не должны приниматься системой, даже если формально удовлетворяют
 * требованию к длине (например «qwerty123» — 9 символов, но крайне ненадёжен).
 *
 * Словарь хранится в нормализованном виде: строчные буквы, только буквы и цифры.
 * Нормализация (см. функции в модуле passwordStrength.js) позволяет распознавать
 * варианты написания: «Qwerty123», «qwerty_123», «QWERTY-123».
 *
 * Список составлен по данным ежегодных отчётов о самых распространённых паролях;
 * он намеренно ограничен наиболее частыми вариантами, чтобы не увеличивать
 * размер проекта.
 */

/** Наиболее распространённые пароли (нормализованные). */
const COMMON_PASSWORDS = [
  // цифровые последовательности
  '123456', '12345678', '123456789', '1234567890', '12345', '1234567',
  '111111', '000000', '121212', '123123', '654321', '987654321',
  // латинская раскладка клавиатуры
  'qwerty', 'qwerty123', 'qwertyuiop', 'qwerty1', 'qwerty12',
  'qwerty12345', 'qwertyqwerty', 'qazwsx', 'qazwsxedc', 'zaq12wsx',
  'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', '1qaz2wsx', '1q2w3e4r',
  // русская раскладка клавиатуры
  'йцукен', 'йцукенг', 'йцукенгшщз', 'фывапрол', 'ячсмить',
  'йцукен123', 'йцукенгш', 'пароль', 'пароль123', 'пароль1',
  // словарные слова
  'password', 'password1', 'password123', 'passw0rd', 'pass',
  'admin', 'admin123', 'administrator', 'root', 'root123', 'toor',
  'user', 'user123', 'guest', 'guest123', 'test', 'test123', 'tester',
  'welcome', 'welcome1', 'welcome123', 'letmein', 'monkey', 'dragon',
  'master', 'shadow', 'sunshine', 'princess', 'football', 'baseball',
  'iloveyou', 'trustno1', 'abc123', 'abcd1234', 'a1b2c3', 'a1b2c3d4',
  // слова, связанные с предметной областью проекта
  'pvh12345', 'pvz12345', 'sklad123', 'post1234', 'posylka1',
  'zakaz123', 'zakaz12345', 'order123', 'delivery1', 'courier1',
  // имена и фамилии
  'ivanov', 'ivanov123', 'petrov', 'petrov123', 'sergey', 'sergey123',
  'andrej', 'andrey123', 'alexey', 'aleksey1', 'dmitrij1', 'maksim123',
];

/** Множество для быстрой проверки вхождения. */
const COMMON_PASSWORDS_SET = new Set(COMMON_PASSWORDS);

/**
 * Последовательности символов на клавиатуре (для обнаружения «клавиатурных»
 * паролей, которых может не быть в словаре).
 */
const KEYBOARD_SEQUENCES = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm',
  'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю',
  '1234567890', 'abcdefghijklmnopqrstuvwxyz',
];

/**
 * Распространённые слова, которые часто составляют основу пароля.
 *
 * В отличие от COMMON_PASSWORDS (проверяется полное совпадение), этот список
 * применяется для поиска слова внутри пароля: «Passw0rd2026!», «MyQwerty!1».
 * Все слова приведены к нижнему регистру, длина — от 5 символов,
 * чтобы не отклонять добросовестные пароли из-за коротких сочетаний.
 */
const COMMON_WORDS = [
  'password', 'passwd', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn',
  'letmein', 'welcome', 'monkey', 'dragon', 'master', 'shadow',
  'sunshine', 'princess', 'football', 'baseball', 'iloveyou',
  'superman', 'batman', 'trustno', 'admin', 'administrator',
  'пароль', 'йцукен', 'фывапр', 'привет', 'любовь', 'россия',
  'pvhservice', 'posylka', 'zakaz', 'sklad', 'courier', 'delivery',
];

module.exports = {
  COMMON_PASSWORDS,
  COMMON_PASSWORDS_SET,
  COMMON_WORDS,
  KEYBOARD_SEQUENCES,
};
