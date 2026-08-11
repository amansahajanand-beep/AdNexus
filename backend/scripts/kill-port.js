/**
 * Stop whichever process is listening on port 3099 (Windows).
 * Usage: node scripts/kill-port.js
 */
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3099;

try {
  const out = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: 'utf8' });
  const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const pids = new Set();
  lines.forEach((line) => {
    const pid = line.split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  });
  if (!pids.size) {
    console.log(`No server listening on port ${PORT}.`);
    process.exit(0);
  }
  pids.forEach((pid) => {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'inherit' });
    console.log(`Stopped PID ${pid} (port ${PORT}).`);
  });
} catch {
  console.log(`No server listening on port ${PORT}.`);
}
