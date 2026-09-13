import { spawn, spawnSync } from 'node:child_process';

const running = new Map();
let stopping = false;

// Desktop shutdown must wait for index workers as well as the HTTP process.
// Prevent the next build stage from starting while its owner is closing.
async function stopRunningCommands() {
  stopping = true;
  const children = [...running];
  for (const [child] of children) child.kill('SIGTERM');
  const force = setTimeout(() => {
    for (const [child] of children) if (running.has(child)) child.kill('SIGKILL');
  }, 1000);
  force.unref();
  try { await Promise.all(children.map(([, closed]) => closed)); }
  finally { clearTimeout(force); }
}

async function runCommand(command, args = [], options = {}) {
  if (stopping) throw new Error('处理服务正在关闭');
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
    let reaped;
    running.set(child, new Promise((resolve) => { reaped = resolve; }));

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
      running.delete(child);
      reaped();
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
  stopRunningCommands,
};
