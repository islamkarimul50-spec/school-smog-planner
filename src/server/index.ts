import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';

function loadLocalEnvIfPresent(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvIfPresent();

const defaultPort = process.env.NODE_ENV === 'production' ? 3000 : 3001;
const port = Number(process.env.PORT) || defaultPort;

const { app, geminiService } = createApp();

app.listen(port, () => {
  console.log(
    `School Smog Planner server listening on http://localhost:${port} (Gemini configured: ${geminiService.isConfigured() ? 'yes' : 'no — using labeled fallback'})`
  );
});
