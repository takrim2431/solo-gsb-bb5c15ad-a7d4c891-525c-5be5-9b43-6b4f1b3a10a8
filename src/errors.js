/** 统一的业务错误：HTTP 状态码 + 机器可读错误码 */
class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
    this.details = details;
  }
}

const badRequest = (msg, details) => new ApiError(400, 'BAD_REQUEST', msg, details);
const unauthorized = (msg = '未登录或会话已失效') => new ApiError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = '无权访问该资源') => new ApiError(403, 'FORBIDDEN', msg);
const notFound = (msg = '资源不存在') => new ApiError(404, 'NOT_FOUND', msg);
const conflict = (code, msg, details) => new ApiError(409, code, msg, details);

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, wrap };
