import { Router } from 'express';
import { connectToDatabase, MongoConfigurationError } from '../config/database.js';
import { getAtlasDocumentModel } from '../models/atlasDocument.js';

const atlasRouter = Router();

const resolveModel = async () => {
  await connectToDatabase();
  const { model, collectionName } = getAtlasDocumentModel();
  return { model, collectionName };
};

const parseJsonParam = (value, fallback) => {
  if (value === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    const parsingError = new Error('Не вдалося розпарсити JSON параметр. Перевірте синтаксис.');
    parsingError.status = 400;
    throw parsingError;
  }
};

atlasRouter.get('/data', async (req, res, next) => {
  const theme = req.cookies.theme || 'light';
  const viewModel = {
    title: 'Дані з MongoDB Atlas',
    theme,
    user: req.user,
    documents: [],
    collectionName: process.env.MONGODB_COLLECTION || 'samples',
    error: null
  };

  try {
    const { model, collectionName } = await resolveModel();
    const documents = await model
      .find({}, undefined, { lean: true })
      .limit(25)
      .exec();

    viewModel.collectionName = collectionName;
    viewModel.documents = documents;
    res.render('atlas/index', viewModel);
  } catch (error) {
    if (error instanceof MongoConfigurationError) {
      viewModel.error = error.message;
      res.status(500).render('atlas/index', viewModel);
      return;
    }

    if (error.name === 'MongoServerSelectionError') {
      viewModel.error = 'Не вдалося підключитися до MongoDB Atlas. Перевірте параметри підключення.';
      res.status(502).render('atlas/index', viewModel);
      return;
    }

    next(error);
  }
});

atlasRouter.get('/api/documents', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const filter = parseJsonParam(req.query.filter, {});
    const projection = parseJsonParam(req.query.projection, undefined);
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 0, 100) : 25;
    const query = model.find(filter, projection, { lean: true });

    if (limit > 0) {
      query.limit(limit);
    }

    const documents = await query.exec();
    res.json({
      count: documents.length,
      documents
    });
  } catch (error) {
    if (error.status === 400) {
      res.status(400).json({ error: error.message });
      return;
    }

    next(error);
  }
});

atlasRouter.get('/api/documents/stream', async (req, res, next) => {
  let cursor;

  try {
    const { model } = await resolveModel();
    const filter = parseJsonParam(req.query.filter, {});
    const projection = parseJsonParam(req.query.projection, undefined);
    const limit = req.query.limit ? Math.max(Math.min(parseInt(req.query.limit, 10) || 0, 1000), 0) : 0;
    const batchSize = req.query.batchSize
      ? Math.max(Math.min(parseInt(req.query.batchSize, 10) || 0, 500), 1)
      : undefined;

    const query = model.find(filter, projection, { lean: true });

    if (batchSize !== undefined) {
      query.batchSize(batchSize);
    }

    if (limit > 0) {
      query.limit(limit);
    }

    cursor = query.cursor();

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.write('{"documents":[');

    let count = 0;
    let isFirst = true;

    for await (const document of cursor) {
      const serialized = JSON.stringify(document);
      res.write((isFirst ? '' : ',') + serialized);
      isFirst = false;
      count += 1;
    }

    res.write(`],"count":${count}}`);
    res.end();
  } catch (error) {
    if (cursor) {
      await cursor.close();
    }

    if (error.status === 400) {
      res.status(400).json({ error: error.message });
      return;
    }

    next(error);
    return;
  }

  if (cursor) {
    await cursor.close();
  }
});

atlasRouter.get('/api/documents/stats', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const match = parseJsonParam(req.query.match, {});
    const groupBy = req.query.groupBy || null;
    const avgField = req.query.avgField || null;
    const sumField = req.query.sumField || null;
    const uniqueField = req.query.uniqueField || null;

    const pipeline = [];

    if (match && Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    const groupStage = {
      _id: groupBy ? `$${groupBy}` : null,
      count: { $sum: 1 }
    };

    if (avgField) {
      groupStage.average = { $avg: `$${avgField}` };
    }

    if (sumField) {
      groupStage.total = { $sum: `$${sumField}` };
    }

    if (uniqueField) {
      groupStage.uniqueValues = { $addToSet: `$${uniqueField}` };
    }

    pipeline.push({ $group: groupStage });

    if (uniqueField) {
      pipeline.push({
        $project: {
          _id: 1,
          count: 1,
          average: 1,
          total: 1,
          uniqueCount: { $size: '$uniqueValues' }
        }
      });
    }

    pipeline.push({ $sort: { count: -1 } });

    const results = await model.aggregate(pipeline);

    res.json({
      pipeline,
      results
    });
  } catch (error) {
    if (error.status === 400) {
      res.status(400).json({ error: error.message });
      return;
    }

    next(error);
  }
});

atlasRouter.post('/api/documents', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const { document } = req.body;

    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      res.status(400).json({ error: 'Поле "document" є обов\'язковим та має бути об\'єктом.' });
      return;
    }

    const createdDocument = await model.create(document);
    res.status(201).json({
      acknowledged: true,
      insertedId: createdDocument._id
    });
  } catch (error) {
    next(error);
  }
});

atlasRouter.post('/api/documents/bulk', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const { documents } = req.body;

    if (!Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({ error: 'Поле "documents" має містити масив документів для вставки.' });
      return;
    }

    const insertedDocuments = await model.insertMany(documents);
    const insertedIds = insertedDocuments.reduce((acc, doc, index) => {
      acc[index] = doc._id;
      return acc;
    }, {});
    res.status(201).json({
      acknowledged: true,
      insertedCount: insertedDocuments.length,
      insertedIds
    });
  } catch (error) {
    next(error);
  }
});

atlasRouter.patch('/api/documents/update-one', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const { filter, update, options } = req.body;

    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      res.status(400).json({ error: 'Поле "filter" є обов\'язковим та має бути об\'єктом.' });
      return;
    }

    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      res.status(400).json({ error: 'Поле "update" є обов\'язковим та має бути об\'єктом.' });
      return;
    }

    if (options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
      res.status(400).json({ error: 'Поле "options" має бути об\'єктом, якщо воно передане.' });
      return;
    }

    const result = await model.updateOne(filter, update, options);
    res.json({
      acknowledged: result.acknowledged,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId ?? null
    });
  } catch (error) {
    next(error);
  }
});

atlasRouter.patch('/api/documents/update-many', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const { filter, update, options } = req.body;

    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      res.status(400).json({ error: 'Поле "filter" є обов\'язковим та має бути об\'єктом.' });
      return;
    }

    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      res.status(400).json({ error: 'Поле "update" є обов\'язковим та має бути об\'єктом.' });
      return;
    }

    if (options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
      res.status(400).json({ error: 'Поле "options" має бути об\'єктом, якщо воно передане.' });
      return;
    }

    const result = await model.updateMany(filter, update, options);
    res.json({
      acknowledged: result.acknowledged,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId ?? null
    });
  } catch (error) {
    next(error);
  }
});

atlasRouter.put('/api/documents/replace-one', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const { filter, replacement, options } = req.body;

    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      res.status(400).json({ error: 'Поле "filter" є обов\'язковим та має бути об\'єктом.' });
      return;
    }

    if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) {
      res
        .status(400)
        .json({ error: 'Поле "replacement" є обов\'язковим та має бути об\'єктом без операторів оновлення.' });
      return;
    }

    if (options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
      res.status(400).json({ error: 'Поле "options" має бути об\'єктом, якщо воно передане.' });
      return;
    }

    const result = await model.replaceOne(filter, replacement, options);
    res.json({
      acknowledged: result.acknowledged,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId ?? null
    });
  } catch (error) {
    next(error);
  }
});

atlasRouter.delete('/api/documents/delete-one', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const { filter, options } = req.body;

    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      res.status(400).json({ error: 'Поле "filter" є обов\'язковим та має бути об\'єктом.' });
      return;
    }

    if (options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
      res.status(400).json({ error: 'Поле "options" має бути об\'єктом, якщо воно передане.' });
      return;
    }

    const result = await model.deleteOne(filter, options);
    res.json({
      acknowledged: result.acknowledged,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    next(error);
  }
});

atlasRouter.delete('/api/documents/delete-many', async (req, res, next) => {
  try {
    const { model } = await resolveModel();
    const { filter, options } = req.body;

    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      res.status(400).json({ error: 'Поле "filter" є обов\'язковим та має бути об\'єктом.' });
      return;
    }

    if (options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
      res.status(400).json({ error: 'Поле "options" має бути об\'єктом, якщо воно передане.' });
      return;
    }

    const result = await model.deleteMany(filter, options);
    res.json({
      acknowledged: result.acknowledged,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    next(error);
  }
});

export default atlasRouter;
