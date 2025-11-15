import { MongoClient } from 'mongodb';

let cachedClient = null;
let cachedDb = null;
let clientPromise = null;

export class MongoConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MongoConfigurationError';
  }
}

export async function connectToDatabase() {
  if (cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  const { MONGODB_URI, MONGODB_DB_NAME } = process.env;

  if (!MONGODB_URI) {
    throw new MongoConfigurationError('Змінна оточення MONGODB_URI не налаштована.');
  }

  if (!MONGODB_DB_NAME) {
    throw new MongoConfigurationError('Змінна оточення MONGODB_DB_NAME не налаштована.');
  }

  if (!clientPromise) {
    const mongoOptions = {
      serverSelectionTimeoutMS:
        Number.parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10) || 5000
    };

    if (process.env.MONGODB_DIRECT_CONNECTION === 'true') {
      mongoOptions.directConnection = true;
    }

    if (process.env.MONGODB_TLS_ALLOW_INVALID_CERTS === 'true') {
      mongoOptions.tlsAllowInvalidCertificates = true;
    }

    if (process.env.MONGODB_TLS_CA_FILE) {
      mongoOptions.tlsCAFile = process.env.MONGODB_TLS_CA_FILE;
    }

    const client = new MongoClient(MONGODB_URI, mongoOptions);

    clientPromise = client
      .connect()
      .then((connectedClient) => {
        cachedClient = connectedClient;
        cachedDb = connectedClient.db(MONGODB_DB_NAME);
        return { client: cachedClient, db: cachedDb };
      })
      .catch((error) => {
        clientPromise = null;
        if (isTlsHandshakeError(error)) {
          const hint =
            'Atlas відхилив TLS-з’єднання. Додайте в .env параметр MONGODB_TLS_CA_FILE або ' +
            'MONGODB_TLS_ALLOW_INVALID_CERTS=true, щоб використати власний сертифікат або тимчасово ' +
            'вимкнути перевірку.';
          throw new MongoConfigurationError(`${hint}\n${error.message}`);
        }

        throw error;
      });
  }

  return clientPromise;
}

function isTlsHandshakeError(error) {
  const tlsErrorCodes = new Set([
    'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
    'ERR_SSL_CERTIFICATE',
    'ERR_SSL_SELF_SIGNED_CERT_IN_CHAIN'
  ]);

  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return null;
    }

    if (value.code && tlsErrorCodes.has(value.code)) {
      return value.code;
    }

    if (value.cause) {
      return visit(value.cause);
    }

    return null;
  };

  return Boolean(visit(error));
}

export function getDb() {
  if (!cachedDb) {
    throw new Error('Базу даних ще не ініціалізовано. Спочатку викличте connectToDatabase().');
  }

  return cachedDb;
}

export async function closeDatabaseConnection() {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    cachedDb = null;
    clientPromise = null;
  }
}
