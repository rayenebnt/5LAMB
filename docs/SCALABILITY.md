# Évolutivité et performances — recommandations

Ce document analyse comment Blogify se comporte quand le trafic augmente, identifie les points
de contention de la conception actuelle et propose, par ordre de priorité, les services et
configurations AWS à activer pour passer à l'échelle.

## 1. Ce qui passe déjà à l'échelle sans intervention

| Composant | Mécanisme d'élasticité | Limite par défaut (ajustable) |
|---|---|---|
| API Gateway (REST) | Service managé multi-AZ | 10 000 req/s par compte et par région (rafale 5 000) |
| AWS Lambda | Une instance par requête concurrente, création automatique | 1 000 exécutions concurrentes par compte (souvent moins sur un compte neuf) |
| DynamoDB à la demande | Capacité ajustée en continu, jusqu'au double du pic précédent instantanément ; *adaptive capacity* | 3 000 RCU / 1 000 WCU par partition physique |
| S3 | Débit par préfixe ; nos clés `media/<uuid>/…` répartissent la charge | 3 500 écritures / 5 500 lectures par seconde et par préfixe |
| CloudFront | Cache sur plus de 600 points de présence | — |
| SNS / EventBridge / SQS | Services managés à très haut débit | — |
| Cognito | Service managé | Quotas par catégorie d'API (ex. authentification), augmentables sur demande |

L'architecture est **sans état** (stateless) : aucune session en mémoire, toutes les données sont
dans DynamoDB/S3, l'identité est portée par le JWT. N'importe quelle instance Lambda peut servir
n'importe quelle requête, ce qui permet une montée en charge horizontale illimitée en théorie.

Optimisations **déjà en place** :

- **arm64 (Graviton2)** : ~20 % moins cher à la milliseconde, souvent plus rapide.
- **Bundles esbuild minifiés** par fonction : peu de code à charger → démarrages à froid réduits.
- **Clients SDK créés une seule fois** par environnement d'exécution et réutilisés (keep-alive TCP).
- **Authorizer mis en cache 5 min** par jeton : la vérification JWT n'est pas refaite à chaque appel ;
  les clés publiques JWKS sont aussi mises en cache en mémoire.
- **Projections `INCLUDE`** sur les index : les listes ne lisent jamais le corps des articles.
- **Pagination par curseur** (`LastEvaluatedKey`) : coût constant quelle que soit la page.
- **En-têtes `Cache-Control`** sur les lectures publiques (`public, max-age=60, stale-while-revalidate`)
  et **ETag** sur les articles : les navigateurs et CDN peuvent mettre en cache.
- **Compression gzip** des réponses de l'API au-delà de 1 Ko (`MinimumCompressionSize`).
- **Médias hors du chemin de l'API** : upload direct vers S3 par URL présignée, diffusion par CloudFront.
- **Traitements lourds asynchrones** (index, notifications, validation des fichiers) : la latence
  perçue par l'utilisateur ne dépend que d'une écriture DynamoDB.

## 2. Points de contention identifiés et remèdes

| Point de contention | Symptôme à forte charge | Remède recommandé |
|---|---|---|
| Partition `POSTS#published` du GSI1 (toutes les listes publiques) | Partition « chaude » au-delà de ~3 000 lectures/s de listes | 1) **Cache** devant l'API (CloudFront ou cache API Gateway) : une liste change rarement ; 2) *write sharding* temporel (`POSTS#published#2026-10`) ou par N fragments, avec lecture parallèle |
| Partition `TAGS` (compteurs de tags) | Mises à jour concurrentes si des milliers d'articles sont publiés par seconde | Compteurs fragmentés (`TAGS#0..9`) agrégés à la lecture, ou recalcul périodique |
| Index de recherche DynamoDB (`TERM#…`) | Termes très fréquents (« aws ») = grosses partitions, pas de recherche floue ni de facettes | Migrer vers **Amazon OpenSearch Service / Serverless** alimenté par l'intégration *zero-ETL* DynamoDB → OpenSearch (OpenSearch Ingestion) |
| Démarrages à froid Lambda | Latence p99 plus élevée lors des pics | **Provisioned Concurrency** sur `PostsQuery` et l'authorizer aux heures de pointe (avec Application Auto Scaling) ; réglage mémoire avec **AWS Lambda Power Tuning** |
| Concurrence Lambda du compte | `429` / *throttles* si la somme des fonctions dépasse le quota | Demander une augmentation de quota ; **concurrence réservée** pour isoler les fonctions critiques (lecture publique) des traitements asynchrones |
| Quotas Cognito (authentification) | Erreurs `TooManyRequests` sur `/auth/login` lors d'un pic | Augmentation de quota ; jetons à durée de vie adaptée ; le cache de l'authorizer évite d'appeler Cognito pour les requêtes authentifiées |
| Taille d'un élément DynamoDB (400 Ko) | Articles extrêmement longs | Stocker le corps dans S3 (référence dans l'élément) et ne garder que les métadonnées dans DynamoDB |
| Envoi d'e-mails à chaque publication | Coût et volume proportionnels à `articles × abonnés` | **Digest** quotidien (EventBridge Scheduler), Amazon SES avec modèles HTML, file SQS de lissage |

## 3. Recommandations par palier de trafic

> Ordres de grandeur indicatifs (tarifs publics us-east-1, hors offres gratuites).

| Palier | Profil | Configuration recommandée | Coût mensuel estimé |
|---|---|---|---|
| **Démarrage** | Blog personnel, < 100 000 requêtes/mois | Configuration actuelle | ≈ 0 $ (offres gratuites) |
| **Croissance** | Média en ligne, ~1 M lectures/mois, 10 000 abonnés | + CloudFront devant l'API (TTL 60 s sur les GET publics), alarmes CloudWatch, digest e-mail quotidien | API Gateway ≈ 7 $, Lambda ≈ 2 $, DynamoDB ≈ 2 $, CloudFront/S3 ≈ 5–10 $, e-mails ≈ 6 $ (digest) |
| **Forte charge** | Pics viraux à 1 000 req/s | + Provisioned Concurrency sur la lecture, AWS WAF (règles de débit, Bot Control), OpenSearch pour la recherche, quotas augmentés | Dominé par API Gateway (≈ 3,50 $/M requêtes) : avec 95 % de cache CDN, l'origine ne reçoit que 5 % du trafic (÷ 20 sur ce poste) |
| **International** | Lecteurs sur plusieurs continents, exigence de disponibilité | + DynamoDB **Global Tables**, réplication S3 inter-régions, déploiement multi-région de la stack, Route 53 (routage par latence + bascule) | Multiplié par le nombre de régions actives |

## 4. Leviers de performance détaillés

### 4.1 Mise en cache (gain le plus important)

1. **CloudFront devant API Gateway** (domaine personnalisé `api.blog.example.com`) : cache des `GET`
   publics selon les en-têtes `Cache-Control` déjà émis ; invalidation ciblée lors d'une publication
   (le `Notifier` peut appeler `CreateInvalidation`) ou simple TTL court (60 s).
2. **Cache d'étape API Gateway** (0,5 Go à partir de ≈ 0,02 $/h) : alternative intégrée, clé de cache
   sur les paramètres de requête (`limit`, `cursor`, `tag`, `q`).
3. **DynamoDB Accelerator (DAX)** : lectures en microsecondes pour les articles très consultés
   (nécessite de placer les fonctions dans un VPC — à réserver aux très gros volumes).

### 4.2 Calcul

- **Power Tuning** : mesurer le meilleur compromis mémoire/coût de chaque fonction (plus de mémoire
  = plus de CPU ; une fonction plus rapide peut coûter moins cher).
- **Provisioned Concurrency** planifiée sur les fonctions de lecture lors des pics prévisibles.
- Séparer encore plus finement les chemins chauds si nécessaire (ex. fonction dédiée à `GET /posts/{id}`).

### 4.3 Données

- **Write sharding** des partitions chaudes et **cache** des listes (voir §2).
- Activer **DynamoDB Contributor Insights** pour repérer les clés les plus sollicitées.
- **Export S3 / Athena** de la table (sans impact sur les performances) pour l'analytique
  (statistiques de lecture, tableaux de bord) au lieu de requêtes coûteuses sur la table.
- Ajouter un compteur de vues asynchrone (Kinesis Data Firehose ou SQS + agrégation par lots)
  pour ne pas écrire dans DynamoDB à chaque lecture.

### 4.4 Médias

- **Redimensionnement et conversion à la volée** (WebP/AVIF, vignettes) avec la solution
  *Serverless Image Handler* ou Lambda + CloudFront ; génération de vignettes à l'upload dans
  `MediaProcessor`.
- **Vidéos** : transcodage adaptatif HLS avec AWS Elemental MediaConvert, diffusion via CloudFront.
- **Uploads volumineux** : téléversement multipart S3 (URL présignées par partie) au-delà de 100 Mo.
- **S3 Intelligent-Tiering** pour réduire le coût de stockage des médias rarement consultés.

## 5. Évolutions fonctionnelles compatibles avec l'architecture

| Évolution | Services AWS | Intégration |
|---|---|---|
| Publication programmée | EventBridge Scheduler | Un planning ponctuel par article déclenche la transition `publish` |
| Workflow de relecture avancé | AWS Step Functions | Orchestration relecture → approbation (tâche humaine) → publication → notification |
| Notifications temps réel dans l'interface d'administration | API Gateway WebSocket ou AWS AppSync (abonnements GraphQL) | Branchement sur l'événement `PostPublished` d'EventBridge |
| Webhooks pour les intégrateurs (rebuild Next.js, Netlify, Slack…) | EventBridge API Destinations | Règle sur `source = blogify.posts` |
| Multi-tenant (un blog par entreprise) | Cognito (attribut `tenantId`), clés préfixées par tenant, IAM `dynamodb:LeadingKeys`, plans d'usage API Gateway | Isolation logique des données et quotas par client |
| Sécurité renforcée | AWS WAF, Cognito Threat Protection + MFA, AWS Shield | Activation sur API Gateway / CloudFront / user pool |
| Observabilité avancée | Powertools for AWS Lambda (métriques EMF), tableaux de bord et alarmes CloudWatch, X-Ray | Alarmes sur taux de 5XX, latence p99, profondeur de la DLQ, throttles |
| Déploiements sans risque | SAM `AutoPublishAlias` + `DeploymentPreference` (canary 10 %) + CodeDeploy | Retour arrière automatique sur alarme |
| CI/CD | GitHub Actions + OIDC (rôle IAM sans clé longue durée) | Pipeline existant (`.github/workflows/ci.yml`) étendu avec `sam deploy` |

## 6. Synthèse

1. **Court terme** (coût nul ou faible, gain immédiat) : CloudFront devant l'API, alarmes CloudWatch,
   digest des e-mails, Power Tuning.
2. **Moyen terme** (croissance) : Provisioned Concurrency planifiée, WAF, OpenSearch pour la recherche,
   redimensionnement des images, Step Functions pour le workflow éditorial.
3. **Long terme** (international / très forte charge) : write sharding des partitions chaudes,
   DynamoDB Global Tables et déploiement multi-région, multi-tenant.

Grâce au découplage par événements (Streams, EventBridge, SNS), chacune de ces évolutions peut être
ajoutée **sans modifier le cœur de l'API** : il suffit de brancher un nouveau consommateur.
