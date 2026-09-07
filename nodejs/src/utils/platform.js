import { platform, homedir } from 'os';

export const Platform = {
  isLinux() {
    return platform() === 'linux';
  },

  isMac() {
    return platform() === 'darwin';
  },

  isWindows() {
    return platform() === 'win32';
  },

  isTermux() {
    return process.env.TERMUX_VERSION !== undefined || platform().includes('android');
  },

  getHomeDir() {
    return homedir();
  },

  getConfigDir() {
    const home = homedir();
    if (this.isTermux()) {
      return `${home}/.config/vierrataleai`;
    }
    const base = process.env.XDG_CONFIG_HOME || `${home}/.config`;
    return `${base}/vierrataleai`;
  },
};
