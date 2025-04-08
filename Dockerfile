# Utiliser une image Node.js officielle (version LTS recommandée)
FROM node:18-alpine

# Définir le répertoire de travail dans le conteneur
WORKDIR /usr/src/app

# Copier les fichiers package.json et package-lock.json (si existant)
COPY package*.json ./

# Installer les dépendances de l'application
RUN npm install --omit=dev

# Copier le reste du code de l'application
COPY . .

# Copier le modèle PDF dans l'image (IMPORTANT)
# Assurez-vous que 'Bulletin_template.pdf' est dans le même dossier que le Dockerfile lors du build
COPY Bulletin_template.pdf ./

# Exposer le port sur lequel l'application écoute
EXPOSE 3000

# Commande pour démarrer l'application
CMD [ "node", "server.js" ]
