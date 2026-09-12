function resolveBackstoryModeFromEnv(env = process.env) {
  const mode = env.DOCS_BACKSTORY_MODE;
  if (mode === 'on') {
    return 'enabled';
  }
  if (mode === 'off') {
    return 'disabled';
  }
  return 'disabled (default)';
}

function normalizeBackstoryModeLabel(rawMode) {
  if (rawMode === 'on' || rawMode === 'enabled') {
    return 'on';
  }
  if (rawMode === 'off' || rawMode === 'disabled') {
    return 'off';
  }
  return 'default';
}

function resolveStandardizeArgs(modeLabel) {
  // Old launch flags remain accepted. Ownership is now portable metadata and
  // must not change when a rebuild happens to select a different CLI mode.
  return [];
}

function formatBackstoryLabel(modeLabel) {
  return 'document ownership metadata';
}

export {
  resolveBackstoryModeFromEnv,
  normalizeBackstoryModeLabel,
  resolveStandardizeArgs,
  formatBackstoryLabel,
};
