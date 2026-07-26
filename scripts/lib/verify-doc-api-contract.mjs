import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT } from './paths.mjs';

const CONTRACT_PATH = path.join(PROJECT_ROOT, 'scripts/lib/doc-api-contract.mjs');
const ROUTES_PATH = path.join(PROJECT_ROOT, 'scripts/lib/doc-server-routes.mjs');
const APP_STATE_PATH = path.join(PROJECT_ROOT, 'web/modules/app-state.js');
const APP_RUNTIME_PATH = path.join(PROJECT_ROOT, 'web/modules/app-runtime.js');

function fail(message) {
  throw new Error(`[doc-api-contract-check] ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function assertString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} should be a non-empty string`);
}

function assertStringOrBoolean(value, label) {
  assert(typeof value === 'string' ? value.length > 0 : typeof value === 'boolean', `${label} should be a non-empty string or boolean`);
}

function assertBoolean(value, label) {
  assert(typeof value === 'boolean', `${label} should be boolean`);
}

async function loadContractModule() {
  return await import(pathToFileURL(CONTRACT_PATH).href);
}

async function loadTextFile(filePath) {
  return await fs.readFile(filePath, 'utf8');
}

function normalizeTextForMatch(content) {
  return content.replace(/\s+/g, ' ');
}

function ensureRequestContract(contract) {
  assert(contract.API_PATHS && typeof contract.API_PATHS === 'object', 'API_PATHS missing');
  assert(contract.API_METHODS && typeof contract.API_METHODS === 'object', 'API_METHODS missing');
  assert(contract.API_REQUEST_KEYS && typeof contract.API_REQUEST_KEYS === 'object', 'API_REQUEST_KEYS missing');

  assertString(contract.API_PATHS.CAPABILITIES, 'API_PATHS.CAPABILITIES');
  assertString(contract.API_PATHS.INDEX, 'API_PATHS.INDEX');
  assertString(contract.API_PATHS.DOC, 'API_PATHS.DOC');
  assertString(contract.API_PATHS.REBUILD, 'API_PATHS.REBUILD');

  assert(contract.API_PATHS.CAPABILITIES === '/api/capabilities', 'CAPABILITIES path expected /api/capabilities');
  assert(contract.API_PATHS.INDEX === '/api/index', 'INDEX path expected /api/index');
  assert(contract.API_PATHS.DOC === '/api/doc', 'DOC path expected /api/doc');
  assert(contract.API_PATHS.REBUILD === '/api/rebuild', 'REBUILD path expected /api/rebuild');

  assertString(contract.API_METHODS.GET, 'API_METHODS.GET');
  assertString(contract.API_METHODS.POST, 'API_METHODS.POST');
  assertString(contract.API_METHODS.PUT, 'API_METHODS.PUT');

  const requiredKeys = ['path', 'content', 'expectedVersion', 'expectedLockVersion', 'force', 'create', 'source', 'runStandardize', 'runBuild'];
  for (const key of requiredKeys) {
    assertString(contract.API_REQUEST_KEYS[key], `API_REQUEST_KEYS.${key}`);
  }

  assertStringOrBoolean(contract.DOC_CAPABILITIES_FIELDS.edit, 'DOC_CAPABILITIES_FIELDS.edit');
  assertStringOrBoolean(contract.DOC_CAPABILITIES_FIELDS.create, 'DOC_CAPABILITIES_FIELDS.create');
  assertStringOrBoolean(contract.DOC_CAPABILITIES_FIELDS.rebuild, 'DOC_CAPABILITIES_FIELDS.rebuild');
  assertBoolean(contract.DOC_CAPABILITIES_FIELDS.okValue, 'DOC_CAPABILITIES_FIELDS.okValue');
  assertString(contract.API_RESPONSE.error, 'API_RESPONSE.error');
  assertString(contract.API_RESPONSE.ok, 'API_RESPONSE.ok');
}

async function ensureRouteContract() {
  const routeModule = await import(pathToFileURL(ROUTES_PATH).href);
  assert(typeof routeModule.handleApiRequest === 'function', 'doc-server-routes should export handleApiRequest');
  assert(typeof routeModule.methodNotAllowed === 'function', 'doc-server-routes should export methodNotAllowed');
}

async function ensureWebFrontendReferencesContract() {
  const [appState, appRuntime] = await Promise.all([
    loadTextFile(APP_STATE_PATH),
    loadTextFile(APP_RUNTIME_PATH),
  ]);

  const normalizedState = normalizeTextForMatch(appState);
  const normalizedRuntime = normalizeTextForMatch(appRuntime);

  const requiredStateMarkers = [
    "from '../../scripts/lib/doc-api-contract.mjs'",
    'API_PATHS.CAPABILITIES',
    'DOC_CAPABILITIES_URL',
    'DOC_API_URL',
    'DOC_REBUILD_URL',
  ];

  for (const marker of requiredStateMarkers) {
    assert(normalizedState.includes(marker), `app-state.js missing marker: ${marker}`);
  }

  const requiredRuntimeMarkers = [
    'API_REQUEST_KEYS',
    'DOC_API_URL',
    '[API_REQUEST_KEYS.path]',
    '[API_REQUEST_KEYS.content]',
    '[API_REQUEST_KEYS.expectedVersion]',
    '[API_REQUEST_KEYS.force]',
    '[API_REQUEST_KEYS.create]',
    '[API_REQUEST_KEYS.source]',
  ];

  for (const marker of requiredRuntimeMarkers) {
    assert(normalizedRuntime.includes(marker), `app-runtime.js missing marker: ${marker}`);
  }
}

async function runDocApiContractPreflight() {
  const [contract, routeText] = await Promise.all([
    loadContractModule(),
    loadTextFile(ROUTES_PATH),
  ]);
  ensureRequestContract(contract);

  const normalizedRouteText = normalizeTextForMatch(routeText);
  const routeMarkers = [
    'API_PATHS.INDEX',
    'API_PATHS.CAPABILITIES',
    'API_PATHS.DOC',
    'API_PATHS.REBUILD',
    'API_METHODS.GET',
    'API_METHODS.POST',
    'API_METHODS.PUT',
    'makeCapabilitiesPayload',
    'makeRebuildResponse',
  ];

  for (const marker of routeMarkers) {
    assert(normalizedRouteText.includes(marker), `doc-server-routes.js missing marker: ${marker}`);
  }

  ensureRouteContract();
  await ensureWebFrontendReferencesContract();
}

export {
  runDocApiContractPreflight,
};
