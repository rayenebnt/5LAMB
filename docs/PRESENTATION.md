# Blogify — support de présentation et script

Soutenance courte : **10 diapositives (≈ 9 min) puis la démonstration (≈ 4 min)**. Le diaporama est
fourni séparément (export PowerPoint / PDF) ; le texte « À dire » ci-dessous figure aussi dans les
notes d'orateur de chaque diapositive. Déroulé de la démonstration et questions probables du jury :
[DEMO.md](DEMO.md).

| # | Diapositive | Durée |
|---|---|---|
| 1 | Titre | 30 s |
| 2 | Périmètre | 45 s |
| 3 | Architecture globale | 1 min 15 |
| 4 | Six choix structurants | 1 min |
| 5 | Une seule table DynamoDB | 1 min |
| 6 | Sécurité en couches | 1 min |
| 7 | Conventions de l'API REST | 45 s |
| 8 | Workflow éditorial et bonus | 1 min |
| 9 | Passer à l'échelle | 1 min |
| 10 | Conclusion, puis démonstration | 30 s + 4 min |

---

## 1. Titre

**Blogify — une plateforme de blogging headless 100 % serverless sur AWS**
API Gateway · Lambda · DynamoDB · S3 + CloudFront · Cognito · SNS · EventBridge · AWS SAM

> **À dire** : Bonjour. Je vous présente Blogify, le backend d'une plateforme de blogging headless,
> c'est-à-dire sans interface graphique : tout passe par une API REST, que n'importe quel site ou
> application peut utiliser. Tout repose sur des services serverless d'AWS, donc aucun serveur à
> gérer. Je vais présenter l'architecture, les données, la sécurité, l'API et l'évolutivité, puis
> faire une démonstration.

## 2. Périmètre — toutes les exigences sont couvertes

| Exigence du sujet | Statut |
|---|---|
| Authentification + 3 rôles | Réalisé |
| CRUD des articles (Lambda + DynamoDB) | Réalisé |
| Médias images et vidéos sur S3 | Réalisé |
| API REST sécurisée (API Gateway) | Réalisé |
| Commentaires et modération · Recherche · Notifications | Bonus réalisés |

**42** routes REST · **13** fonctions Lambda · **0** serveur à administrer

> **À dire** : Le sujet demandait quatre fonctionnalités et en proposait trois en option. Les sept
> sont réalisées : authentification avec trois rôles, CRUD des articles, médias sur S3 et API
> sécurisée ; puis, en bonus, commentaires modérés, recherche et notifications. Au total : 42 routes
> REST et 13 fonctions Lambda.

## 3. Architecture globale

Front-ends → API Gateway (+ authorizer Lambda / Cognito) → fonctions Lambda par domaine → DynamoDB ;
médias : S3 + CloudFront ; en asynchrone : validation des fichiers (EventBridge), index de tags et de
recherche (DynamoDB Streams), notifications (SNS, EventBridge).

> **À dire** : Le client appelle API Gateway avec un jeton. Un authorizer Lambda vérifie ce jeton
> émis par Cognito, puis la requête arrive à la fonction du domaine concerné, qui lit et écrit dans
> DynamoDB. Les fichiers ne passent pas par l'API : ils vont directement dans S3 et sont servis par
> CloudFront. Tout ce qui est en pointillés est asynchrone : validation des fichiers, index de
> recherche et notifications. La réponse à l'utilisateur reste donc rapide.

## 4. Six choix structurants

API REST (quotas par route, erreurs homogènes) · authorizer Lambda (JWT vérifié à l'entrée, cache
5 min) · une Lambda par domaine (moindre privilège) · event-driven · arm64 + esbuild · AWS SAM.

> **À dire** : Six choix structurants. API Gateway en mode REST, pour les quotas par route et les
> erreurs personnalisées. La vérification des jetons à l'entrée, avec un cache de cinq minutes. Une
> fonction par domaine, pour des permissions minimales. Des événements pour sortir les traitements
> lourds de la requête. Des processeurs ARM, environ 20 % moins chers. Et AWS SAM : toute
> l'infrastructure est du code, déployée en une commande.

## 5. Une seule table DynamoDB

Article `POST#id`, slug `SLUG#slug`, commentaire `POST#id / COMMENT#id`, média, profil, projections de
tags et de recherche. 13 motifs d'accès, chacun servi par un seul `GetItem` ou `Query` ; 2 index pour
les listes ; mode à la demande, Streams, TTL, PITR.

> **À dire** : Toutes les données sont dans une seule table DynamoDB. Chaque type d'élément, article,
> commentaire, média ou profil, a une clé pensée pour la façon dont on le lit. Résultat : chaque
> besoin de lecture est servi par une seule requête, jamais par un parcours complet de la table.
> Deux index servent les listes. Le déploiement réel m'a appris une limite : DynamoDB copie au plus
> 20 attributs choisis dans un index ; les index copient donc les éléments complets, et l'API ne
> renvoie que des résumés dans les listes.

## 6. Une sécurité en couches

Authentification (JWT Cognito vérifiés à l'entrée) · rôles (matrice de permissions + propriété) ·
entrées et fichiers (validation stricte, contenu réel vérifié, SVG refusé) · infrastructure (un rôle
IAM minimal par fonction, chiffrement, bucket privé, quotas).

> **À dire** : La sécurité est en couches. Cognito gère les comptes et émet des jetons signés,
> vérifiés à l'entrée de l'API avant qu'une fonction soit appelée. Les trois rôles du sujet sont des
> groupes Cognito, traduits en permissions : par exemple, un auteur invité peut écrire et soumettre,
> mais pas publier. Chaque requête est validée strictement, et un fichier envoyé est vérifié sur son
> contenu réel, pas seulement sur son extension. Enfin, chaque fonction n'a que les droits dont elle
> a besoin.

## 7. Conventions de l'API REST

Ressources au pluriel, verbes HTTP standard · 201 + `Location`, 204, 400, 401, 403, 404, 409, 412,
429 · erreurs `{ error: { code, message }, requestId }` · pagination `nextCursor` · `ETag` /
`If-Match` · OpenAPI 3 + Swagger UI (`/docs`).

> **À dire** : L'API suit les conventions REST : des ressources au pluriel, les verbes HTTP standard
> et des codes précis, par exemple 201 à la création, ou 412 si quelqu'un a modifié l'article
> entre-temps. Les erreurs ont toujours le même format, les listes sont paginées, et toute l'API est
> documentée en OpenAPI, avec une interface Swagger en ligne.

## 8. Workflow éditorial et bonus

`draft → in_review → published → archived` (+ rejet avec note, dépublication) · commentaires
modérés · recherche par pertinence · e-mail aux abonnés filtré par tags.

> **À dire** : Un article suit un workflow : l'auteur écrit un brouillon et le soumet ; l'éditeur le
> publie, ou le rejette avec une note, ce qui le renvoie en brouillon. Chaque étape vérifie le rôle :
> un auteur invité qui tente de publier reçoit une erreur 403. Côté bonus : les commentaires des
> lecteurs passent en modération, la recherche classe les articles par pertinence, et les abonnés
> reçoivent un e-mail à chaque publication, filtré selon leurs tags.

## 9. Passer à l'échelle

Déjà en place : sans état, à la demande, cache HTTP, médias sur CDN, asynchrone. Recommandations :
CloudFront devant l'API, Provisioned Concurrency, OpenSearch, digest e-mail, Global Tables + WAF.

> **À dire** : L'architecture passe déjà à l'échelle seule : aucun état en mémoire, une base à la
> demande, des médias sur CDN et des traitements asynchrones. Pour une très forte charge, je
> recommande d'abord un cache CloudFront devant l'API, puis la concurrence provisionnée contre les
> démarrages à froid, OpenSearch pour la recherche, et le multi-région pour une audience mondiale.

## 10. Conclusion et démonstration

**7 / 7** exigences · **24 / 24** étapes du test sur AWS · **503** tests unitaires.

> **À dire** : Pour conclure : les sept fonctionnalités du sujet sont couvertes, le projet est testé
> et réellement déployé sur AWS, où le scénario complet passe, pour un coût quasi nul. Je vous
> propose maintenant une démonstration en direct. Chaque appui sur Entrée envoie une vraie requête à
> l'API déployée.

---

## Script de la démonstration (≈ 4 min)

Commande : `npm run demo -- --stack blogify-dev --region eu-west-3`. Une phrase par moment clé :

| Étape | À dire |
|---|---|
| 2-3 · Inscription, connexion | « Je crée un compte : il reçoit automatiquement le rôle le plus faible, auteur invité, et Cognito me renvoie un jeton. » |
| 5 · `401` | « Sans jeton, la requête est refusée à l'entrée, avant même d'appeler une fonction. » |
| 6-7 · Brouillon, `404` | « L'article est créé en brouillon ; pour un visiteur, il n'existe pas. » |
| 8 · Image | « Le fichier part directement dans S3 ; une fonction vérifie son contenu, puis il est servi par CloudFront. » |
| 9-10 · `412`, `403` | « Une modification concurrente est refusée, et un auteur invité ne peut pas publier. » |
| 11-12 · Publication | « Il soumet, l'éditeur relit et publie. » |
| 14 · Recherche | « L'article est déjà indexé : l'index est mis à jour en arrière-plan. » |
| 15 · Commentaire | « Un lecteur commente, l'éditeur approuve, le commentaire devient public. » |
