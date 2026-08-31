# DevisAI (Maroc)

Generateur de devis gratuit pour artisans marocains, avec option IA.

## Demarrage

1. Installer les dependances:
   - `npm install`
2. Lancer le serveur:
   - `npm run dev`
3. Ouvrir: `http://localhost:3000`

## IA (optionnel)

Definir la variable d'environnement `OPENAI_API_KEY`.
Si elle n'est pas presente, l'app genere un devis de base.

## Atlasia / Darija STT

Le panneau `Test Atlas / Darija` peut transcrire l'audio avec Atlasia MoulSot:

### Mode GCP

Si un service Darija/Qwen existe deja dans GCP, configure:

- `DARIJA_DOCS_API_URL=https://<service-darija>`
- `QWEN_API_URL=https://<service-qwen>/predict`

### Mode local Python

1. Installer les dependances Python:
   - `python3 -m pip install -r requirements-atlasia.txt`
2. Lancer le serveur:
   - `npm run dev`
3. Dans l'interface, choisir `Atlasia MoulSot Darija`, parler, puis cliquer `Stop`.

Par defaut, le modele charge est `atlasia/moulsot.v0.3`. Tu peux le changer avec:

- `ATLASIA_MODEL=<modele> npm run dev`
- `ATLASIA_PYTHON=<python> npm run dev`

Note: `mlx-audio` est surtout adapte aux Mac Apple Silicon. Sur un Mac Intel (`x86_64`),
utilise plutot un serveur distant compatible GPU/CUDA ou une API d'inference, puis pointe
`ATLASIA_PYTHON` vers le runtime qui expose le modele.

