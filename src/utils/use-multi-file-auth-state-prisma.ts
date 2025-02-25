import { prismaRepository } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { INSTANCE_DIR } from '@config/path.config';
import { AuthenticationState, BufferJSON, initAuthCreds, WAProto as proto } from 'baileys';
import fs from 'fs/promises';
import path from 'path';

// Interfaces
interface SessionData {
  sessionId: string;
  creds: string;
}

// Funções utilitárias
const fixFileName = (file: string): string | undefined => {
  if (!file) return undefined;
  return file.replace(/\//g, '__').replace(/:/g, '-');
};

const isRedisEnabled = (): boolean => process.env.CACHE_REDIS_ENABLED === 'true';

async function fileExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function keyExists(sessionId: string): Promise<boolean> {
  try {
    const key = await prismaRepository.session.findUnique({ 
      where: { sessionId } 
    });
    return !!key;
  } catch (error) {
    console.error(`Error checking key existence for session ${sessionId}:`, error);
    return false;
  }
}

export async function saveKey(sessionId: string, keyJson: any): Promise<any> {
  try {
    const exists = await keyExists(sessionId);
    const data = {
      sessionId,
      creds: JSON.stringify(keyJson),
    };

    if (!exists) {
      return await prismaRepository.session.create({ data });
    }

    return await prismaRepository.session.update({
      where: { sessionId },
      data: { creds: data.creds },
    });
  } catch (error) {
    console.error(`Error saving key for session ${sessionId}:`, error);
    return null;
  }
}

export async function getAuthKey(sessionId: string): Promise<any> {
  try {
    const auth = await prismaRepository.session.findUnique({ 
      where: { sessionId } 
    });
    return auth ? JSON.parse(auth.creds) : null;
  } catch (error) {
    console.error(`Error getting auth key for session ${sessionId}:`, error);
    return null;
  }
}

async function deleteAuthKey(sessionId: string): Promise<void> {
  try {
    await prismaRepository.session.delete({ 
      where: { sessionId } 
    });
  } catch (error) {
    console.error(`Error deleting auth key for session ${sessionId}:`, error);
  }
}

export default async function useMultiFileAuthStatePrisma(
  sessionId: string,
  cache: CacheService,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const localFolder = path.join(INSTANCE_DIR, sessionId);
  const localFile = (key: string) => path.join(localFolder, `${fixFileName(key)}.json`);
  
  await fs.mkdir(localFolder, { recursive: true });

  async function writeData(data: any, key: string): Promise<any> {
    try {
      const dataString = JSON.stringify(data, BufferJSON.replacer);

      if (key === 'creds') {
        return await saveKey(sessionId, dataString);
      }

      if (isRedisEnabled()) {
        return await cache.hSet(sessionId, key, data);
      }

      await fs.writeFile(localFile(key), dataString);
      return true;
    } catch (error) {
      console.error(`Error writing data for key ${key}:`, error);
      throw error;
    }
  }

  async function readData(key: string): Promise<any> {
    try {
      if (key === 'creds') {
        return await getAuthKey(sessionId);
      }

      if (isRedisEnabled()) {
        const data = await cache.hGet(sessionId, key);
        return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
      }

      if (!(await fileExists(localFile(key)))) return null;
      
      const rawData = await fs.readFile(localFile(key), { encoding: 'utf-8' });
      return JSON.parse(rawData, BufferJSON.reviver);
    } catch (error) {
      console.error(`Error reading data for key ${key}:`, error);
      return null;
    }
  }

  async function removeData(key: string): Promise<any> {
    try {
      if (key === 'creds') {
        return await deleteAuthKey(sessionId);
      }

      if (isRedisEnabled()) {
        const deleted = await cache.hDelete(sessionId, key);
        if (!deleted) {
          throw new Error(`Failed to delete key ${key} from Redis`);
        }
        return deleted;
      }

      await fs.unlink(localFile(key));
      return true;
    } catch (error) {
      console.error(`Error removing data for key ${key}:`, error);
      throw error;
    }
  }

  // Inicialização das credenciais
  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeData(creds, 'creds');
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
}
