// Load backend/.env if present (Node >= 20.12). Imported first by server.js.
try {
  process.loadEnvFile?.();
} catch {
  // no .env file, rely on the real environment
}
