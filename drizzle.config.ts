import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/database/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // drizzle-kit only needs a path for generation; runtime path comes from .env
    url: './data/whatsapp.db',
  },
});
