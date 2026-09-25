// Existing clients retain their endpoint and payload contract.
export * from '../../engine/document-contract.mjs';
import { makeCapabilitiesPayload as capabilities } from '../../engine/document-contract.mjs';

export function makeCapabilitiesPayload(prefixes, backstoryMode, version = (typeof process === 'object' && process !== null && typeof process.version === 'string' ? process.version : 'node')) {
  return capabilities(prefixes, backstoryMode, version);
}
