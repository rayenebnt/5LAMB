# Événements d'exemple (`sam local invoke`)

Ces fichiers permettent d'invoquer une fonction localement, après `npm run build` :

```bash
# Lecture publique des articles (API Gateway -> PostsQueryFunction)
sam local invoke PostsQueryFunction -e events/list-posts.json --env-vars events/env.local.json

# Création d'un article par un auteur invité (contexte de l'authorizer simulé)
sam local invoke PostsCommandFunction -e events/create-post.json --env-vars events/env.local.json

# Notification S3 "Object Created" reçue via EventBridge
sam local invoke MediaProcessorFunction -e events/s3-object-created.json --env-vars events/env.local.json

# Enregistrement DynamoDB Streams (publication d'un article)
sam local invoke ProjectorFunction -e events/stream-post-published.json --env-vars events/env.local.json
```

`env.local.json` pointe vers DynamoDB Local (`npm run ddb:start`) via `DYNAMODB_ENDPOINT`
(`host.docker.internal` permet au conteneur Lambda de joindre la machine hôte). La table doit
exister : `node scripts/create-local-table.mjs`.
