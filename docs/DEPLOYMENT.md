# Guide de déploiement et de configuration — Blogify

Ce guide explique comment installer, tester, déployer, configurer, superviser puis supprimer la
plateforme Blogify sur un compte AWS (y compris un compte **AWS Academy Learner Lab**).

## Sommaire

1. [Prérequis](#1-prérequis)
2. [Installation et vérifications locales](#2-installation-et-vérifications-locales)
3. [Premier déploiement](#3-premier-déploiement)
4. [Paramètres de la stack](#4-paramètres-de-la-stack)
5. [Après le déploiement : sorties, premier administrateur, vérification](#5-après-le-déploiement)
6. [Mises à jour et environnements multiples](#6-mises-à-jour-et-environnements-multiples)
7. [Cas particulier : AWS Academy Learner Lab](#7-cas-particulier--aws-academy-learner-lab)
8. [Développement et tests en local](#8-développement-et-tests-en-local)
9. [Supervision et exploitation](#9-supervision-et-exploitation)
10. [Coûts](#10-coûts)
11. [Suppression de la stack](#11-suppression-de-la-stack)
12. [Dépannage](#12-dépannage)

---

## 1. Prérequis

| Outil | Version | Vérification |
|---|---|---|
| Compte AWS | droits CloudFormation, IAM, Lambda, API Gateway, DynamoDB, S3, Cognito, SNS, SQS, EventBridge, CloudFront, CloudWatch | — |
| AWS CLI | v2 | `aws --version` |
| AWS SAM CLI | ≥ 1.120 | `sam --version` |
| Node.js + npm | Node ≥ 22 (les fonctions tournent en Node.js 24 sur Lambda) | `node --version` |
| Git | — | `git --version` |
| Docker *(optionnel)* | pour DynamoDB Local et `sam local` | `docker --version` |

Configurer des identifiants AWS (au choix) :

```bash
aws configure                      # clé d'accès + région par défaut (ex. eu-west-3)
# ou
aws configure sso                  # IAM Identity Center
# ou variables d'environnement : AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
aws sts get-caller-identity        # doit afficher votre compte
```

## 2. Installation et vérifications locales

```bash
git clone <url-du-depot> blogify && cd blogify      # ou décompresser l'archive ZIP
npm ci                                               # installe les dépendances (versions figées)
npm test                                             # tests unitaires (aucun accès AWS requis)
npm run validate                                     # sam validate --lint (template + cfn-lint)
npm run build                                        # bundles esbuild -> dist/<fonction>/index.mjs
```

Tests d'intégration (facultatifs, nécessitent Docker) :

```bash
npm run ddb:start            # DynamoDB Local sur http://localhost:8000
npm run test:integration     # scénario complet : workflow éditorial, Streams, tags, recherche, commentaires, médias
npm run ddb:stop
```

## 3. Premier déploiement

```bash
npm run deploy:guided        # = npm run build && sam deploy --guided
```

Réponses recommandées aux questions de `sam deploy --guided` :

| Question | Réponse conseillée |
|---|---|
| Stack Name | `blogify-dev` |
| AWS Region | votre région (ex. `eu-west-3` Paris ; **`us-east-1`** sur AWS Academy) |
| Parameter Stage | `dev` |
| Parameter AllowedOrigin | `*` (ou l'URL exacte de votre front-end, ex. `https://blog.example.com`) |
| Parameter PublicSiteUrl | URL publique du blog (facultatif, utilisée dans les e-mails) |
| Parameter AdminEmail | votre e-mail pour recevoir un compte administrateur (facultatif, voir §5.2) |
| Parameter AutoConfirmUsers | `true` pour une démonstration, `false` en production |
| Parameter EnableMediaCdn | `true` (CloudFront) ; `false` si votre compte ne peut pas créer de distribution |
| Parameter MaxImageSizeMB / MaxVideoSizeMB | `10` / `200` |
| Parameter LogRetentionDays | `14` |
| Parameter LambdaRoleArn | vide (SAM crée un rôle par fonction) — **`LabRole` sur AWS Academy** |
| Confirm changes before deploy | `Y` |
| Allow SAM CLI IAM role creation | `Y` |
| Disable rollback | `N` |
| *XxxFunction has no authentication. Is this okay?* | `y` — ces routes sont volontairement publiques (lecture, inscription, connexion) |
| Save arguments to configuration file | `Y` (fichier `samconfig.toml`, environnement `default`) |

La création prend en général **5 à 10 minutes**, dont l'essentiel pour la distribution CloudFront.
Les déploiements suivants se font simplement avec `npm run deploy`.

> Sans le script npm : `npm run build` puis `sam deploy --guided`. La commande `sam build` n'est
> pas nécessaire (les fonctions sont déjà bundlées par esbuild dans `dist/`), mais elle fonctionne
> aussi si vous la lancez.

## 4. Paramètres de la stack

| Paramètre | Défaut | Description |
|---|---|---|
| `Stage` | `dev` | Nom de l'étape API Gateway (apparaît dans l'URL) ; minuscules, chiffres, tirets |
| `AllowedOrigin` | `*` | Origine CORS autorisée pour l'API et le bucket S3 |
| `PublicSiteUrl` | *(vide)* | URL du front-end, utilisée pour construire les liens des e-mails (`<url>/posts/<slug>`) |
| `AdminEmail` | *(vide)* | Si renseigné, crée un administrateur ; Cognito lui envoie un mot de passe temporaire |
| `AutoConfirmUsers` | `true` | `true` : comptes confirmés sans code e-mail (démo). `false` : code de vérification obligatoire |
| `EnableMediaCdn` | `true` | Diffuse les médias via CloudFront ; sinon l'API renvoie des URL S3 présignées (1 h) |
| `MaxImageSizeMB` | `10` | Taille maximale d'une image |
| `MaxVideoSizeMB` | `200` | Taille maximale d'une vidéo |
| `LogRetentionDays` | `14` | Rétention des journaux CloudWatch |
| `LambdaRoleArn` | *(vide)* | Rôle IAM existant à utiliser pour toutes les fonctions (AWS Academy : `LabRole`) |

Variables d'environnement injectées dans les fonctions (gérées par le template, à ne pas
modifier à la main) : `TABLE_NAME`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `MEDIA_BUCKET`,
`MEDIA_CDN_DOMAIN`, `TOPIC_ARN`, `EVENT_BUS_NAME`, `ALLOWED_ORIGIN`, `AUTO_CONFIRM_USERS`,
`MAX_IMAGE_MB`, `MAX_VIDEO_MB`, `PUBLIC_SITE_URL`, `STAGE`, `APP_VERSION`.

## 5. Après le déploiement

### 5.1 Sorties de la stack

```bash
aws cloudformation describe-stacks --stack-name blogify-dev \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
```

| Sortie | Utilité |
|---|---|
| `ApiUrl` | URL de base de l'API, ex. `https://abc123.execute-api.eu-west-3.amazonaws.com/dev` |
| `DocsUrl` | Documentation interactive Swagger UI (`<ApiUrl>/docs`) |
| `UserPoolId`, `UserPoolClientId` | Configuration Cognito (utile si un front-end utilise Amplify) |
| `TableName`, `MediaBucketName`, `MediaCdnDomain` | Ressources de données |
| `NewPostTopicArn` | Topic SNS de la newsletter |
| `ProcessingDLQUrl` | File des traitements asynchrones en échec |

### 5.2 Créer le premier administrateur

Les inscriptions publiques donnent le rôle `guest-author`. Pour obtenir un administrateur :

**Option A — script (recommandé, immédiat)** :

```bash
npm run bootstrap-admin -- --email admin@example.com --password 'Admin-Passw0rd' \
  --name "Administrateur" --stack blogify-dev --region eu-west-3
```

Le script crée le compte (ou le met à jour s'il existe), fixe un mot de passe définitif et
l'ajoute au groupe `admin`. L'option `--role editor` permet de créer un éditeur.

**Option B — paramètre `AdminEmail`** : Cognito envoie un e-mail contenant un mot de passe
temporaire. Première connexion :

```bash
curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<mot de passe temporaire>"}'
# -> {"challenge":"NEW_PASSWORD_REQUIRED","session":"..."}
curl -s -X POST "$API/auth/new-password" -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","newPassword":"Nouveau-Passw0rd","session":"..."}'
```

**Option C — console / CLI** : ajouter un utilisateur existant au groupe `admin`
(`aws cognito-idp admin-add-user-to-group --user-pool-id <id> --username <email> --group-name admin`).
L'utilisateur doit se reconnecter pour que son nouveau rôle figure dans son jeton.

### 5.3 Vérifier le déploiement

```bash
API=$(aws cloudformation describe-stacks --stack-name blogify-dev \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
curl -s "$API/health"                       # {"status":"ok",...}
open "$API/docs"                            # Swagger UI (ou copier l'URL dans un navigateur)
npm run smoke -- --stack blogify-dev --region eu-west-3
```

Le **smoke test** joue un scénario complet sur l'infrastructure réelle (inscription, connexion,
brouillon, `If-Match`, upload d'image, soumission, publication par un éditeur, projections de tags
et de recherche, commentaire modéré) puis supprime les données de test. Ajoutez `--keep` pour
conserver les données créées.

## 6. Mises à jour et environnements multiples

```bash
npm run deploy               # rebuild + sam deploy avec les paramètres enregistrés
```

Pour un environnement de production distinct, ajoutez une section dans `samconfig.toml` :

```toml
[prod.global.parameters]
stack_name = "blogify-prod"

[prod.deploy.parameters]
capabilities = "CAPABILITY_IAM CAPABILITY_AUTO_EXPAND"
confirm_changeset = true
resolve_s3 = true
region = "eu-west-3"
parameter_overrides = "Stage=\"prod\" AutoConfirmUsers=\"false\" AllowedOrigin=\"https://blog.example.com\" PublicSiteUrl=\"https://blog.example.com\" LogRetentionDays=\"90\""
```

puis `npm run build && sam deploy --config-env prod`. Chaque environnement est une stack
CloudFormation indépendante (table, user pool, bucket… séparés).

## 7. Cas particulier : AWS Academy Learner Lab

1. Démarrer le lab, puis copier les identifiants temporaires (*AWS Details → AWS CLI*) dans
   `~/.aws/credentials` (profil `default`). Ils expirent à la fin de la session.
2. Utiliser la région **`us-east-1`**.
3. Le Learner Lab interdit la création de rôles IAM : renseigner le paramètre `LambdaRoleArn`
   avec le rôle fourni :

   ```bash
   aws iam get-role --role-name LabRole --query Role.Arn --output text
   # arn:aws:iam::123456789012:role/LabRole
   npm run build
   sam deploy --guided --parameter-overrides LambdaRoleArn=arn:aws:iam::123456789012:role/LabRole
   ```

   Avec ce paramètre, SAM ne crée aucun rôle : toutes les fonctions utilisent `LabRole`
   (le template le gère par une condition CloudFormation).
4. Si la création de la distribution CloudFront est refusée, redéployer avec
   `EnableMediaCdn=false` : les médias seront servis par URL S3 présignées.

## 8. Développement et tests en local

| Commande | Effet |
|---|---|
| `npm test` | Tests unitaires de toutes les fonctions (SDK AWS simulé) |
| `npm run coverage` | Idem avec rapport de couverture |
| `npm run ddb:start` / `npm run ddb:stop` | Démarre / arrête DynamoDB Local (Docker) |
| `npm run test:integration` | Scénario de bout en bout sur DynamoDB Local, avec rejeu des Streams dans `Projector` et `Notifier` |
| `node scripts/create-local-table.mjs` | Crée la table `blogify-local` (même schéma que le template) dans DynamoDB Local |
| `sam local invoke <Fonction> -e events/<fichier>.json --env-vars events/env.local.json` | Invoque une fonction dans le conteneur Lambda officiel (voir `events/README.md`) |

## 9. Supervision et exploitation

- **Journaux** : toutes les fonctions écrivent dans le groupe `/aws/lambda/<stack>` au format JSON.

  ```bash
  aws logs tail /aws/lambda/blogify-dev --follow           # flux en direct (toutes les fonctions)
  sam logs --cw-log-group /aws/lambda/blogify-dev --tail   # équivalent avec SAM CLI
  ```

  Exemples de requêtes **CloudWatch Logs Insights** :

  ```
  # Requêtes HTTP les plus lentes
  fields @timestamp, message.route, message.status, message.durationMs
  | filter message.message = "request"
  | sort message.durationMs desc | limit 20

  # Taux d'erreurs serveur par route
  filter message.message = "request" and message.status >= 500
  | stats count() by message.route
  ```

- **Traces** : console X-Ray → *Service map* (API Gateway → Lambda → DynamoDB/S3/SNS).
- **Métriques** : API Gateway (`Count`, `4XXError`, `5XXError`, `Latency`), Lambda (`Errors`,
  `Throttles`, `Duration`, `ConcurrentExecutions`), DynamoDB (`ConsumedRead/WriteCapacityUnits`,
  `ThrottledRequests`), SQS (`ApproximateNumberOfMessagesVisible` de la DLQ).
- **File d'erreurs** : un message dans `ProcessingDLQ` signale un traitement asynchrone abandonné :

  ```bash
  aws sqs receive-message --queue-url <ProcessingDLQUrl> --max-number-of-messages 10
  ```

## 10. Coûts

Tous les services sont facturés à l'usage ; une démonstration reste dans les offres gratuites :

| Service | Offre gratuite (indicative) | Au-delà |
|---|---|---|
| Lambda | 1 M requêtes + 400 000 Go-s / mois | ≈ 0,20 $ / M requêtes (arm64 : -20 % sur la durée) |
| API Gateway REST | 1 M appels / mois (12 premiers mois) | ≈ 3,50 $ / M appels |
| DynamoDB (à la demande) | 25 Go de stockage | ≈ 0,125 $ / M unités de lecture, 0,625 $ / M unités d'écriture |
| S3 | 5 Go (12 premiers mois) | ≈ 0,023 $ / Go-mois |
| CloudFront | 1 To de transfert / mois | selon la zone |
| Cognito | 10 000 utilisateurs actifs / mois | selon le palier |
| SNS (e-mail) | 1 000 e-mails / mois | ≈ 2 $ / 100 000 e-mails |

La seule dépense fixe possible est le stockage (DynamoDB, S3, journaux) ; il n'y a **aucun serveur
allumé en permanence**.

## 11. Suppression de la stack

Le bucket des médias doit être vidé avant la suppression :

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name blogify-dev \
  --query "Stacks[0].Outputs[?OutputKey=='MediaBucketName'].OutputValue" --output text)
aws s3 rm "s3://$BUCKET" --recursive
sam delete --stack-name blogify-dev
```

La table DynamoDB, le user pool, le topic SNS, la file SQS, la distribution CloudFront et les
journaux sont supprimés avec la stack.

## 12. Dépannage

| Symptôme | Cause probable / solution |
|---|---|
| `sam deploy` : *Unable to upload artifact … dist/…* | Les bundles n'existent pas : lancer `npm run build` (ou utiliser `npm run deploy`) |
| `CREATE_FAILED` sur `MediaDistribution` (*account must be verified*) | Compte récent ou restreint : redéployer avec `EnableMediaCdn=false` |
| `not authorized to perform: iam:CreateRole` | Compte sans droits IAM (AWS Academy) : renseigner `LambdaRoleArn` |
| `401 UNAUTHORIZED` sur une route protégée | Envoyer le **idToken** (pas l'accessToken) : `Authorization: Bearer <idToken>` ; jeton expiré après 60 min → `POST /auth/refresh` |
| `403` juste après un changement de rôle | Le rôle est lu dans le jeton : se reconnecter ou rafraîchir le jeton |
| `403 USER_NOT_CONFIRMED` à la connexion | Confirmer avec `POST /auth/confirm` (code reçu par e-mail) ou déployer avec `AutoConfirmUsers=true` |
| Erreur CORS dans le navigateur | Le paramètre `AllowedOrigin` doit correspondre exactement à l'origine du front-end |
| Média bloqué en `pending` | Vérifier que l'upload S3 a renvoyé `204`, puis les journaux de `MediaProcessorFunction` et la DLQ |
| Média `rejected` | Type réel différent du type déclaré, fichier trop gros ou format non autorisé (voir `rejectionReason`) |
| Article absent de `GET /posts?tag=` ou de `/search` juste après publication | Projections asynchrones : attendre une seconde ; sinon consulter les journaux de `ProjectorFunction` |
| E-mail de confirmation SNS non reçu | Vérifier les courriers indésirables ; l'abonnement reste en attente tant qu'il n'est pas confirmé |
| `429 TOO_MANY_REQUESTS` | Limite de débit API Gateway atteinte : réessayer plus tard (limites ajustables dans `MethodSettings`) |
