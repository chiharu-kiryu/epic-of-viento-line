// Shared by the editor, library and local preference API. IDs are persisted;
// native names stay readable even before the interface language is selected.
export const supportedLanguages = Object.freeze([
  Object.freeze({ id: 'zh-CN', name: '简体中文' }),
  Object.freeze({ id: 'en', name: 'English' }),
  Object.freeze({ id: 'ja', name: '日本語' }),
]);
export const isSupportedLanguage = (value) => supportedLanguages.some((item) => item.id === value);
