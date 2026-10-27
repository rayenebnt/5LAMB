# Blogify — support de présentation

Plan de la soutenance (≈ 20 minutes + démonstration), avec le contenu de chaque diapositive et des
notes pour l'oral. Le diaporama correspondant est fourni séparément (export PowerPoint / PDF).

---

## 1. Titre

**Blogify — une plateforme de blogging headless 100 % serverless sur AWS**
Mini-projet AWS Lambda · API REST · DynamoDB · S3 · Cognito

> *Notes* : présenter le contexte en une phrase : une startup veut un backend de blog évolutif,
> intégrable à n'importe quel front-end.

## 2. Contexte et objectifs

- Blogify cible créateurs de contenu, journalistes et entreprises.
- Besoin : un **CMS headless** (contenu exposé par API, aucun rendu côté serveur).
- Contraintes : évolutivité, coût proportionnel à l'usage, sécurité, intégration facile.
- Réponse : architecture **serverless et orientée événements** sur AWS.

## 3. Périmètre réalisé

| Exigence | Statut |
|---|---|
| Authentification sécurisée + rôles admin / éditeur / auteur invité | ✔ |
| CRUD des articles via Lambda, stockage DynamoDB | ✔ |
| Médias (images, vidéos) sur S3 | ✔ |
| API REST sécurisée via API Gateway | ✔ |
| *Optionnel* : commentaires + modération | ✔ |
| *Optionnel* : recherche | ✔ |
| *Optionnel* : notifications aux abonnés | ✔ |

Chiffres clés : **42 routes REST**, **13 fonctions Lambda**, 1 table DynamoDB, tests unitaires et
d'intégration, documentation OpenAPI interactive.

## 4. Architecture globale

Schéma : front-ends → API Gateway (+ authorizer Lambda) → fonctions Lambda par domaine → DynamoDB /
Cognito / S3 ; S3 → EventBridge → validation des médias ; DynamoDB Streams → projections (tags,
recherche) et notifications (SNS, EventBridge) ; SQS pour les échecs.

> *Notes* : insister sur la séparation **synchrone** (réponse rapide) / **asynchrone** (effets de bord).

## 5. Composants serverless

API Gateway (REST, throttling, CORS) · Lambda Node.js 24 arm64 · DynamoDB à la demande ·
S3 + CloudFront (OAC) · Cognito (user pool + groupes) · SNS · EventBridge · SQS (DLQ) ·
CloudWatch + X-Ray · AWS SAM (Infrastructure as Code).

## 6. Choix d'architecture

- **Une Lambda par contexte métier** + séparation lecture/écriture des articles (CQRS léger).
- **Authorizer Lambda** vérifiant les JWT Cognito (mis en cache 5 min).
- **Event-driven** : Streams et EventBridge découplent index, notifications et validation.
- **arm64 + bundles esbuild** : coût réduit, démarrages à froid courts.
- **SAM** : toute l'infrastructure versionnée, déployable en une commande.

## 7. Modélisation des données

- **Single-table design** : articles, slugs, commentaires, médias, profils, tags, termes de recherche.
- Clés génériques `PK`/`SK` + 2 GSI surchargés ; identifiants UUID v7 ordonnés dans le temps.
- 13 motifs d'accès, chacun servi par **une seule requête** (`GetItem`/`Query`, jamais de `Scan`).

## 8. Index et cohérence

- GSI1 : articles par statut, par tag, file de modération, médiathèque.
- GSI2 : articles et médias d'un utilisateur.
- Projection `INCLUDE` : les listes ne lisent jamais le corps des articles.
- Transactions (slug unique, compteurs), verrouillage optimiste (`ETag`/`If-Match`), TTL.

## 9. Sécurité — authentification

- Cognito : politique de mots de passe, vérification d'e-mail, jetons JWT (ID 60 min, refresh 30 j).
- `Authorization: Bearer <idToken>` vérifié par l'authorizer : signature RS256 (JWKS), expiration,
  émetteur, audience, type de jeton.
- Routes publiques à authentification optionnelle (relecture de ses brouillons).

## 10. Sécurité — autorisations

Matrice RBAC (admin / editor / guest-author / anonyme) + contrôle de propriété ; 404 pour les
ressources invisibles ; un auteur invité ne peut pas publier ; un admin ne peut pas se rétrograder.
**Moindre privilège** : un rôle IAM par fonction, lecture seule pour les fonctions publiques.

## 11. Sécurité — données et entrées

- Validation stricte de chaque entrée (schémas zod), corps limité à 1 Mio.
- Médias : POST présigné (taille + type imposés par S3), vérification des *magic bytes*, SVG refusé.
- Chiffrement au repos et en transit, bucket privé + CloudFront OAC.
- Throttling par route, honeypot, modération, double opt-in, pas d'énumération de comptes.

## 12. Conception de l'API

- Ressources REST : `/posts`, `/posts/{id}/comments`, `/media`, `/users`, `/me`, `/tags`, `/search`…
- Verbes HTTP et codes de statut standard (201 + `Location`, 204, 400, 401, 403, 404, 409, 412, 429).
- Erreurs homogènes `{ error: { code, message, details }, requestId }`.
- Pagination par curseur opaque `nextCursor` ; cache HTTP (`Cache-Control`, `ETag`).
- Documentation OpenAPI 3 + Swagger UI servie par l'API (`/docs`).

## 13. Points de terminaison

| Domaine | Routes |
|---|---|
| Auth | register, confirm, resend-code, login, refresh, new-password, forgot/reset-password, logout |
| Utilisateurs | `/me`, `/authors/{id}`, `/users` (admin : liste, invitation, rôle, activation) |
| Articles | CRUD + `submit`, `publish`, `unpublish`, `reject`, `archive` |
| Commentaires | liste, création, modération, suppression, file `/comments` |
| Médias | demande d'upload, liste, détail, texte alternatif, suppression |
| Découverte | `/search`, `/tags` |
| Abonnements | `/subscriptions` |
| Outils | `/docs`, `/openapi.json`, `/health` |

## 14. Exemple : créer puis publier un article

```http
POST /posts
Authorization: Bearer eyJraWQiOi...
Content-Type: application/json

{ "title": "Architecture serverless", "content": "# Intro…", "tags": ["aws"] }
```
→ `201 Created`, `Location: /posts/{id}`, `ETag: "v1"`, statut `draft`.
Puis `POST /posts/{id}/submit` (auteur) → `POST /posts/{id}/publish` (éditeur).

## 15. Workflow éditorial et commentaires

Diagramme d'états : `draft → in_review → published → archived` (+ rejet avec note, dépublication).
Commentaires : anonymes en attente de modération, membres approuvés automatiquement, compteur
atomique, réponses à un commentaire.

## 16. Fonctionnalités optionnelles

- **Recherche** : index inversé dans DynamoDB (titre ×10, tags ×6, extrait ×3, contenu), normalisation
  des accents, mots vides FR/EN, classement par pertinence.
- **Notifications** : e-mail SNS aux abonnés (filtrage par tags), événement EventBridge
  `PostPublished` pour webhooks et sites statiques ; idempotence garantie.

## 17. Résilience et observabilité

Retries, découpage des lots, échecs partiels, DLQ SQS, consommateurs idempotents ; journaux JSON
structurés, traces X-Ray, `GET /health`.

## 18. Qualité et déploiement

- Tests unitaires (SDK AWS simulé) + intégration sur DynamoDB Local avec rejeu des Streams.
- Smoke test de bout en bout sur la stack réelle ; CI GitHub Actions ; `cfn-lint`.
- Déploiement : `npm run deploy:guided` (paramètres : stage, CORS, CDN, AWS Academy `LabRole`…).

## 19. Évolutivité et performances

- Déjà en place : stateless, à la demande, cache HTTP, compression, médias hors API, asynchrone.
- Points de contention : partition `POSTS#published`, compteurs de tags, recherche, cold starts.
- Recommandations : CloudFront devant l'API, Provisioned Concurrency, OpenSearch, WAF,
  write sharding, Global Tables, digest e-mail, Step Functions, EventBridge Scheduler.

## 20. Démonstration et conclusion

Démo : Swagger UI → inscription → brouillon → upload d'image → soumission → publication par un
éditeur → recherche / tags → commentaire modéré (ou `npm run smoke`).
Conclusion : toutes les exigences (principales et optionnelles) sont couvertes, l'architecture est
prête à évoluer sans modifier le cœur de l'API.
