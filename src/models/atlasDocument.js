import mongoose from 'mongoose';

const atlasDocumentSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      maxlength: [256, 'Заголовок не може перевищувати 256 символів.']
    },
    category: {
      type: String,
      trim: true,
      maxlength: [128, 'Категорія не може перевищувати 128 символів.'],
      index: true
    },
    status: {
      type: String,
      trim: true,
      enum: {
        values: ['draft', 'active', 'archived'],
        message: 'Статус має бути одним із: draft, active або archived.'
      },
      default: 'draft',
      index: true
    },
    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
        message: 'Теги мають бути масивом рядків.'
      }
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    }
  },
  {
    strict: false,
    minimize: false,
    timestamps: {
      createdAt: 'createdAt',
      updatedAt: 'updatedAt'
    }
  }
);

atlasDocumentSchema.index({ status: 1, createdAt: -1 });
atlasDocumentSchema.index({ category: 1, title: 1 });

const modelCache = new Map();

export function getAtlasDocumentModel() {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    throw new Error('Підключення до бази даних неактивне. Викличте connectToDatabase() перед доступом до моделі.');
  }

  const configuredCollection = process.env.MONGODB_COLLECTION;
  let collectionName = configuredCollection || 'samples';
  let databaseName = null;

  if (configuredCollection && configuredCollection.includes('.')) {
    const [firstSegment, ...rest] = configuredCollection.split('.');
    const derivedCollection = rest.join('.');

    if (derivedCollection) {
      databaseName = firstSegment;
      collectionName = derivedCollection;
    }
  }

  const cacheKey = `${databaseName || mongoose.connection.name || 'default'}:${collectionName}`;

  if (modelCache.has(cacheKey)) {
    return { model: modelCache.get(cacheKey), collectionName };
  }

  const targetConnection =
    databaseName && databaseName !== mongoose.connection.name
      ? mongoose.connection.useDb(databaseName, { useCache: true })
      : mongoose.connection;

  const modelName = `AtlasDocument_${collectionName}`;
  const AtlasDocument = targetConnection.model(modelName, atlasDocumentSchema, collectionName);
  modelCache.set(cacheKey, AtlasDocument);

  return { model: AtlasDocument, collectionName };
}
