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
  const mode = normalizeBackstoryModeLabel(modeLabel);
  if (mode === 'on') {
    return ['--merge-backstory'];
  }
  if (mode === 'off') {
    return ['--no-merge-backstory'];
  }
  return [];
}

function formatBackstoryLabel(modeLabel) {
  const mode = normalizeBackstoryModeLabel(modeLabel);
  if (mode === 'on') {
    return 'enabled (merged into hero docs)';
  }
  if (mode === 'off') {
    return 'disabled (backstory standalone)';
  }
  return 'disabled (default)';
}

export {
  resolveBackstoryModeFromEnv,
  normalizeBackstoryModeLabel,
  resolveStandardizeArgs,
  formatBackstoryLabel,
};
