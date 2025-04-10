import express from 'express';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url'; // Pour obtenir le chemin du répertoire actuel avec ES Modules

// Configuration
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pdfTemplatePath = path.join(__dirname, 'Bulletin_template.pdf'); // Modèle à remplir

const app = express();
// Middleware pour parser le JSON (pour la route /fill originale)
app.use(express.json({ limit: '10mb' }));

// --- Fonctions Helper (Robustifiées) ---
async function fillTextField(form, fieldName, text) {
  if (text === null || typeof text === 'undefined') return; // Permet 0 mais pas null/undefined
  let textToSet = String(text); // Convertit explicitement en chaîne (gère nombres)
  if (textToSet === '') return; // Ne remplit pas si chaîne vide

  try {
    const field = form.getTextField(fieldName);
    const maxLength = field.getMaxLength();
    if (maxLength > 0 && textToSet.length > maxLength) {
      console.warn(`Troncature: ${fieldName} (max ${maxLength}): "${textToSet}"`);
      textToSet = textToSet.substring(0, maxLength);
    }
    field.setText(textToSet);
  } catch (e) {
    // Ignore l'erreur si le champ n'existe pas, log les autres erreurs
    if (!e.message || !e.message.toLowerCase().includes('no field named')) {
       console.warn(`Erreur texte non gérée pour ${fieldName}: ${e.message}`);
    }
  }
}

function selectRadioOption(form, fieldName, optionValue) {
   if (!optionValue || typeof optionValue !== 'string' || optionValue.trim() === '') return; // Ignore si vide ou pas string

   const valueToSelect = optionValue.trim();
   try {
     const field = form.getRadioGroup(fieldName);
     const options = field.getOptions();
     // Cherche une correspondance exacte (insensible à la casse/espaces)
     const foundOption = options.find(opt => opt.trim().toLowerCase() === valueToSelect.toLowerCase());

     if (foundOption) {
         field.select(foundOption); // Utilise l'option exacte du PDF
     } else {
         // Si pas de match exact, tente la valeur brute (peut échouer si format PDF strict)
         console.warn(`Radio ${fieldName}: option "${valueToSelect}" non trouvée exactement parmi [${options.join(', ')}]. Tentative avec la valeur brute.`);
         try {
            field.select(valueToSelect);
         } catch (selectError) {
            console.warn(` -> Échec de la sélection brute pour ${fieldName}: ${selectError.message}`);
         }
     }
   } catch (e) {
     if (!e.message || !e.message.toLowerCase().includes('no radio group named')) {
        console.warn(`Erreur radio non gérée pour ${fieldName}: ${e.message}`);
     }
   }
}

function setCheckboxValue(form, fieldName, value) {
  // Gère explicitement les valeurs communes pour "coché" (Oui, Non, true, false, 1, 0)
  let shouldCheck = false;
  if (typeof value === 'boolean') {
    shouldCheck = value;
  } else if (typeof value === 'string') {
    const lowerValue = value.trim().toLowerCase();
    shouldCheck = ['true', '1', 'yes', 'on', 'oui'].includes(lowerValue);
  } else if (typeof value === 'number') {
    shouldCheck = value === 1;
  } else {
    // Si la valeur n'est pas reconnue comme booléen/string/nombre, on ne fait rien
    return;
  }

  try {
    const field = form.getCheckBox(fieldName);
    if (shouldCheck) field.check();
    else field.uncheck();
  } catch (e) {
     if (!e.message || !e.message.toLowerCase().includes('no check box named')) {
        console.warn(`Erreur checkbox non gérée pour ${fieldName}: ${e.message}`);
     }
  }
}

async function fillDateFields(form, dateString, dayField, monthField, yearField, yearLength = 4) {
    if (!dateString || typeof dateString !== 'string' || !dateString.match(/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/)) {
        return; // Ne fait rien si format invalide ou vide
    }
    const separator = dateString.includes('/') ? '/' : '-';
    const parts = dateString.split(separator);
    if (parts.length !== 3) return;
    let [day, month, fullYear] = parts;
    day = day.padStart(2, '0');
    month = month.padStart(2, '0');
    const year = yearLength === 2 ? fullYear.slice(-2) : fullYear.padStart(4, '20');

    await fillTextField(form, dayField, day);
    await fillTextField(form, monthField, month);
    await fillTextField(form, yearField, year);
}

async function fillIbanFields(form, ibanString, baseFieldName, numFields) {
    if (!ibanString) return;
    const cleanedIban = String(ibanString).replace(/\s/g, '').toUpperCase();
    const segmentLength = 4;
    for (let i = 0; i < numFields; i++) {
        const fieldName = `${baseFieldName}-${i + 1}`;
        const start = i * segmentLength;
        const end = start + segmentLength;
        const segment = cleanedIban.substring(start, end);
        await fillTextField(form, fieldName, segment);
    }
}
// --- Fin Fonctions Helper ---


// --- Fonction de Remplissage du PDF Modèle (Révisée pour JSON plat et données IA) ---
async function fillOutputPdf(outputForm, data) {
    console.log("Début du remplissage du PDF modèle avec JSON plat de l'IA...");

    // Utilise directement les clés du JSON plat 'data'
    // Les clés ici doivent correspondre EXACTEMENT aux clés du JSON produit par l'IA

    // --- Section Souscripteur ---
    // !! Vérifier la correspondance sémantique et les noms exacts des champs PDF !!
    selectRadioOption(outputForm, 'S-proprietaire', data.housingStatus); // Ex: "Locataire"
    selectRadioOption(outputForm, 'S-titre', data.civility); // Souvent vide
    // Tentative de séparation Nom/Prénom (très spéculatif)
    const nameParts = (data.fullName || "").split(' ');
    const prenom = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : data.fullName; // Tout sauf le dernier mot
    const nom = nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''; // Dernier mot
    await fillTextField(outputForm, 'S-prenom souscripteur 2', prenom); // Souvent vide
    await fillTextField(outputForm, 'S-nom souscripteur 2', nom); // Souvent vide
    await fillTextField(outputForm, 'S-nom-fille souscripteur 2', data.birthName); // Souvent vide
    await fillDateFields(outputForm, data.birthDate, 'S-jour souscripteur 2', 'S-mois souscripteur 3', 'S-annee souscripteur 2'); // Souvent vide
    await fillTextField(outputForm, 'S-nationalite souscripteur 2', data.nationality); // Souvent vide

    // Adresse: Prend la première ligne si data.address est une chaîne multi-lignes
    const firstLineAddress = (data.address || "").split('\n')[0];
    await fillTextField(outputForm, 'S-adresse souscripteur 2', firstLineAddress); // Souvent vide
    await fillTextField(outputForm, 'S-pays souscripteur 2', data.fiscalResidenceCountry); // Ex: "France"

    await fillTextField(outputForm, 'S-telephone souscripteur 2', data.phoneMobile); // Ex: "+33"
    await fillTextField(outputForm, 'S-mail souscripteur 2', data.email); // Souvent vide
    selectRadioOption(outputForm, 'S-situation-famille', data.maritalStatus); // Ex: "Célibataire"
    selectRadioOption(outputForm, 'S-capacite', data.protectionMeasure); // Ex: "Aucune"
    selectRadioOption(outputForm, 'S-residence', data.fiscalResidenceCountry); // Ex: "France"

    // Conversion Oui/Non pour US Person et PPE
    const isUSPersonValue = data.isUSPerson === 'Non' ? 'US non' : (data.isUSPerson === 'Oui' ? 'US oui' : '');
    selectRadioOption(outputForm, 'S-citoyen US', isUSPersonValue); // Ex: "US non"
    const isPPEValue = data.isPPE === 'Non' ? 'LCB non' : (data.isPPE === 'Oui' ? 'LCB oui' : '');
    selectRadioOption(outputForm, 'S-esxpose LCT', isPPEValue); // Ex: "LCB non"

    selectRadioOption(outputForm, 'QPP-SPR-activite', data.socioProfessionalCategory); // Souvent vide
    await fillTextField(outputForm, 'QPP-SPR-profession souscripteur', data.profession); // Souvent vide

    // --- Co-souscripteur ---
    // Ignoré pour l'instant car non géré par le JSON plat

    // --- Souscription ---
    // Les clés spécifiques à la souscription (nombre_parts, montant_total, etc.)
    // n'étaient pas dans le JSON IA, donc ces champs resteront vides.
    // await fillTextField(outputForm, 'S-nb-part', data.nombre_parts);
    // await fillTextField(outputForm, 'S-total-souscription', data.montant_total);
    // await fillTextField(outputForm, 'S-somme-reglee', data.reglement_montant);

    // --- Origine des Fonds ---
    // Clés manquantes dans le JSON IA

    // --- Versements Programmés ---
    // Clés manquantes dans le JSON IA

    // --- Réinvestissement ---
    // Clés manquantes dans le JSON IA
    // Note: Les champs signature page 7 sont liés à cette section dans le code original
    // await fillTextField(outputForm, 'S-Fait à', data.reinvestissement_signature_lieu); // Clé manquante
    // await fillDateFields(outputForm, data.reinvestissement_signature_date, 'Date1_af_date.0', 'Date1_af_date.1', 'Date1_af_date.2', 2); // Clé manquante

    // --- Préférences Communication ---
    // Clés manquantes dans le JSON IA
    // Note: Les champs signature page 8 sont liés à cette section
    // await fillTextField(outputForm, 'S-fait-a', data.pref_signature_lieu); // Clé manquante
    // await fillDateFields(outputForm, data.pref_signature_date, 'S-fait-a-date-jj#BS SIGNAT', 'S-fait-a-date-mm#BS SIGNAT', 'S-fait-a-date-yyyy#BS SIGNAT', 4); // Clé manquante

    // --- SEPA ---
    // Clés manquantes dans le JSON IA

    // --- Champs Financiers et Fiscaux (Utilisation des clés présentes) ---
    // !! Trouver les noms exacts des champs PDF correspondants !!
    // Les noms ci-dessous sont des exemples basés sur les libellés
    await fillTextField(outputForm, 'Epargne Precaution Souhaitee', data.precautionSavings); // Ex: 10000
    await fillTextField(outputForm, 'Total Actifs Bruts', data.assetsTotal); // Ex: 4689
    await fillTextField(outputForm, 'Total Passifs', data.liabilitiesTotal); // Ex: 0
    await fillTextField(outputForm, 'Total Revenus', data.totalIncome); // Ex: 29640
    await fillTextField(outputForm, 'Total Charges', data.totalExpenses); // Ex: 0
    await fillTextField(outputForm, 'Annee IR', data.taxYear); // Ex: "2024"
    await fillTextField(outputForm, 'Total Salaires Assimiles', data.grossSalary); // Ex: 12196
    await fillTextField(outputForm, 'TMI IR', data.marginalTaxRate ? (data.marginalTaxRate * 100).toFixed(2) + ' %' : ''); // Ex: "11.00 %"
    await fillTextField(outputForm, 'Revenu Brut Global IR', data.grossIncome); // Ex: 10976
    await fillTextField(outputForm, 'Impot Revenu Net', data.netTaxAmount); // Ex: "0"

    // Champs liés à l'épargne (si les champs PDF existent)
    await fillTextField(outputForm, 'Epargne Total', data.savingsTotal);
    await fillTextField(outputForm, 'Epargne Court Terme', data.shortTermSavings);
    await fillTextField(outputForm, 'Epargne Livret A', data.livretA);
    await fillTextField(outputForm, 'Epargne Compte Courant', data.currentAccount);
    await fillTextField(outputForm, 'Epargne Long Terme', data.longTermSavings);
    await fillTextField(outputForm, 'Epargne Assurance Vie', data.lifeInsurance);

    console.log("Remplissage (potentiellement partiel) du PDF modèle terminé.");
}
// --- Fin Fonction de Remplissage ---


// --- Endpoints ---

// Endpoint principal (reçoit JSON plat de l'IA)
app.post('/fill', async (req, res) => {
  console.log("Requête reçue sur /fill (JSON plat attendu)");
  const data = req.body; // Le JSON plat envoyé par n8n (provenant de l'IA)

  // Validation simple de l'input
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error("Données JSON invalides reçues sur /fill. Attendu: objet plat.");
    return res.status(400).send('Corps de la requête invalide ou manquant (doit être un objet JSON plat)');
  }
  // Vérifie si l'objet est vide (aucune clé extraite)
  if (Object.keys(data).length === 0 && data.constructor === Object) {
     console.error("Données JSON reçues vides sur /fill.");
     // On pourrait renvoyer une erreur ou un PDF vide
     // Pour l'instant, on continue pour générer un PDF quasi-vide
  }


  try {
    // Lire le modèle PDF
    console.log(`Lecture du modèle PDF depuis : ${pdfTemplatePath}`);
    const pdfBytes = await readFile(pdfTemplatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    console.log("Modèle PDF chargé pour /fill.");

    // Remplir le PDF avec les données JSON plates reçues
    await fillOutputPdf(form, data);

    // Sauvegarder le PDF modifié en mémoire
    // form.flatten(); // Aplatir rend les champs non modifiables après coup
    const pdfResultBytes = await pdfDoc.save();
    console.log("PDF modifié sauvegardé en mémoire pour /fill.");

    // Envoyer le PDF rempli en réponse
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=bulletin-rempli-ia.pdf');
    res.send(Buffer.from(pdfResultBytes));
    console.log("PDF rempli (depuis JSON IA) envoyé en réponse.");

  } catch (error) {
    console.error("Erreur lors du traitement de la requête /fill:", error);
    if (error.code === 'ENOENT' && error.path === pdfTemplatePath) {
         console.error(`ERREUR CRITIQUE : Le fichier modèle PDF '${path.basename(pdfTemplatePath)}' est introuvable.`);
         return res.status(500).send(`Erreur serveur: Fichier modèle PDF manquant.`);
    }
    res.status(500).send(`Erreur serveur lors du remplissage du PDF (JSON IA): ${error.message}`);
  }
});

// Ancienne route /fill_from_pdf (supprimée car non utilisée dans ce flux)
/*
app.post('/fill_from_pdf', express.raw({ type: 'application/pdf', limit: '20mb' }), async (req, res) => {
    // ... code ...
});
*/

// Endpoint de test simple
app.get('/', (req, res) => {
  res.send('PDF Filler Service is running. Use POST /fill (JSON).');
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`PDF Filler Service démarré sur le port ${PORT}`);
  console.log(`Modèle PDF attendu à : ${pdfTemplatePath}`);
});
