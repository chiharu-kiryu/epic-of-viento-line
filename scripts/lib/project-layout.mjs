import fs from 'node:fs';
import { createProjectModel } from '../../engine/project.mjs';
export { LEGACY_PATHS, validateParserDefinition, validateProjectTypes } from '../../engine/project.mjs';

// Only the Node adapter loads the application defaults from disk.
export const PROJECT_DEFAULTS = JSON.parse(fs.readFileSync(new URL('./project-defaults.json', import.meta.url), 'utf8'));
export const { workspacePaths, projectDefinition, resolveDocumentDefinition, projectDocumentDefaults } = createProjectModel(PROJECT_DEFAULTS);
