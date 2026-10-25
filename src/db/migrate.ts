import { connect, migrate } from './postgres.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL first.');
  process.exit(1);
}
const db = await connect(url);
try {
  await migrate(db);
  console.log('Schema is up to date.');
} finally {
  await db.end();
}
