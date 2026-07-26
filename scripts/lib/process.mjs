import { spawn, spawnSync } from 'node:child_process';

async function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    stdio = ['ignore', 'pipe', 'pipe'],
  } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} interrupted by ${signal}`));
        return;
      }
      if (code !== 0) {
        const details = (stderr || stdout || 'no output').trim();
        reject(new Error(`${command} failed with exit code ${code}. ${details}`));
        return;
      }
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function runNodeScript(scriptPath, args = [], options = {}) {
  return runCommand(process.execPath, [scriptPath, ...args], options);
}

function commandExists(command) {
  const check = process.platform === 'win32'
    ? spawnSync('where', [command], { stdio: ['ignore', 'ignore', 'ignore'] })
    : spawnSync('which', [command], { stdio: ['ignore', 'ignore', 'ignore'] });

  return check.status === 0;
}

function openInBrowser(url) {
  if (process.platform === 'darwin' && commandExists('open')) {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  if (commandExists('xdg-open')) {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  return false;
}

export {
  runCommand,
  runNodeScript,
  openInBrowser,
  commandExists,
};
