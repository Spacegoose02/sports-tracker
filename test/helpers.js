const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// Point the SQLite file at a throwaway folder before anything requires db.js.
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-tracker-test-'));
}

// Loads public/js/shared.js (a browser script that defines a global CFB)
// into a sandbox and returns that CFB object.
function loadShared() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared.js'), 'utf8');
  const sandbox = {
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    location: { search: '', pathname: '/' },
    localStorage: { getItem: () => null, setItem() {} },
    URL,
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.CFB = CFB;`, sandbox);
  return sandbox.CFB;
}

// Starts the Express app on a random port and returns { url, close }.
async function startApp(env) {
  const { createApp } = require('../src/app');
  const app = createApp({ env, logger: { warn() {} } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { loadShared, startApp };
