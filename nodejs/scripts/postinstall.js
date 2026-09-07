#!/usr/bin/env node
// Optional engine setup after install. Never fails the package install.
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const isInstalled = () => {
  try {
    execSync('which ollama 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {}
  return existsSync('/usr/local/bin/ollama') || existsSync('/usr/bin/ollama');
};

try {
  if (isInstalled()) {
    process.exit(0);
  }

  const nonInteractive =
    !process.stdout.isTTY || process.env.CI || process.env.NODE_ENV === 'test';

  // Only auto-install when explicitly requested. Otherwise just inform the user
  // that the engine will be installed on first launch.
  if (process.env.VIERRATALE_INSTALL_ENGINE === '1' && !nonInteractive) {
    execSync('curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'inherit' });
  } else {
    console.log(
      '\n[vierrataleai] The local engine (ollama) was not detected.\n' +
        '  - Run the CLI: it will attempt to install and start the engine automatically.\n' +
        '  - Or install it yourself: curl -fsSL https://ollama.com/install.sh | sh\n'
    );
  }
} catch {
  // Never fail the install because of engine setup.
}
