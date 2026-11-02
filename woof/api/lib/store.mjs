// Persistence. In AWS (TABLE_NAME set) records go to DynamoDB; locally they
// go to a JSON file so the app can run with no AWS account at all.
//
// DynamoDB table: partition key "id" (String), no sort key.
// Item types: "visit" (one per page load) and "found" (one per claim).

let store;

export function getStore() {
  if (store) return store;
  if (process.env.TABLE_NAME) {
    store = dynamoStore(process.env.TABLE_NAME);
  } else if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error('TABLE_NAME must be set when running in Lambda');
  } else {
    store = fileStore(process.env.LOCAL_STORE_FILE || new URL('../../dev/data.json', import.meta.url).pathname);
  }
  return store;
}

/** For tests. */
export function setStore(s) {
  store = s;
}

function dynamoStore(TableName) {
  // The AWS SDK v3 ships with the Lambda Node.js runtime, so it is not a
  // bundled dependency. Imported lazily so local dev doesn't need it.
  const ready = (async () => {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
    });
    return { doc, PutCommand, UpdateCommand };
  })();

  return {
    async put(item) {
      const { doc, PutCommand } = await ready;
      await doc.send(new PutCommand({ TableName, Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
    },
    async appendLocation(id, location, now) {
      const { doc, UpdateCommand } = await ready;
      try {
        const res = await doc.send(
          new UpdateCommand({
            TableName,
            Key: { id },
            UpdateExpression: 'SET locations = list_append(if_not_exists(locations, :empty), :loc), updatedAt = :now',
            ConditionExpression: 'attribute_exists(id) AND #type = :visit',
            ExpressionAttributeNames: { '#type': 'type' },
            ExpressionAttributeValues: { ':empty': [], ':loc': [location], ':now': now, ':visit': 'visit' },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return res.Attributes;
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return undefined;
        throw err;
      }
    },
  };
}

function fileStore(path) {
  // node:fs is imported lazily so this module also loads in a browser
  // (the artifact test console swaps in its own store).
  const fs = import('node:fs/promises');
  const readFile = async (...a) => (await fs).readFile(...a);
  const writeFile = async (...a) => (await fs).writeFile(...a);
  // Serialise writes so concurrent requests don't clobber each other.
  let chain = Promise.resolve();
  const load = async () => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return {};
    }
  };
  const save = (data) => writeFile(path, JSON.stringify(data, null, 2));
  const locked = (fn) => (chain = chain.then(fn, fn));

  return {
    path,
    put: (item) =>
      locked(async () => {
        const data = await load();
        if (data[item.id]) throw new Error('duplicate id');
        data[item.id] = item;
        await save(data);
      }),
    appendLocation: (id, location, now) =>
      locked(async () => {
        const data = await load();
        const item = data[id];
        if (!item || item.type !== 'visit') return undefined;
        item.locations = [...(item.locations || []), location];
        item.updatedAt = now;
        await save(data);
        return item;
      }),
    all: () => locked(load),
  };
}
