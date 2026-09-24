// Interface messages carry their arguments separately. Paths, names and parser
// diagnostics stay literal; clients never have to guess where a sentence ends.
export function userMessage(key, ...values) {
  if (Array.isArray(key)) key = key.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '');
  return { key, values };
}

export function userMessageText(message) {
  return message.key.replace(/\{(\d+)\}/g, (match, index) => {
    if (index >= message.values.length) return match;
    const value = message.values[index];
    return value && typeof value === 'object' && typeof value.key === 'string' && Array.isArray(value.values)
      ? userMessageText(value) : String(value);
  });
}

export function userError(message, statusCode = 400, errorCode = '') {
  const descriptor = typeof message === 'string' ? userMessage(message) : message;
  return Object.assign(new Error(userMessageText(descriptor)), {
    statusCode, errorCode, payload: { userMessage: descriptor },
  });
}
