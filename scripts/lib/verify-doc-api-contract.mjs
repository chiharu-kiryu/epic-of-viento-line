import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { APPLICATION_ROOT } from './paths.mjs';

const CONTRACT_PATH = path.join(APPLICATION_ROOT, 'scripts/lib/doc-api-contract.mjs');
const ROUTES_PATH = path.join(APPLICATION_ROOT, 'scripts/lib/doc-server-routes.mjs');
const APP_STATE_PATH = path.join(APPLICATION_ROOT, 'web/modules/app-state.js');
const APP_RUNTIME_PATH = path.join(APPLICATION_ROOT, 'web/modules/app-runtime.js');
const APP_DOC_SERVICE_PATH = path.join(APPLICATION_ROOT, 'web/modules/app-doc-service.js');
const CHECK_PREFIX = '[doc-api-contract-check]';
const PRECHECK_MAX_HINTS = 8;

function createContractPrecheckError({ issues, failedModules }) {
  const error = new Error(formatPreflightReport(issues));
  error.code = 'DOCAPI_PRECHECK_FAILED';
  error.name = 'DocApiContractPrecheckError';
  error.details = issues;
  error.failedModules = failedModules;
  error.summary = {
    totalIssues: issues.length,
    modules: summarizeIssuesByArea(issues),
  };
  return error;
}

function normalizeTextForMatch(content) {
  return typeof content === 'string' ? content.replace(/\s+/g, ' ') : '';
}

function createIssue(code, area, message, hint = '') {
  return { code, area, message, hint };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isBool(value) {
  return typeof value === 'boolean';
}

function isStringOrBool(value) {
  return isNonEmptyString(value) || isBool(value);
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function readContract() {
  return import(pathToFileURL(CONTRACT_PATH).href);
}

function check(condition, code, area, message, hint, issues) {
  if (!condition) {
    issues.push(createIssue(code, area, message, hint));
  }
}

function validateContract(contract, issues) {
  check(contract && typeof contract === 'object', 'DOCAPI-CONTRACT-001', 'contract', 'doc-api-contract.mjs 无法解析为对象', '确认文件语法正确且导出有效对象', issues);
  if (!contract || typeof contract !== 'object') {
    return;
  }

  check(contract.API_PATHS && typeof contract.API_PATHS === 'object', 'DOCAPI-CONTRACT-002', 'contract/API_PATHS', '缺少 API_PATHS', '确保在 doc-api-contract.mjs 中导出 API_PATHS', issues);
  check(contract.API_METHODS && typeof contract.API_METHODS === 'object', 'DOCAPI-CONTRACT-003', 'contract/API_METHODS', '缺少 API_METHODS', '确保在 doc-api-contract.mjs 中导出 API_METHODS', issues);
  check(contract.API_REQUEST_KEYS && typeof contract.API_REQUEST_KEYS === 'object', 'DOCAPI-CONTRACT-004', 'contract/API_REQUEST_KEYS', '缺少 API_REQUEST_KEYS', '确保在 doc-api-contract.mjs 中导出 API_REQUEST_KEYS', issues);

  if (!isNonEmptyString(contract.API_PATHS?.CAPABILITIES)) {
    issues.push(createIssue('DOCAPI-CONTRACT-011', 'contract/API_PATHS/CAPABILITIES', 'CAPABILITIES 为空或类型错误', '应为 "/api/capabilities" 字符串'));
  }
  if (!isNonEmptyString(contract.API_PATHS?.INDEX)) {
    issues.push(createIssue('DOCAPI-CONTRACT-012', 'contract/API_PATHS/INDEX', 'INDEX 为空或类型错误', '应为 "/api/index" 字符串'));
  }
  if (!isNonEmptyString(contract.API_PATHS?.DOC)) {
    issues.push(createIssue('DOCAPI-CONTRACT-013', 'contract/API_PATHS/DOC', 'DOC 为空或类型错误', '应为 "/api/doc" 字符串'));
  }
  if (!isNonEmptyString(contract.API_PATHS?.REBUILD)) {
    issues.push(createIssue('DOCAPI-CONTRACT-014', 'contract/API_PATHS/REBUILD', 'REBUILD 为空或类型错误', '应为 "/api/rebuild" 字符串'));
  }
  if (!isNonEmptyString(contract.API_PATHS?.HEALTH)) {
    issues.push(createIssue('DOCAPI-CONTRACT-015', 'contract/API_PATHS/HEALTH', 'HEALTH 为空或类型错误', '应为 "/api/health" 字符串'));
  }
  if (!isNonEmptyString(contract.API_PATHS?.METRICS)) {
    issues.push(createIssue('DOCAPI-CONTRACT-016', 'contract/API_PATHS/METRICS', 'METRICS 为空或类型错误', '应为 "/api/metrics" 字符串'));
  }

  check(contract.API_PATHS?.CAPABILITIES === '/api/capabilities', 'DOCAPI-CONTRACT-021', 'contract/API_PATHS/CAPABILITIES', '路径值不匹配', '应为 "/api/capabilities"', issues);
  check(contract.API_PATHS?.INDEX === '/api/index', 'DOCAPI-CONTRACT-022', 'contract/API_PATHS/INDEX', '路径值不匹配', '应为 "/api/index"', issues);
  check(contract.API_PATHS?.DOC === '/api/doc', 'DOCAPI-CONTRACT-023', 'contract/API_PATHS/DOC', '路径值不匹配', '应为 "/api/doc"', issues);
  check(contract.API_PATHS?.REBUILD === '/api/rebuild', 'DOCAPI-CONTRACT-024', 'contract/API_PATHS/REBUILD', '路径值不匹配', '应为 "/api/rebuild"', issues);
  check(contract.API_PATHS?.HEALTH === '/api/health', 'DOCAPI-CONTRACT-025', 'contract/API_PATHS/HEALTH', '路径值不匹配', '应为 "/api/health"', issues);
  check(contract.API_PATHS?.METRICS === '/api/metrics', 'DOCAPI-CONTRACT-026', 'contract/API_PATHS/METRICS', '路径值不匹配', '应为 "/api/metrics"', issues);

  check(isNonEmptyString(contract.API_METHODS?.GET), 'DOCAPI-CONTRACT-031', 'contract/API_METHODS/GET', '缺少 GET', '确保包含 GET 方法字符串', issues);
  check(isNonEmptyString(contract.API_METHODS?.POST), 'DOCAPI-CONTRACT-032', 'contract/API_METHODS/POST', '缺少 POST', '确保包含 POST 方法字符串', issues);
  check(isNonEmptyString(contract.API_METHODS?.PUT), 'DOCAPI-CONTRACT-033', 'contract/API_METHODS/PUT', '缺少 PUT', '确保包含 PUT 方法字符串', issues);

  const requiredKeys = ['path', 'content', 'expectedVersion', 'expectedLockVersion', 'force', 'create', 'source', 'runStandardize', 'runBuild'];
  for (const key of requiredKeys) {
    check(isNonEmptyString(contract.API_REQUEST_KEYS?.[key]), `DOCAPI-CONTRACT-04${requiredKeys.indexOf(key) + 1}`, `contract/API_REQUEST_KEYS/${key}`, `缺少请求字段 ${key}`, `在 API_REQUEST_KEYS 中补齐 ${key}`, issues);
  }

  check(isStringOrBool(contract.DOC_CAPABILITIES_FIELDS?.edit), 'DOCAPI-CONTRACT-051', 'contract/DOC_CAPABILITIES_FIELDS/edit', 'edit 字段类型异常', '应为布尔或非空字符串', issues);
  check(isStringOrBool(contract.DOC_CAPABILITIES_FIELDS?.create), 'DOCAPI-CONTRACT-052', 'contract/DOC_CAPABILITIES_FIELDS/create', 'create 字段类型异常', '应为布尔或非空字符串', issues);
  check(isStringOrBool(contract.DOC_CAPABILITIES_FIELDS?.rebuild), 'DOCAPI-CONTRACT-053', 'contract/DOC_CAPABILITIES_FIELDS/rebuild', 'rebuild 字段类型异常', '应为布尔或非空字符串', issues);
  check(isBool(contract.DOC_CAPABILITIES_FIELDS?.okValue), 'DOCAPI-CONTRACT-054', 'contract/DOC_CAPABILITIES_FIELDS/okValue', 'okValue 应为布尔值', '请确认是否为 boolean', issues);
  check(isNonEmptyString(contract.API_RESPONSE?.error), 'DOCAPI-CONTRACT-061', 'contract/API_RESPONSE/error', '缺少 API_RESPONSE.error', '请补充错误字段名', issues);
  check(isNonEmptyString(contract.API_RESPONSE?.ok), 'DOCAPI-CONTRACT-062', 'contract/API_RESPONSE/ok', '缺少 API_RESPONSE.ok', '请补充成功字段名', issues);
}

function checkTextMarkers(fileText, markers, prefix, issues) {
  const normalized = normalizeTextForMatch(fileText);
  for (const marker of markers) {
    check(normalized.includes(marker), `${prefix}-${String(markers.indexOf(marker) + 1).padStart(3, '0')}`, 'frontend marker', `缺少关键引用 ${marker}`, `请确认引用未被重构为更高层姓名或替代路径`, issues);
  }
}

function validateRoute(contract, routeText, issues) {
  const normalizedRouteText = normalizeTextForMatch(routeText);
  const markers = [
    'API_PATHS.INDEX',
    'API_PATHS.CAPABILITIES',
    'API_PATHS.HEALTH',
    'API_PATHS.METRICS',
    'API_PATHS.DOC',
    'API_PATHS.REBUILD',
    'API_METHODS.GET',
    'API_METHODS.POST',
    'API_METHODS.PUT',
    'makeCapabilitiesPayload',
    'makeRebuildResponse',
  ];

  for (const marker of markers) {
    check(normalizedRouteText.includes(marker), `DOCAPI-ROUTE-${String(markers.indexOf(marker) + 1).padStart(3, '0')}`, 'doc-server-routes/实现', `缺少关键引用 ${marker}`, '请确认路由层仍基于 doc-api-contract.mjs 中定义进行路由/方法分派', issues);
  }

  check(contract.API_PATHS?.INDEX && contract.API_METHODS?.GET, 'DOCAPI-ROUTE-010', 'doc-server-routes/export', 'handleApiRequest 未检测到标准索引/方法约束', '确认路由层已从 contract 读取常量', issues);
}

async function validateRouteExport(issues) {
  try {
    const routeModule = await import(pathToFileURL(ROUTES_PATH).href);
    check(typeof routeModule.handleApiRequest === 'function', 'DOCAPI-ROUTE-011', 'doc-server-routes/export', '缺少 handleApiRequest 导出', '请确认 export handleApiRequest', issues);
    check(typeof routeModule.methodNotAllowed === 'function', 'DOCAPI-ROUTE-012', 'doc-server-routes/export', '缺少 methodNotAllowed 导出', '请确认 export methodNotAllowed', issues);
  } catch (error) {
    issues.push(createIssue('DOCAPI-ROUTE-013', 'doc-server-routes/import', `路由模块导入失败: ${error?.message || error}`, '检查脚本语法与依赖路径是否正确'));
  }
}

function validateFrontendText(issues, appStateText, appRuntimeText, appDocServiceText) {
  const stateMarkers = [
    "from '../../scripts/lib/doc-api-contract.mjs'",
    'API_PATHS.CAPABILITIES',
    'DOC_CAPABILITIES_URL',
    'DOC_API_URL',
    'DOC_REBUILD_URL',
  ];
  checkTextMarkers(appStateText, stateMarkers, 'DOCAPI-FRONTEND-STATE', issues);

  const runtimeMarkers = [
    'DOC_API_URL',
    'readDocSource',
    'writeDoc',
    'rebuildDocIndex',
  ];
  checkTextMarkers(appRuntimeText, runtimeMarkers, 'DOCAPI-FRONTEND-RUNTIME', issues);

  const serviceMarkers = [
    'API_REQUEST_KEYS',
    '[API_REQUEST_KEYS.path]',
    '[API_REQUEST_KEYS.content]',
    '[API_REQUEST_KEYS.expectedVersion]',
    '[API_REQUEST_KEYS.force]',
    '[API_REQUEST_KEYS.create]',
    '[API_REQUEST_KEYS.source]',
  ];
  checkTextMarkers(appDocServiceText, serviceMarkers, 'DOCAPI-FRONTEND-SERVICE', issues);
}

function summarizeIssuesByArea(issues) {
  const map = {};
  for (const issue of issues) {
    map[issue.area] = (map[issue.area] || 0) + 1;
  }
  return map;
}

function getTopHints(issues) {
  const hints = [];
  for (const issue of issues) {
    if (issue.hint && issue.hint.trim()) {
      hints.push(issue.hint);
    }
  }
  const uniq = [...new Set(hints)];
  return uniq.slice(0, PRECHECK_MAX_HINTS);
}

function formatPreflightReport(issues) {
  const lines = [];
  lines.push(`${CHECK_PREFIX} API 契约预检失败：共 ${issues.length} 项问题`);
  for (const issue of issues) {
    lines.push(`- ${issue.code} | ${issue.area}\n  问题: ${issue.message}`);
    if (issue.hint) {
      lines.push(`  建议: ${issue.hint}`);
    }
  }

  const summary = summarizeIssuesByArea(issues);
  if (Object.keys(summary).length > 1) {
    lines.push('');
    lines.push('问题分布：');
    for (const [area, count] of Object.entries(summary)) {
      lines.push(`- ${area}: ${count} 条`);
    }
  }

  const hints = getTopHints(issues);
  if (hints.length > 0) {
    lines.push('');
    lines.push('优先处理建议：');
    for (const [index, hint] of hints.entries()) {
      lines.push(`${index + 1}. ${hint}`);
    }
  }

  lines.push('');
  lines.push('修复后可重试：node scripts/ops/site.mjs');
  return lines.join('\n');
}

async function runDocApiContractPreflight() {
  const issues = [];
  const fileReads = await Promise.allSettled([
    readText(ROUTES_PATH),
    readText(APP_STATE_PATH),
    readText(APP_RUNTIME_PATH),
    readText(APP_DOC_SERVICE_PATH),
  ]);

  const routeText = fileReads[0].status === 'fulfilled' ? fileReads[0].value : '';
  const appStateText = fileReads[1].status === 'fulfilled' ? fileReads[1].value : '';
  const appRuntimeText = fileReads[2].status === 'fulfilled' ? fileReads[2].value : '';
  const appDocServiceText = fileReads[3].status === 'fulfilled' ? fileReads[3].value : '';

  if (fileReads[0].status === 'rejected') {
    issues.push(createIssue('DOCAPI-ROUTE-000', 'doc-server-routes', `doc-server-routes.mjs 读取失败: ${fileReads[0].reason?.message || fileReads[0].reason}`, '确认文件路径与内容可读'));
  }
  if (fileReads[1].status === 'rejected') {
    issues.push(createIssue('DOCAPI-FRONTEND-STATE-000', 'app-state.js', `app-state.js 读取失败: ${fileReads[1].reason?.message || fileReads[1].reason}`, '确认文件存在且可读'));
  }
  if (fileReads[2].status === 'rejected') {
    issues.push(createIssue('DOCAPI-FRONTEND-RUNTIME-000', 'app-runtime.js', `app-runtime.js 读取失败: ${fileReads[2].reason?.message || fileReads[2].reason}`, '确认文件存在且可读'));
  }
  if (fileReads[3].status === 'rejected') {
    issues.push(createIssue('DOCAPI-FRONTEND-SERVICE-000', 'app-doc-service.js', `app-doc-service.js 读取失败: ${fileReads[3].reason?.message || fileReads[3].reason}`, '确认文件存在且可读'));
  }

  let contract = null;
  try {
    contract = await readContract();
  } catch (error) {
    issues.push(createIssue('DOCAPI-CONTRACT-000', 'contract/import', `无法导入 doc-api-contract.mjs: ${error?.message || error}`, '检查文件是否存在且可解析'));
  }

  validateContract(contract, issues);

  if (contract) {
    validateRoute(contract, routeText, issues);
  }

  await validateRouteExport(issues);
  if (appStateText || appRuntimeText) {
    validateFrontendText(issues, appStateText, appRuntimeText, appDocServiceText);
  }

  if (issues.length > 0) {
    const failedModules = Object.keys(summarizeIssuesByArea(issues)).filter((area) => area.includes('/') || area.includes('app-') || area.includes('contract') || area.includes('doc-'));
    throw createContractPrecheckError({ issues, failedModules });
  }

  return {
    ok: true,
    checksPassed: true,
    issues,
  };
}

export {
  runDocApiContractPreflight,
  createContractPrecheckError,
};
