const { MongoClient } = require('mongodb');

const READY_STATE = {
  disconnected: 0,
  connected: 1
};

class Schema {
  constructor(definition = {}, options = {}) {
    this.definition = definition;
    this.options = options;
    this._indexes = [];
  }

  index(fields, options = {}) {
    this._indexes.push({ fields, options });
    return this;
  }
}

Schema.Types = {
  Mixed: Symbol('Mixed')
};

class Query {
  constructor(collection, filter = {}, projection, options = {}) {
    this._collection = collection;
    this._filter = filter || {};
    this._projection = projection;
    this._options = { ...options };
    this._limit = null;
    this._batchSize = null;
  }

  lean() {
    this._options.lean = true;
    return this;
  }

  limit(value) {
    this._limit = value;
    return this;
  }

  batchSize(value) {
    this._batchSize = value;
    return this;
  }

  select(projection) {
    this._projection = projection;
    return this;
  }

  _buildCursor() {
    const findOptions = { ...this._options };

    if (this._projection !== undefined) {
      findOptions.projection = this._projection;
    }

    if (this._batchSize !== null) {
      findOptions.batchSize = this._batchSize;
    }

    const cursor = this._collection.find(this._filter, findOptions);

    if (this._limit !== null) {
      cursor.limit(this._limit);
    }

    return cursor;
  }

  cursor() {
    return this._buildCursor();
  }

  async exec() {
    const cursor = this._buildCursor();
    const documents = await cursor.toArray();
    return documents;
  }

  then(resolve, reject) {
    return this.exec().then(resolve, reject);
  }

  catch(reject) {
    return this.exec().catch(reject);
  }
}

class MongooseModel {
  constructor(connection, name, schema, collectionName) {
    if (!connection || !connection._client) {
      throw new Error('Неможливо створити модель без активного підключення.');
    }

    this.connection = connection;
    this.name = name;
    this.schema = schema;
    this.collectionName = collectionName || name;
    this.collection = connection._db.collection(this.collectionName);
  }

  find(filter = {}, projection, options = {}) {
    return new Query(this.collection, filter, projection, options);
  }

  async aggregate(pipeline = []) {
    const cursor = this.collection.aggregate(pipeline);
    const results = await cursor.toArray();
    return results;
  }

  async create(document) {
    const doc = { ...document };
    const result = await this.collection.insertOne(doc);
    doc._id = result.insertedId;
    return doc;
  }

  async insertMany(documents, options = {}) {
    const docs = documents.map((item) => ({ ...item }));
    const result = await this.collection.insertMany(docs, options);
    return docs.map((doc, index) => {
      doc._id = result.insertedIds[index];
      return doc;
    });
  }

  updateOne(filter, update, options = {}) {
    return this.collection.updateOne(filter, update, options);
  }

  updateMany(filter, update, options = {}) {
    return this.collection.updateMany(filter, update, options);
  }

  replaceOne(filter, replacement, options = {}) {
    return this.collection.replaceOne(filter, replacement, options);
  }

  deleteOne(filter, options = {}) {
    return this.collection.deleteOne(filter, options);
  }

  deleteMany(filter, options = {}) {
    return this.collection.deleteMany(filter, options);
  }
}

class MongooseConnection {
  constructor(client = null, dbName = null, parent = null) {
    this._client = client;
    this._dbName = dbName;
    this._parent = parent;
    this._models = {};
    this._children = new Map();
    this.readyState = client ? READY_STATE.connected : READY_STATE.disconnected;
    this.name = dbName || null;
    this.models = this._models;
    if (!client) {
      this._db = null;
    } else if (dbName) {
      this._db = client.db(dbName);
    } else {
      this._db = client.db();
      this._dbName = this._db.databaseName;
      this.name = this._dbName;
    }
  }

  model(name, schema, collectionName) {
    if (schema === undefined) {
      return this._models[name];
    }

    if (!this._db) {
      throw new Error('Підключення до бази даних ще не встановлено.');
    }

    if (this._models[name]) {
      return this._models[name];
    }

    const model = new MongooseModel(this, name, schema, collectionName);
    this._models[name] = model;
    return model;
  }

  useDb(dbName, options = {}) {
    const { useCache = false } = options;

    if (!this._client) {
      throw new Error('Неможливо перемкнути базу даних без активного клієнта.');
    }

    if (useCache && this._children.has(dbName)) {
      return this._children.get(dbName);
    }

    const child = new MongooseConnection(this._client, dbName, this);

    if (useCache) {
      this._children.set(dbName, child);
    }

    return child;
  }

  async close() {
    if (this._parent) {
      return;
    }

    if (this._client) {
      await this._client.close();
    }

    this.readyState = READY_STATE.disconnected;
  }
}

function createDisconnectedConnection() {
  return new MongooseConnection();
}

const mongoose = {
  Schema,
  Types: {},
  connection: createDisconnectedConnection(),
  connections: [],
  model(name, schema, collectionName) {
    return this.connection.model(name, schema, collectionName);
  },
  async connect(uri, options = {}) {
    const { dbName, ...clientOptions } = options;
    const client = new MongoClient(uri, clientOptions);
    await client.connect();
    const connection = new MongooseConnection(client, dbName || null);
    this.connection = connection;
    this.connections = [connection];
    this.Types.ObjectId = require('mongodb').ObjectId;
    return connection;
  },
  async disconnect() {
    if (this.connection) {
      await this.connection.close();
    }

    this.connection = createDisconnectedConnection();
    this.connections = [this.connection];
  }
};

module.exports = mongoose;
