import { DbService } from '../db/db.service.js';
import { ChatImagesService } from './chat-images.service.js';
import { ChatCleanupService } from './chat-cleanup.service.js';

const db = new DbService();
try {
  const result = await new ChatCleanupService(db, new ChatImagesService()).run();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write('Chat image cleanup failed: ' + String(error) + '\n');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
