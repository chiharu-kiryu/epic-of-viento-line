export function createError(statusCode, message, extra = {}, errorCode = '') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = extra;
  error.errorCode = typeof errorCode === 'string' && errorCode ? errorCode : '';
  return error;
}
