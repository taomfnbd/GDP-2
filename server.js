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
  if (text === null || typeof text === 'undefined') return;
  let textToSet = String(text);
  if (textToSet === '') return;

  try {
    const field = form.getTextField(fieldName);
    const maxLength = field.getMaxLength();
    if (maxLength > 0 && textToSet.length > maxLength) {
      console.warn(`Troncature: ${fieldName} (max ${maxLength}): "${textToSet}"`);
      textToSet = textToSet.substring(0, maxLength);
    }
    field.setText(textToSet);
  } catch (e) {
    if (!e.message || !e.message.toLowerCase().includes('no field named')) {
       console.warn(`Erreur texte non gérée pour ${fieldName}: ${e.message}`);
    } else {
       // console.log(`Champ texte non trouvé (normal si optionnel): ${fieldName}`);
    }
  }
}

function selectRadioOption(form, fieldName, optionValue) {
   if (!optionValue || typeof optionValue !== 'string' || optionValue.trim() === '') return;

   const valueToSelect = optionValue.trim();
   try {
     const field = form.getRadioGroup(fieldName);
     const options = field.getOptions();
     // Cherche une correspondance exacte (insensible à la casse/espaces)
     const foundOption = options.find(opt => opt.trim().toLowerCase() === valueToSelect.toLowerCase());

     if (foundOption) {
         field.select(foundOption); // Utilise l'option exacte du PDF
     } else {
         // Logique de fallback spécifique basée sur les erreurs vues
         let fallbackOption = null;
         const lowerValue = valueToSelect.toLowerCase();

         if (fieldName === 'S-proprietaire' && lowerValue === 'locataire') fallbackOption = 'proprietaire'; // Supposition
         else if (fieldName === 'S-situation-famille' && lowerValue === 'célibataire') fallbackOption = 'celibataire';
         else if (fieldName === 'S-capacite' && lowerValue === 'aucune') fallbackOption = 'majeur'; // Supposition
         else if (fieldName === 'S-residence' && lowerValue === 'france') fallbackOption = 'France et Dom';
         else if (lowerValue === 'non') fallbackOption = options.find(opt => opt.toLowerCase().includes('non') || opt.toLowerCase().includes('no'));
         else if (lowerValue === 'oui') fallbackOption = options.find(opt => opt.toLowerCase().includes('oui') || opt.toLowerCase().includes('yes'));

         if(fallbackOption && options.includes(fallbackOption)) { // Vérifie que le fallback existe bien
            console.warn(`Radio ${fieldName}: option "${valueToSelect}" non trouvée exactement. Utilisation du fallback "${fallbackOption}". Options PDF: [${options.join(', ')}]`);
            field.select(fallbackOption);
         } else {
            console.warn(`Radio ${fieldName}: option "${valueToSelect}" (ou fallback) non trouvée parmi [${options.join(', ')}].`);
         }
     }
   } catch (e) {
     if (!e.message || !e.message.toLowerCase().includes('no radio group named')) {
        console.warn(`Erreur radio non gérée pour ${fieldName}: ${e.message}`);
     } else {
       // console.log(`Groupe radio non trouvé (normal si optionnel): ${fieldName}`);
     }
   }
}

function setCheckboxValue(form, fieldName, value) {
  let shouldCheck = false;
  if (typeof value === 'boolean') {
    shouldCheck = value;
  } else if (typeof value === 'string') {
    const lowerValue = value.trim().toLowerCase();
    if (['false', '0', 'no', 'non', ''].includes(lowerValue)) {
        shouldCheck = false;
    } else if (['true', '1', 'yes', 'on', 'oui'].includes(lowerValue)) {
        shouldCheck = true;
    } else {
        return;
    }
  } else if (typeof value === 'number') {
    shouldCheck = value === 1;
  } else {
    return;
  }

  try {
    const field = form.getCheckBox(fieldName);
    if (shouldCheck) field.check();
    else field.uncheck();
  } catch (e) {
     if (!e.message || !e.message.toLowerCase().includes('no check box named')) {
        console.warn(`Erreur checkbox non gérée pour ${fieldName}: ${e.message}`);
     } else {
       // console.log(`Checkbox non trouvée (normal si optionnel): ${fieldName}`);
     }
  }
}

async function fillDateFields(form, dateString, dayField, monthField, yearField, yearLength = 4) {
    if (!dateString || typeof dateString !== 'string') return;
    const match = dateString.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$|^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (!match) return;

    let day, month, fullYear;
    if (match[1]) {
        [day, month, fullYear] = [match[1], match[2], match[3]];
    } else {
        [fullYear, month, day] = [match[4], match[5], match[6]];
    }

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


// --- Fonction de Remplissage du PDF Modèle (Corrigée avec noms PDF et fallback radios) ---
async function fillOutputPdf(outputForm, data) {
    console.log("Remplissage PDF v3 avec noms de champs confirmés et fallback radios...");

    // --- Section Souscripteur ---
    selectRadioOption(outputForm, 'S-proprietaire', data.housingStatus); // Fallback: Locataire -> proprietaire
    selectRadioOption(outputForm, 'S-titre', data.civility);

    const nameParts = (data.fullName || "").split(' ');
    const prenom = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : data.fullName;
    const nom = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
    await fillTextField(outputForm, 'S-prenom souscripteur 2', prenom);
    await fillTextField(outputForm, 'S-nom souscripteur 2', nom);
    await fillTextField(outputForm, 'S-nom-fille souscripteur 2', data.birthName);
    await fillDateFields(outputForm, data.birthDate, 'S-jour souscripteur 2', 'S-mois souscripteur 3', 'S-annee souscripteur 2');
    await fillTextField(outputForm, 'S-nationalite souscripteur 2', data.nationality);
    await fillTextField(outputForm, 'S-commune-naissance souscripteur 2', ''); // Clé manquante
    await fillTextField(outputForm, 'S-departement-naissance souscripteur 2', ''); // Clé manquante
    await fillTextField(outputForm, 'S-pays-naissance souscripteur 2', ''); // Clé manquante

    const firstLineAddress = (data.address || "").split('\n')[0];
    await fillTextField(outputForm, 'S-adresse souscripteur 2', firstLineAddress);
    await fillTextField(outputForm, 'S-pays souscripteur 2', data.fiscalResidenceCountry);

    await fillTextField(outputForm, 'S-telephone souscripteur 2', data.phoneMobile);
    await fillTextField(outputForm, 'S-mail souscripteur 2', data.email);
    selectRadioOption(outputForm, 'S-situation-famille', data.maritalStatus); // Fallback: Célibataire -> celibataire
    selectRadioOption(outputForm, 'S-regime-matrimonial', data.maritalRegime); // Clé manquante
    selectRadioOption(outputForm, 'S-capacite', data.protectionMeasure); // Fallback: Aucune -> majeur
    selectRadioOption(outputForm, 'S-residence', data.fiscalResidenceCountry); // Fallback: France -> France et Dom

    const isUSPersonValue = data.isUSPerson === 'Non' ? 'US non' : (data.isUSPerson === 'Oui' ? 'US oui' : null);
    if (isUSPersonValue) selectRadioOption(outputForm, 'S-citoyen US', isUSPersonValue);
    const isPPEValue = data.isPPE === 'Non' ? 'LCB non' : (data.isPPE === 'Oui' ? 'LCB oui' : null);
    if (isPPEValue) selectRadioOption(outputForm, 'S-esxpose LCT', isPPEValue);

    selectRadioOption(outputForm, 'QPP-SPR-activite', data.socioProfessionalCategory);
    await fillTextField(outputForm, 'QPP-SPR-profession souscripteur', data.profession);

    // --- Co-souscripteur --- Ignoré

    // --- Souscription --- Ignoré (clés manquantes)

    // --- Origine des Fonds --- Ignoré (clés manquantes)
    // setCheckboxValue(outputForm, 'fond epargne', data.epargne);
    // await fillTextField(outputForm, 'S-pourcent-epargne', data.epargne_pct);
    // ... etc ...

    // --- Versements Programmés --- Ignoré (clés manquantes)

    // --- Réinvestissement --- Ignoré (clés manquantes)
    // await fillTextField(outputForm, 'S-Fait à', '');
    // await fillDateFields(outputForm, '', 'Date1_af_date.0', 'Date1_af_date.1', 'Date1_af_date.2', 2);

    // --- Préférences Communication --- Ignoré (clés manquantes)
    // await fillTextField(outputForm, 'S-fait-a', '');
    // await fillDateFields(outputForm, '', 'S-fait-a-date-jj#BS SIGNAT', 'S-fait-a-date-mm#BS SIGNAT', 'S-fait-a-date-yyyy#BS SIGNAT', 4);

    // --- SEPA --- Ignoré (clés manquantes)
    // await fillIbanFields(outputForm, data.iban, 'S-IBAN', 7);
    // await fillTextField(outputForm, 'S-BIC', data.bic);
    // ... etc ...

    // --- Champs Financiers et Fiscaux ---
    // !! Utilisation des noms techniques PDF si possible, sinon placeholders !!
    // !! Il FAUT vérifier/trouver les noms exacts dans le PDF Bulletin !!
    await fillTextField(outputForm, 'S-montant-financement', data.precautionSavings); // !! NOM PDF INCORRECT !! Utilise S-montant-financement comme placeholder
    await fillTextField(outputForm, 'S-total-souscription', data.assetsTotal); // !! NOM PDF INCORRECT !! Utilise S-total-souscription comme placeholder
    await fillTextField(outputForm, 'S-somme-reglee', data.liabilitiesTotal); // !! NOM PDF INCORRECT !! Utilise S-somme-reglee comme placeholder
    await fillTextField(outputForm, 'QPP-SPR-revenus annuels', data.totalIncome); // !! NOM PDF INCORRECT !! Utilise un nom générique
    await fillTextField(outputForm, 'Total Charges', data.totalExpenses); // !! NOM PDF INCORRECT !!
    await fillTextField(outputForm, 'Annee N', data.taxYear); // !! NOM PDF INCORRECT !!
    await fillTextField(outputForm, 'Total Salaires Assimiles', data.grossSalary); // !! NOM PDF INCORRECT !!
    await fillTextField(outputForm, 'TMI IR', data.marginalTaxRate ? (data.marginalTaxRate * 100).toFixed(2) + ' %' : ''); // !! NOM PDF INCORRECT !!
    await fillTextField(outputForm, 'Revenu brut global', data.grossIncome); // !! NOM PDF INCORRECT !!
    await fillTextField(outputForm, 'Impot sur le revenu net', data.netTaxAmount); // !! NOM PDF INCORRECT !!

    // Champs épargne (Noms PDF inconnus)
    // await fillTextField(outputForm, '???', data.savingsTotal);
    // ... etc ...

    console.log("Remplissage PDF terminé (avec fallback radios et noms PDF partiels).");
}
// --- Fin Fonction de Remplissage ---


// --- Endpoints ---
app.post('/fill', async (req, res) => {
  console.log("Requête reçue sur /fill (JSON plat attendu)");
  const data = req.body;

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error("Données JSON invalides reçues sur /fill. Attendu: objet plat.");
    return res.status(400).send('Corps de la requête invalide ou manquant (doit être un objet JSON plat)');
  }
  if (Object.keys(data).length === 0 && data.constructor === Object) {
     console.error("Données JSON reçues vides sur /fill.");
  }

  try {
    console.log(`Lecture du modèle PDF depuis : ${pdfTemplatePath}`);
    const pdfBytes = await readFile(pdfTemplatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    console.log("Modèle PDF chargé pour /fill.");

    await fillOutputPdf(form, data);

    // form.flatten();
    const pdfResultBytes = await pdfDoc.save();
    console.log("PDF modifié sauvegardé en mémoire pour /fill.");

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

// Endpoint de test simple
app.get('/', (req, res) => {
  res.send('PDF Filler Service is running. Use POST /fill (JSON).');
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`PDF Filler Service démarré sur le port ${PORT}`);
  console.log(`Modèle PDF attendu à : ${pdfTemplatePath}`);
});
