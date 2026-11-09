# Documentation de l'API Blogify

Cette page décrit l'API REST de Blogify : conventions communes, authentification, puis chaque
route avec ses paramètres, ses réponses et des exemples. La référence formelle et exhaustive est
la spécification **OpenAPI 3** ([`openapi.yaml`](openapi.yaml)), également servie par l'API :

- `GET /docs` : documentation interactive (Swagger UI) permettant d'essayer chaque route ;
- `GET /openapi.json` : document OpenAPI (importable dans Postman, Insomnia, générateurs de SDK…).

## Sommaire

1. [Généralités](#1-généralités)
2. [Authentification](#2-authentification)
3. [Rôles et permissions](#3-rôles-et-permissions)
4. [Conventions communes](#4-conventions-communes)
5. [Authentification et comptes — `/auth`](#5-authentification-et-comptes--auth)
6. [Profils et administration — `/me`, `/authors`, `/users`](#6-profils-et-administration)
7. [Articles — `/posts`](#7-articles--posts)
8. [Commentaires](#8-commentaires)
9. [Médias — `/media`](#9-médias--media)
10. [Recherche et tags](#10-recherche-et-tags)
11. [Newsletter et intégrations](#11-newsletter-et-intégrations)
12. [Outils — `/docs`, `/openapi.json`, `/health`](#12-outils)
13. [Scénario complet](#13-scénario-complet)

---

## 1. Généralités

| Élément | Valeur |
|---|---|
| URL de base | `https://<api-id>.execute-api.<région>.amazonaws.com/<stage>` (sortie `ApiUrl` de la stack) |
| Format | JSON UTF-8 (`Content-Type: application/json`) ; corps limité à 1 Mio |
| Authentification | `Authorization: Bearer <idToken>` (jeton d'identité Amazon Cognito) |
| Identifiants | UUID v7 (`0192f5a1-7c2b-7d3e-8f40-0a1b2c3d4e5f`), ordonnés dans le temps |
| Dates | ISO 8601 UTC (`2026-10-27T10:00:00.000Z`) |
| Contenu des articles | Markdown, stocké et renvoyé tel quel (le rendu HTML et son assainissement sont à la charge du front-end) |
| CORS | origine configurée par le paramètre `AllowedOrigin` (par défaut `*`) ; en-têtes exposés : `ETag`, `Location` |

Dans les exemples, `$API` désigne l'URL de base et `$TOKEN` un jeton d'identité valide.

## 2. Authentification

1. **Créer un compte** : `POST /auth/register` (le nouveau compte reçoit le rôle `guest-author`).
2. **Confirmer l'e-mail** : `POST /auth/confirm` avec le code reçu (inutile si la stack est
   déployée avec `AutoConfirmUsers=true`).
3. **Se connecter** : `POST /auth/login` renvoie `idToken`, `accessToken`, `refreshToken` et `expiresIn`.
4. **Appeler l'API** avec l'en-tête `Authorization: Bearer <idToken>` (le préfixe `Bearer` est
   facultatif). Le jeton d'identité est valable **60 minutes**.
5. **Renouveler** les jetons avec `POST /auth/refresh` (refresh token valable 30 jours), et
   **se déconnecter** avec `POST /auth/logout` (révocation du refresh token).

Trois catégories de routes :

| Catégorie | Comportement | Routes |
|---|---|---|
| Publiques | aucun jeton nécessaire (un jeton éventuel est ignoré) | `/auth/*`, `GET /authors/{userId}`, `GET /search`, `GET /tags`, `POST /subscriptions`, `/docs`, `/openapi.json`, `/health` |
| Authentification **optionnelle** | sans jeton : contenu public ; avec un jeton valide : droits étendus (ex. lire ses brouillons) ; jeton invalide : `401` | `GET /posts`, `GET /posts/{postId}`, `GET /posts/{postId}/comments`, `POST /posts/{postId}/comments`, `GET /media/{mediaId}` |
| Protégées | jeton obligatoire, vérifié par l'authorizer d'API Gateway (`401` sinon) | toutes les autres |

Un changement de rôle (par un administrateur) prend effet au prochain jeton : l'utilisateur doit se
reconnecter ou rafraîchir ses jetons.

## 3. Rôles et permissions

| Action | `admin` | `editor` | `guest-author` | anonyme |
|---|:-:|:-:|:-:|:-:|
| Lire les articles publiés, les commentaires approuvés, rechercher | ✔ | ✔ | ✔ | ✔ |
| Commenter (modération obligatoire pour les anonymes) | ✔ | ✔ | ✔ | ✔ |
| S'abonner à la newsletter | ✔ | ✔ | ✔ | ✔ |
| Créer un article (brouillon) | ✔ | ✔ | ✔ | |
| Modifier / supprimer ses brouillons, les soumettre à relecture | ✔ | ✔ | ✔ | |
| Lire, modifier, supprimer tous les articles | ✔ | ✔ | | |
| Publier, dépublier, rejeter, archiver | ✔ | ✔ | | |
| Modérer et supprimer les commentaires | ✔ | ✔ | | |
| Téléverser des médias, gérer ses médias | ✔ | ✔ | ✔ | |
| Gérer tous les médias | ✔ | ✔ | | |
| Gérer les utilisateurs et les rôles | ✔ | | | |
| Lister les abonnés | ✔ | | | |

`GET /me` renvoie la liste exacte des permissions (`permissions`) de l'utilisateur connecté, ce qui
permet au front-end d'afficher ou de masquer les actions.

## 4. Conventions communes

### 4.1 Codes de statut

| Code | Signification |
|---|---|
| `200 OK` | Lecture ou modification réussie |
| `201 Created` | Ressource créée ; l'en-tête `Location` donne son URL |
| `202 Accepted` | Demande prise en compte (e-mail envoyé, abonnement en attente de confirmation) |
| `204 No Content` | Suppression ou déconnexion réussie |
| `400 Bad Request` | Corps ou paramètres invalides |
| `401 Unauthorized` | Jeton absent, invalide ou expiré ; identifiants incorrects |
| `403 Forbidden` | Authentifié mais non autorisé |
| `404 Not Found` | Ressource inexistante **ou invisible pour l'appelant** (ex. brouillon d'un autre auteur) |
| `409 Conflict` | Conflit d'état (slug déjà pris, transition impossible, modification concurrente…) |
| `412 Precondition Failed` | `If-Match` ne correspond plus à la version actuelle |
| `413` / `415` | Fichier trop volumineux / type non pris en charge |
| `429 Too Many Requests` | Limite de débit atteinte |
| `500` / `503` | Erreur interne / service momentanément indisponible (réessayer) |

### 4.2 Format des erreurs

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "title", "message": "Title is required" },
      { "field": "(root)", "message": "Unknown field(s): titel" }
    ]
  },
  "requestId": "c6af9ac6-7b61-11e6-9a41-93e8deadbeef"
}
```

`code` est stable et destiné aux programmes ; `message` est destiné aux développeurs ;
`requestId` permet de retrouver la requête dans les journaux.

| Code d'erreur | Statut | Cas |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Champ manquant, invalide, hors limites ou inconnu |
| `BAD_REQUEST` | 400 | JSON invalide, curseur invalide, en-tête `If-Match` mal formé… |
| `INVALID_PASSWORD`, `INVALID_CODE`, `EXPIRED_CODE`, `INVALID_PARAMETER` | 400 | Erreurs Cognito lors de l'inscription, de la confirmation ou de la réinitialisation |
| `INVALID_PARENT` | 400 | Réponse à un commentaire inexistant ou non approuvé |
| `UNAUTHORIZED` | 401 | Jeton manquant, invalide ou expiré |
| `INVALID_CREDENTIALS` | 401 | E-mail ou mot de passe incorrect |
| `INVALID_TOKEN` | 401 | Refresh token invalide ou révoqué |
| `FORBIDDEN` | 403 | Permission insuffisante |
| `USER_NOT_CONFIRMED` | 403 | Compte non confirmé (`POST /auth/confirm`) |
| `PASSWORD_RESET_REQUIRED` | 403 | Réinitialisation du mot de passe requise |
| `COMMENTS_DISABLED` | 403 | Commentaires fermés sur cet article |
| `NOT_FOUND`, `ROUTE_NOT_FOUND` | 404 | Ressource ou route inconnue |
| `USER_EXISTS` | 409 | Adresse e-mail déjà utilisée |
| `SLUG_TAKEN` | 409 | Slug déjà utilisé par un autre article |
| `INVALID_STATE_TRANSITION` | 409 | Transition impossible depuis le statut actuel |
| `CONFLICT` | 409 | Modification concurrente (réessayer) |
| `SELF_MODIFICATION` | 409 | Un administrateur ne peut pas changer son propre rôle ni se désactiver |
| `ALREADY_SUBSCRIBED` | 409 | Adresse déjà abonnée avec d'autres préférences |
| `PRECONDITION_FAILED` | 412 | Version périmée (`If-Match`) |
| `PAYLOAD_TOO_LARGE` | 413 | Corps de requête ou média trop volumineux |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type` non JSON ou type de média refusé |
| `TOO_MANY_REQUESTS` | 429 | Limite de débit (API Gateway ou Cognito) |
| `INTERNAL_ERROR` | 500 | Erreur inattendue (détails uniquement dans les journaux) |
| `SERVICE_UNAVAILABLE` | 503 | Service AWS momentanément saturé (en-tête `Retry-After`) |

### 4.3 Validation

Les corps et paramètres sont validés par des schémas stricts : les chaînes sont nettoyées des espaces
en début et fin, les **champs inconnus sont refusés** (`400`), et chaque erreur est listée dans
`details`.

### 4.4 Pagination

Les listes acceptent `limit` (taille de page) et `cursor`, et renvoient :

```json
{ "items": [ ... ], "nextCursor": "eyJQSyI6IlBPU1Qj..." }
```

Pour obtenir la page suivante, renvoyer la même requête avec `cursor=<nextCursor>`. `nextCursor`
vaut `null` sur la dernière page. Le curseur est opaque : ne pas le construire ni le modifier.

### 4.5 Concurrence optimiste (`ETag` / `If-Match`)

Les réponses portant un article complet contiennent `ETag: "v<version>"`. Pour éviter d'écraser
la modification d'un autre utilisateur, renvoyer cette valeur dans `If-Match` lors d'un `PATCH`,
d'une transition ou d'un `DELETE` : si l'article a changé entre-temps, l'API répond
`412 PRECONDITION_FAILED` (relire l'article puis réessayer).

### 4.6 Cache HTTP

Les lectures publiques anonymes renvoient `Cache-Control: public, max-age=60` (300 s pour `/tags`) ;
les réponses à un utilisateur authentifié sont `private, no-store`. L'en-tête `Vary: Authorization`
empêche un cache de mélanger les deux.

### 4.7 Limites de débit

| Route | Débit soutenu | Rafale |
|---|---|---|
| Toutes les routes (par défaut) | 100 req/s | 200 |
| `POST /auth/register` | 5 req/s | 10 |
| `POST /auth/login` | 10 req/s | 20 |
| `POST /auth/forgot-password` | 2 req/s | 5 |
| `POST /posts/{postId}/comments` | 5 req/s | 10 |
| `POST /subscriptions` | 2 req/s | 5 |

Au-delà, API Gateway répond `429 TOO_MANY_REQUESTS`.

### 4.8 Cohérence à terme

Les index de **tags** (`GET /tags`, `GET /posts?tag=`) et de **recherche** (`GET /search`) sont
mis à jour de façon asynchrone par DynamoDB Streams, généralement en moins d'une seconde après une
publication, une modification ou une dépublication. Les listes servies par les index secondaires
(`GET /posts`, files de modération, médiathèque) sont également cohérentes à terme.

---

## 5. Authentification et comptes — `/auth`

| Méthode et route | Corps | Réponse |
|---|---|---|
| `POST /auth/register` | `email`, `password`, `name` (1–80) | `201` `{ userId, email, name, role, confirmed, nextStep }` |
| `POST /auth/confirm` | `email`, `code` | `200` `{ confirmed: true }` |
| `POST /auth/resend-code` | `email` | `202` `{ message }` |
| `POST /auth/login` | `email`, `password` | `200` jetons, ou défi `NEW_PASSWORD_REQUIRED` |
| `POST /auth/refresh` | `refreshToken` | `200` nouveaux jetons |
| `POST /auth/new-password` | `email`, `newPassword`, `session` | `200` jetons |
| `POST /auth/forgot-password` | `email` | `202` `{ message }` (toujours, même si le compte n'existe pas) |
| `POST /auth/reset-password` | `email`, `code`, `newPassword` | `200` `{ message }` |
| `POST /auth/logout` | `refreshToken` | `204` |

Mot de passe : 8 caractères minimum dont une minuscule, une majuscule et un chiffre.

```bash
curl -s -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"jeanne@example.com","password":"Passw0rd-Jeanne","name":"Jeanne Martin"}'
```

```json
{
  "userId": "8f6b2a1e-0c4d-4f43-9e3a-5b8c7d6e1f20",
  "email": "jeanne@example.com",
  "name": "Jeanne Martin",
  "role": "guest-author",
  "confirmed": true,
  "nextStep": "LOGIN"
}
```

```bash
curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"jeanne@example.com","password":"Passw0rd-Jeanne"}'
```

```json
{
  "tokenType": "Bearer",
  "idToken": "eyJraWQiOiJ...",
  "accessToken": "eyJraWQiOiJ...",
  "refreshToken": "eyJjdHkiOiJ...",
  "expiresIn": 3600
}
```

Pour un compte créé par un administrateur (mot de passe temporaire), la connexion renvoie
`{ "challenge": "NEW_PASSWORD_REQUIRED", "session": "..." }` : appeler alors
`POST /auth/new-password` avec la `session` reçue.

## 6. Profils et administration

| Méthode et route | Accès | Description |
|---|---|---|
| `GET /me` | authentifié | Compte courant : `id, email, name, role, roles, permissions, bio, avatarUrl, website, createdAt, updatedAt` |
| `PATCH /me` | authentifié | Modifier `name` (1–80), `bio` (≤ 1000), `avatarUrl`, `website` (URL ; `null` pour effacer) |
| `GET /authors/{userId}` | public | Profil public : `id, name, bio, avatarUrl, website` (jamais l'e-mail) |
| `GET /users` | admin | Liste des comptes : `limit` (1–60, défaut 20), `cursor`, `role` (filtre facultatif) |
| `POST /users` | admin | Inviter un utilisateur : `email`, `name`, `role` → Cognito envoie un mot de passe temporaire ; `201` |
| `PATCH /users/{userId}` | admin | Changer `role` (`admin`, `editor`, `guest-author`) et/ou `enabled` (`false` = désactivation et déconnexion de toutes ses sessions) |

Un utilisateur administré est représenté ainsi :

```json
{
  "id": "8f6b2a1e-0c4d-4f43-9e3a-5b8c7d6e1f20",
  "email": "jeanne@example.com",
  "name": "Jeanne Martin",
  "status": "CONFIRMED",
  "enabled": true,
  "role": "editor",
  "createdAt": "2026-10-27T09:00:00.000Z",
  "updatedAt": "2026-10-27T11:00:00.000Z"
}
```

Le changement de nom via `PATCH /me` est aussi enregistré dans Cognito (il apparaîtra dans les
prochains jetons) ; les articles déjà écrits conservent le nom d'auteur de leur création.

## 7. Articles — `/posts`

### 7.1 Représentation

```json
{
  "id": "0192f5a1-7c2b-7d3e-8f40-0a1b2c3d4e5f",
  "slug": "architecture-serverless-avec-aws-lambda",
  "title": "Architecture serverless avec AWS Lambda",
  "excerpt": "Introduction Un article sur DynamoDB, API Gateway et Lambda.",
  "content": "# Introduction\n\nUn article sur **DynamoDB**...",
  "coverImageUrl": "https://d111111abcdef8.cloudfront.net/media/0192.../schema.png",
  "tags": ["aws", "serverless"],
  "status": "published",
  "allowComments": true,
  "author": { "id": "8f6b2a1e-0c4d-4f43-9e3a-5b8c7d6e1f20", "name": "Jeanne Martin" },
  "readingTimeMinutes": 4,
  "commentCount": 2,
  "reviewNote": null,
  "createdAt": "2026-10-27T09:00:00.000Z",
  "updatedAt": "2026-10-27T10:00:00.000Z",
  "submittedAt": "2026-10-27T09:30:00.000Z",
  "publishedAt": "2026-10-27T10:00:00.000Z",
  "version": 3
}
```

`content` n'est présent que dans les réponses portant un seul article (jamais dans les listes).
`excerpt` est calculé automatiquement à partir du contenu sauf s'il a été fourni ; `slug` est généré
à partir du titre (minuscules, sans accents) et rendu unique (`-2`, `-3`… si nécessaire) ;
`readingTimeMinutes` est estimé à 200 mots par minute.

### 7.2 Routes CRUD

| Méthode et route | Accès | Description |
|---|---|---|
| `GET /posts` | optionnel | Liste paginée, du plus récent au plus ancien |
| `GET /posts/{postId}` | optionnel | Un article par **identifiant ou slug** (+ `ETag`) |
| `POST /posts` | `post:create` | Crée un brouillon → `201` + `Location` + `ETag` |
| `PATCH /posts/{postId}` | auteur ou éditeur | Modification partielle (`If-Match` conseillé) |
| `DELETE /posts/{postId}` | auteur ou éditeur | Suppression → `204` (les commentaires et index associés sont supprimés en arrière-plan) |

Corps de création (seul `title` est obligatoire) :

| Champ | Type | Contraintes |
|---|---|---|
| `title` | chaîne | 1–200 caractères |
| `content` | chaîne Markdown | ≤ 100 000 caractères (défaut `""`) |
| `excerpt` | chaîne ou `null` | ≤ 500 caractères ; vide ou absent = automatique |
| `tags` | tableau de chaînes | ≤ 10 tags de 1–40 caractères, normalisés (`"Serverless AWS"` → `serverless-aws`) |
| `slug` | chaîne | facultatif, `[a-z0-9-]`, ≤ 80 ; `409 SLUG_TAKEN` s'il est déjà pris |
| `coverImageUrl` | URL ou `null` | image de couverture (par exemple l'`url` d'un média) |
| `allowComments` | booléen | `true` par défaut |

`PATCH` accepte les mêmes champs, tous facultatifs (au moins un). Un auteur invité ne peut modifier
ou supprimer que **ses** articles en statut `draft` ou `in_review`.

Paramètres de `GET /posts` :

| Paramètre | Défaut | Description |
|---|---|---|
| `limit` | 10 | 1 à 50 |
| `cursor` | — | Curseur `nextCursor` de la page précédente |
| `status` | `published` | `draft`, `in_review` ou `archived` : authentification requise ; un auteur invité ne voit que ses articles |
| `tag` | — | Articles publiés portant ce tag |
| `author` | — | Identifiant d'auteur, ou `me` pour ses propres articles (authentification requise) |

Exemples :

```bash
curl -s "$API/posts?limit=5"                                        # derniers articles publiés
curl -s "$API/posts?tag=serverless"                                 # par tag
curl -s "$API/posts?status=draft&author=me" -H "Authorization: Bearer $TOKEN"   # mes brouillons
curl -s "$API/posts?status=in_review" -H "Authorization: Bearer $TOKEN"         # file de relecture (éditeur)
curl -s "$API/posts/architecture-serverless-avec-aws-lambda"        # par slug

curl -s -X PATCH "$API/posts/$POST_ID" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'If-Match: "v1"' \
  -d '{"excerpt":"Un résumé choisi par l’auteur","tags":["aws","dynamodb"]}'
```

### 7.3 Workflow éditorial

| Route (`POST`) | Depuis | Vers | Qui |
|---|---|---|---|
| `/posts/{postId}/submit` | `draft` | `in_review` | l'auteur (ou un éditeur) |
| `/posts/{postId}/publish` | `draft`, `in_review`, `archived` | `published` | éditeur, admin |
| `/posts/{postId}/unpublish` | `published` | `draft` | éditeur, admin |
| `/posts/{postId}/reject` | `in_review` | `draft` (corps facultatif `{ "note": "..." }`, ≤ 1000) | éditeur, admin |
| `/posts/{postId}/archive` | `draft`, `in_review`, `published` | `archived` | éditeur, admin |

Chaque transition renvoie l'article complet (`200` + `ETag`). Une transition impossible renvoie
`409 INVALID_STATE_TRANSITION`. La **première** publication déclenche l'e-mail aux abonnés et
l'événement `PostPublished` ; `publishedAt` est conservé lors des republications.

## 8. Commentaires

| Méthode et route | Accès | Description |
|---|---|---|
| `GET /posts/{postId}/comments` | optionnel | Commentaires approuvés, du plus ancien au plus récent ; `limit` (1–100, défaut 20), `cursor` ; les modérateurs peuvent filtrer `status` (`pending`, `rejected`, `spam`, `all`) |
| `POST /posts/{postId}/comments` | optionnel | Ajoute un commentaire sur un article publié |
| `PATCH /posts/{postId}/comments/{commentId}` | modérateur | `{ "status": "approved" \| "rejected" \| "spam" }` |
| `DELETE /posts/{postId}/comments/{commentId}` | modérateur ou auteur du commentaire | `204` |
| `GET /comments` | modérateur | File de modération : `status` (défaut `pending`), `limit`, `cursor` |

Corps de création :

| Champ | Contraintes |
|---|---|
| `body` | 1–2000 caractères |
| `authorName` | 1–80, **obligatoire pour un lecteur anonyme** (ignoré si authentifié) |
| `authorEmail` | e-mail facultatif (lecteur anonyme) ; jamais affiché publiquement |
| `parentId` | facultatif : réponse à un commentaire approuvé du même article |

Un commentaire anonyme est créé avec le statut `pending` et n'apparaît qu'après approbation ; un
commentaire d'un membre ayant un rôle est approuvé immédiatement. `commentCount` (sur l'article)
compte les commentaires approuvés.

```bash
curl -s -X POST "$API/posts/$POST_ID/comments" -H 'Content-Type: application/json' \
  -d '{"body":"Très clair, merci !","authorName":"Lectrice"}'
```

```json
{
  "id": "0192f6b3-1a2b-7c3d-9e4f-5a6b7c8d9e0f",
  "postId": "0192f5a1-7c2b-7d3e-8f40-0a1b2c3d4e5f",
  "parentId": null,
  "body": "Très clair, merci !",
  "author": { "id": null, "name": "Lectrice" },
  "status": "pending",
  "createdAt": "2026-10-27T11:00:00.000Z"
}
```

Les modérateurs reçoivent en plus `authorEmail`, `postTitle`, `moderatedBy`, `moderatedAt` et `updatedAt`.

## 9. Médias — `/media`

| Méthode et route | Accès | Description |
|---|---|---|
| `POST /media` | `media:upload` | Déclare un fichier et obtient une URL d'upload présignée → `201` |
| `GET /media` | authentifié | Médiathèque : ses médias ; tous pour un éditeur (`owner=me` ou `owner=<userId>` pour filtrer) ; `limit` (1–100, défaut 20), `cursor` |
| `GET /media/{mediaId}` | optionnel | Un média ; ceux en attente ou rejetés ne sont visibles que de leur propriétaire et des éditeurs |
| `PATCH /media/{mediaId}` | propriétaire ou éditeur | `{ "altText": "..." }` (≤ 300, `null` pour effacer) |
| `DELETE /media/{mediaId}` | propriétaire ou éditeur | Supprime le fichier S3 et ses métadonnées → `204` |

Types acceptés : `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/avif` (10 Mo par défaut)
et `video/mp4`, `video/webm`, `video/quicktime` (200 Mo par défaut). Le SVG est refusé.

### Téléversement en trois étapes

**1. Déclarer le fichier**

```bash
curl -s -X POST "$API/media" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"filename":"schema.png","contentType":"image/png","size":48213,"altText":"Schéma d’architecture"}'
```

```json
{
  "id": "0192f6c4-...",
  "filename": "schema.png",
  "contentType": "image/png",
  "kind": "image",
  "size": 48213,
  "status": "pending",
  "altText": "Schéma d’architecture",
  "url": null,
  "owner": { "id": "8f6b2a1e-...", "name": "Jeanne Martin" },
  "createdAt": "2026-10-27T11:05:00.000Z",
  "updatedAt": "2026-10-27T11:05:00.000Z",
  "upload": {
    "method": "POST",
    "url": "https://blogify-dev-mediabucket-xxxx.s3.eu-west-3.amazonaws.com/",
    "fields": { "key": "media/0192f6c4-.../schema.png", "Content-Type": "image/png", "Policy": "...", "X-Amz-Signature": "..." },
    "expiresAt": "2026-10-27T11:20:00.000Z"
  }
}
```

**2. Envoyer le fichier directement à S3** (formulaire multipart : tous les `fields`, puis le
fichier en **dernier**), avant `expiresAt` :

```bash
# avec curl : un -F par champ de "fields", puis le fichier
curl -s -X POST "<upload.url>" -F "key=<...>" -F "Content-Type=image/png" -F "Policy=<...>" \
  -F "X-Amz-Algorithm=<...>" -F "X-Amz-Credential=<...>" -F "X-Amz-Date=<...>" \
  -F "X-Amz-Security-Token=<...>" -F "X-Amz-Signature=<...>" -F "file=@schema.png"
```

```js
// dans un navigateur
const form = new FormData();
Object.entries(media.upload.fields).forEach(([key, value]) => form.append(key, value));
form.append('file', fichier);                       // toujours en dernier
await fetch(media.upload.url, { method: 'POST', body: form });   // 204 attendu
```

S3 refuse un fichier plus gros que la taille déclarée ou d'un autre type.

**3. Attendre la validation** : quelques instants plus tard, `GET /media/{mediaId}` renvoie
`status: "ready"` et l'`url` publique (CloudFront) à utiliser dans les articles. Si le contenu ne
correspond pas au type déclaré (vérification de la signature binaire), le fichier est supprimé et
le média passe en `rejected` avec un `rejectionReason`. Une déclaration jamais suivie d'upload
expire au bout de 24 h.

## 10. Recherche et tags

`GET /search?q=<texte>&limit=<1-50>` (public) recherche dans les articles publiés (titre, tags,
extrait et contenu), sans tenir compte des accents ni de la casse, en ignorant les mots vides
français et anglais. Les résultats sont classés par nombre de termes trouvés puis par pertinence
(titre ×10, tags ×6, extrait ×3, occurrences dans le contenu).

```json
{
  "query": "lambda dynamodb",
  "terms": ["lambda", "dynamodb"],
  "total": 1,
  "items": [
    {
      "id": "0192f5a1-...", "slug": "architecture-serverless-avec-aws-lambda",
      "title": "Architecture serverless avec AWS Lambda", "excerpt": "...",
      "coverImageUrl": null, "tags": ["aws", "serverless"],
      "author": { "id": "8f6b2a1e-...", "name": "Jeanne Martin" },
      "publishedAt": "2026-10-27T10:00:00.000Z", "readingTimeMinutes": 4,
      "score": 25, "matchedTerms": 2
    }
  ]
}
```

`GET /tags` (public) renvoie les tags des articles publiés et leur nombre d'articles :
`{ "items": [ { "tag": "aws", "postCount": 12 }, ... ] }`, triés par popularité.

## 11. Newsletter et intégrations

| Méthode et route | Accès | Description |
|---|---|---|
| `POST /subscriptions` | public | `{ "email": "...", "tags": ["aws"] }` → `202` ; Amazon SNS envoie un e-mail de confirmation (double opt-in) |
| `GET /subscriptions` | admin | Abonnés : `{ items: [{ email, status, subscriptionArn }], nextCursor }` (`status` : `pending_confirmation` ou `confirmed`) |

Sans `tags`, l'abonné reçoit tous les nouveaux articles ; avec `tags`, seulement ceux qui portent au
moins un de ces tags. Chaque e-mail contient un lien de désabonnement géré par SNS.

À chaque **première** publication, un événement est aussi publié sur le bus EventBridge par défaut,
ce qui permet de brancher n'importe quelle intégration (webhook, reconstruction d'un site statique,
Slack…) avec une simple règle :

```json
{
  "source": "blogify.posts",
  "detail-type": "PostPublished",
  "detail": {
    "postId": "0192f5a1-...", "slug": "architecture-serverless-avec-aws-lambda",
    "title": "Architecture serverless avec AWS Lambda", "excerpt": "...",
    "tags": ["aws", "serverless"], "authorId": "8f6b2a1e-...", "authorName": "Jeanne Martin",
    "publishedAt": "2026-10-27T10:00:00.000Z", "url": "https://blog.example.com/posts/architecture-serverless-avec-aws-lambda"
  }
}
```

## 12. Outils

| Route | Description |
|---|---|
| `GET /docs` | Documentation interactive Swagger UI (bouton *Authorize* : coller l'`idToken`) |
| `GET /openapi.json` | Spécification OpenAPI 3 de l'API déployée |
| `GET /health` | `{ "status": "ok", "service": "blogify", "version": "1.0.0", "stage": "dev", "time": "..." }` |

## 13. Scénario complet

```bash
API=https://<api-id>.execute-api.<region>.amazonaws.com/dev

# Auteur invité : inscription, connexion, brouillon, soumission
curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"auteur@example.com","password":"Passw0rd-Auteur","name":"Auteur"}'
AUTHOR=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"auteur@example.com","password":"Passw0rd-Auteur"}' | jq -r .idToken)
POST_ID=$(curl -s -X POST $API/posts -H "Authorization: Bearer $AUTHOR" -H 'Content-Type: application/json' \
  -d '{"title":"Mon premier article","content":"# Bonjour\n\nMarkdown **serverless**.","tags":["aws"]}' | jq -r .id)
curl -s -X POST $API/posts/$POST_ID/submit -H "Authorization: Bearer $AUTHOR"

# Éditeur (créé avec : npm run bootstrap-admin -- --email editeur@example.com --password ... --role editor)
EDITOR=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"editeur@example.com","password":"<mot de passe>"}' | jq -r .idToken)
curl -s "$API/posts?status=in_review" -H "Authorization: Bearer $EDITOR"
curl -s -X POST $API/posts/$POST_ID/publish -H "Authorization: Bearer $EDITOR"

# Lecteur anonyme : lecture, recherche, commentaire
curl -s "$API/posts?limit=5"
curl -s "$API/search?q=serverless"
curl -s -X POST $API/posts/$POST_ID/comments -H 'Content-Type: application/json' \
  -d '{"body":"Bravo !","authorName":"Lecteur"}'

# Modération
curl -s "$API/comments?status=pending" -H "Authorization: Bearer $EDITOR"
```

Le script `npm run smoke` exécute automatiquement un scénario équivalent (avec upload d'image) sur
la stack déployée.
