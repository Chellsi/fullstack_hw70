import mongoose from 'mongoose';

let connectionPromise = null;

export class MongoConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MongoConfigurationError';
  }
}

export async function connectToDatabase() {
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  const { MONGODB_URI, MONGODB_DB_NAME } = process.env;

  if (!MONGODB_URI) {
    throw new MongoConfigurationError('Змінна оточення MONGODB_URI не налаштована.');
  }

  if (!MONGODB_DB_NAME) {
    throw new MongoConfigurationError('Змінна оточення MONGODB_DB_NAME не налаштована.');
  }

  if (!connectionPromise) {
    const mongooseOptions = {
      dbName: MONGODB_DB_NAME,
      serverSelectionTimeoutMS:
        Number.parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10) || 5000
    };

    if (process.env.MONGODB_DIRECT_CONNECTION === 'true') {
      mongooseOptions.directConnection = true;
    }

    const allowInvalidCerts = process.env.MONGODB_TLS_ALLOW_INVALID_CERTS === 'true';
    const allowInvalidHostnames = process.env.MONGODB_TLS_ALLOW_INVALID_HOSTNAMES === 'true';
    const tlsInsecure = process.env.MONGODB_TLS_INSECURE === 'true';

    if (allowInvalidCerts) {
      mongooseOptions.tlsAllowInvalidCertificates = true;
    }

    if (allowInvalidHostnames) {
      mongooseOptions.tlsAllowInvalidHostnames = true;
    }

    if (tlsInsecure) {
      mongooseOptions.tlsInsecure = true;
    }

    if (allowInvalidCerts || tlsInsecure) {
      // Atlas інколи завершує TLS рукостискання ще до того, як драйвер врахує опції.
      // NODE_TLS_REJECT_UNAUTHORIZED=0 гарантує, що середовище Node не зірве з'єднання.
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    if (process.env.MONGODB_TLS_CA_FILE) {
      mongooseOptions.tlsCAFile = process.env.MONGODB_TLS_CA_FILE;
    }

    connectionPromise = mongoose
      .connect(MONGODB_URI, mongooseOptions)
      .catch((error) => {
        connectionPromise = null;
        if (isTlsHandshakeError(error)) {
          const hint =
            'Atlas відхилив TLS-з’єднання. Додайте в .env параметр MONGODB_TLS_CA_FILE або ' +
            'MONGODB_TLS_ALLOW_INVALID_CERTS=true/MONGODB_TLS_INSECURE=true, щоб використати власний ' +
            'сертифікат або тимчасово вимкнути перевірку. За потреби також додайте ' +
            'MONGODB_TLS_ALLOW_INVALID_HOSTNAMES=true.';
          throw new MongoConfigurationError(`${hint}\n${error.message}`);
        }

        throw error;
      });
  }

  await connectionPromise;
  return mongoose.connection;
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
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    throw new Error('Базу даних ще не ініціалізовано. Спочатку викличте connectToDatabase().');
  }

  return mongoose.connection;
}

export async function closeDatabaseConnection() {
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }

  connectionPromise = null;
}
