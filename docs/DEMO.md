# Préparer la soutenance : présentation et démonstration

## 1. Calendrier conseillé

| Quand | Quoi |
|---|---|
| Avant tout | Compte personnel : créer le budget « zéro dépense » (`docs/DEPLOYMENT.md` §10.3) |
| J-5 à J-3 | Déployer la stack (`npm run deploy:guided`), créer l'administrateur, lancer `npm run smoke` (tout doit être vert) |
| J-3 | Répéter la démo avec `npm run demo` ; télécharger le diaporama en PowerPoint |
| J-2 | **Plan B** : enregistrer une vidéo de la démo (2-3 min) et faire des captures (sorties de la stack, Swagger UI, smoke test) |
| J-1 | Vérifier que la stack répond (`curl <ApiUrl>/health`) ; sur AWS Academy, démarrer le lab à l'avance (les identifiants expirent à la fin de la session) |
| Jour J | Lab démarré, terminal ouvert dans le projet, onglet Swagger UI prêt (`<ApiUrl>/docs`), vidéo de secours sur le bureau |
| Juste après la soutenance | Supprimer la stack (`docs/DEPLOYMENT.md` §11) pour rester à 0 € ; la garder seulement si le jury demande à tester |

## 2. Déroulé proposé (≈ 20 min)

| Durée | Partie | Diapositives |
|---|---|---|
| 2 min | Contexte, objectifs, périmètre | 1 à 3 |
| 4 min | Architecture et choix de conception | 4 à 6 |
| 2 min | Modélisation des données | 7 à 8 |
| 3 min | Sécurité | 9 à 11 |
| 3 min | Conception de l'API | 12 à 14 |
| 2 min | Fonctionnalités, résilience, qualité | 15 à 18 |
| 2 min | Évolutivité et performances | 19 |
| 5 min | **Démonstration**, puis conclusion | 20 |

Les notes d'orateur de chaque diapositive contiennent le texte à dire.

## 3. La démonstration

### Option recommandée : le script guidé

```bash
npm run demo -- --stack blogify-dev --region <votre-région>
```

Chaque étape affiche une phrase d'explication, attend **Entrée**, envoie la vraie requête et affiche
la réponse (jetons raccourcis). Les comptes de démo sont créés puis supprimés automatiquement
(`--keep` pour les conserver, `--auto` pour enchaîner sans pause, `--subscribe-email vous@exemple.fr`
pour montrer aussi l'abonnement SNS).

| Étape | Ce que vous montrez | À dire |
|---|---|---|
| Santé, inscription, connexion | `201`, puis jetons JWT | « Cognito gère les comptes ; un nouvel inscrit est auteur invité » |
| `GET /me` | rôle et permissions | « Le rôle vient du jeton, les permissions d'une matrice centralisée » |
| `POST /posts` sans jeton | `401` | « Refusé par l'authorizer avant toute logique métier » |
| Création du brouillon | `201` + `Location` + `ETag` | « Slug, extrait et temps de lecture calculés ; article stocké dans DynamoDB » |
| Brouillon en anonyme | `404` | « Un brouillon n'est même pas révélé » |
| Upload d'image | POST présigné → `204` → `ready` | « Le fichier ne passe jamais par l'API ; une Lambda vérifie son contenu réel » |
| `PATCH` avec `If-Match` | `200`, puis `412` | « Verrouillage optimiste : pas d'écrasement silencieux » |
| Publication par l'auteur | `403` | « Un auteur invité ne peut pas publier » |
| Soumission, puis publication par l'éditeur | `in_review` → `published` | « Workflow éditorial complet » |
| Lecture publique, recherche, tags | listes, résultats | « Index mis à jour en asynchrone par DynamoDB Streams » |
| Commentaire et modération | `pending` → `approved` | « Les lecteurs sont modérés, l'e-mail n'est jamais public » |
| Suppression | `204` | « Le Projector nettoie commentaires et index en arrière-plan » |

### Option visuelle : Swagger UI

Ouvrir `<ApiUrl>/docs`, se connecter avec `POST /auth/login`, cliquer sur **Authorize**, coller
l'`idToken`, puis essayer `POST /posts` et `GET /posts`. Idéal pour montrer la documentation de
l'API (30 % de la note) en même temps que le fonctionnement.

### Plan B (réseau ou lab indisponible)

1. Vidéo de la démo enregistrée à J-2.
2. En local, sans AWS : `npm test` (503 tests) puis `npm run ddb:start && npm run test:integration`
   (scénario complet sur DynamoDB Local avec rejeu des Streams).

## 4. Obtenir le PowerPoint

Le diaporama est un artefact Claude : ouvrez-le, puis utilisez **Partager › Exporter** (ou le bouton
de téléchargement) et choisissez **PowerPoint (.pptx)** ou **PDF**. Ajoutez votre nom sur la
couverture et, si vous le souhaitez, une capture de Swagger UI ou du smoke test sur la diapositive 18.

## 5. Questions probables du jury

| Question | Réponse courte |
|---|---|
| Pourquoi une seule table DynamoDB ? | Chaque motif d'accès est servi par une seule requête (`GetItem`/`Query`), sans jointure ni `Scan` ; latence constante quelle que soit la volumétrie |
| Pourquoi un authorizer Lambda plutôt que l'authorizer Cognito natif ? | Il accepte `Bearer <jeton>`, normalise les rôles transmis aux fonctions et partage le code de vérification avec les routes à authentification optionnelle ; résultat mis en cache 5 min |
| Comment sont gérés les rôles ? | Groupes Cognito → claim `cognito:groups` → matrice de permissions, plus contrôle de propriété ; les opérations d'administration revérifient l'état du compte dans Cognito |
| Que se passe-t-il si deux personnes modifient le même article ? | Verrouillage optimiste : la version est dans l'`ETag`, une version périmée renvoie `412` |
| Pourquoi des URL présignées pour les médias ? | Le fichier va directement dans S3 : pas de limite de 6-10 Mo de Lambda/API Gateway, pas de coût de calcul ; taille et type sont imposés par S3 |
| Comment empêcher l'upload d'un fichier malveillant ? | Liste blanche de types, taille maximale, vérification des premiers octets (magic bytes), SVG refusé, CloudFront ne sert que les fichiers validés |
| Comment fonctionne la recherche ? | Index inversé dans DynamoDB maintenu par DynamoDB Streams, termes pondérés (titre ×10, tags ×6…) ; à grande échelle, migration vers OpenSearch |
| Que se passe-t-il si une Lambda asynchrone échoue ? | Nouvelles tentatives, découpage du lot, échecs partiels, puis file SQS (DLQ) ; tous les traitements sont idempotents |
| Combien ça coûte ? | Paiement à l'usage : quasi 0 € pour une démo, quelques dizaines d'euros par mois pour 1 M de lectures (voir `SCALABILITY.md`) |
| Quelle est la première chose à faire pour passer à l'échelle ? | Un cache CloudFront devant l'API, puis Provisioned Concurrency sur la lecture, WAF et OpenSearch |
| Comment avez-vous testé ? | 503 tests unitaires, un scénario d'intégration sur DynamoDB Local, un smoke test sur l'infrastructure réelle et une CI GitHub Actions |
