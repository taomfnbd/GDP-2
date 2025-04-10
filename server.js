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

// --- Fonctions Helper (Légèrement adaptées pour booléens) ---
async function fillTextField(form, fieldName, text) {
  // Ajout d'une vérification pour les nombres qui pourraient arriver
  if (text === null || typeof text === 'undefined' || text === '') return;
  let textToSet = String(text); // Convertit explicitement en chaîne
  try {
    const field = form.getTextField(fieldName);
    const maxLength = field.getMaxLength();
    if (maxLength > 0 && textToSet.length > maxLength) {
      console.warn(`Troncature: ${fieldName}`);
      textToSet = textToSet.substring(0, maxLength);
    }
    field.setText(textToSet);
  } catch (e) { if (!e.message.toLowerCase().includes('no field')) console.warn(`Erreur texte ${fieldName}: ${e.message}`); }
}

function selectRadioOption(form, fieldName, optionValue) {
   if (!optionValue || typeof optionValue !== 'string') return; // Vérifie que c'est une chaîne non vide
   try {
     const field = form.getRadioGroup(fieldName);
     // Essayer de faire correspondre même si la casse ou les espaces diffèrent légèrement
     const options = field.getOptions();
     let selectedOption = optionValue; // Garde la valeur originale par défaut
     const foundOption = options.find(opt => opt.trim().toLowerCase() === optionValue.trim().toLowerCase());
     if (foundOption) {
         selectedOption = foundOption; // Utilise l'option exacte du PDF
     } else {
         console.warn(`Radio ${fieldName}: option "${optionValue}" non trouvée parmi [${options.join(', ')}]. Tentative avec la valeur brute.`);
     }
     field.select(selectedOption);
   } catch (e) {
     try { // Log amélioré en cas d'erreur
        const options = form.getRadioGroup(fieldName)?.getOptions() || [];
        console.warn(`Radio ${fieldName}: option "${optionValue}" invalide ou champ non trouvé. Options PDF: [${options.join(', ')}]. Err: ${e.message}`);
     } catch (innerErr) { console.warn(`Radio ${fieldName} non trouvé/erreur: ${e.message}`); }
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
  }

  try {
    const field = form.getCheckBox(fieldName);
    if (shouldCheck) field.check();
    else field.uncheck();
  } catch (e) { if (!e.message.toLowerCase().includes('no field')) console.warn(`Checkbox ${fieldName} non trouvé/erreur: ${e.message}`); }
}

async function fillDateFields(form, dateString, dayField, monthField, yearField, yearLength = 4) {
    if (!dateString || typeof dateString !== 'string' || !dateString.match(/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/)) {
        // console.warn(`Format date invalide pour ${dayField}/${monthField}/${yearField}: ${dateString}`); // Moins de logs
        return;
    }
    const separator = dateString.includes('/') ? '/' : '-';
    const parts = dateString.split(separator);
    if (parts.length !== 3) return;
    let [day, month, fullYear] = parts;
    // Pad avec 0 si nécessaire (ex: 1 -> 01)
    day = day.padStart(2, '0');
    month = month.padStart(2, '0');
    const year = yearLength === 2 ? fullYear.slice(-2) : fullYear.padStart(4, '20'); // Assure 4 chiffres si besoin

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


// --- Fonction de Remplissage du PDF Modèle (Adaptée pour JSON plat) ---
async function fillOutputPdf(outputForm, data) {
    console.log("Début du remplissage du PDF modèle avec JSON plat...");

    // Utilise directement les clés du JSON plat 'data'
    // Note: Les clés ici doivent correspondre EXACTEMENT aux clés du JSON produit par l'IA

    // Section "Souscripteur" (mappée depuis les clés plates)
    selectRadioOption(outputForm, 'S-proprietaire', data.housingStatus); // housingStatus -> S-proprietaire ? A vérifier
    selectRadioOption(outputForm, 'S-titre', data.civility);
    await fillTextField(outputForm, 'S-prenom souscripteur 2', data.fullName); // fullName contient nom+prénom ? Séparation nécessaire ?
    await fillTextField(outputForm, 'S-nom-fille souscripteur 2', data.birthName);
    await fillTextField(outputForm, 'S-nom souscripteur 2', data.fullName); // Utilise fullName pour l'instant
    await fillDateFields(outputForm, data.birthDate, 'S-jour souscripteur 2', 'S-mois souscripteur 3', 'S-annee souscripteur 2');
    // await fillTextField(outputForm, 'S-commune-naissance souscripteur 2', data.lieu_naissance); // Clé manquante dans JSON IA
    // await fillTextField(outputForm, 'S-departement-naissance souscripteur 2', data.departement_naissance); // Clé manquante
    // await fillTextField(outputForm, 'S-pays-naissance souscripteur 2', data.pays_naissance); // Clé manquante
    await fillTextField(outputForm, 'S-nationalite souscripteur 2', data.nationality);
    // await fillTextField(outputForm, 'S-representant souscripteur 2', data.representant_pm); // Clé manquante
    // await fillTextField(outputForm, 'S-forme_juridique souscripteur 2', data.forme_juridique_pm); // Clé manquante
    // await fillTextField(outputForm, 'S-siret souscripteur 2', data.siret_pm); // Clé manquante
    // await fillTextField(outputForm, 'S-no-adresse souscripteur 2', data.adresse_no); // Clé manquante (adresse est une chaîne unique)
    await fillTextField(outputForm, 'S-adresse souscripteur 2', data.address); // Adresse est une chaîne unique, peut nécessiter parsing
    // await fillTextField(outputForm, 'S-code-postal souscripteur 2', data.adresse_cp); // Clé manquante
    // await fillTextField(outputForm, 'S-ville souscripteur 2', data.adresse_ville); // Clé manquante
    await fillTextField(outputForm, 'S-pays souscripteur 2', data.fiscalResidenceCountry); // Utilise fiscalResidenceCountry ?
    // La logique adresse fiscale identique n'est pas directement dans le JSON plat
    await fillTextField(outputForm, 'S-telephone souscripteur 2', data.phoneMobile); // Utilise phoneMobile pour l'instant
    await fillTextField(outputForm, 'S-mail souscripteur 2', data.email);
    selectRadioOption(outputForm, 'S-situation-famille', data.maritalStatus);
    // selectRadioOption(outputForm, 'S-regime-matrimonial', data.maritalRegime); // Clé manquante
    // selectRadioOption(outputForm, 'S-associe', data.deja_associe ? 'oui' : 'non'); // Clé manquante
    // await fillTextField(outputForm, 'code associe', data.code_associe); // Clé manquante
    selectRadioOption(outputForm, 'S-capacite', data.protectionMeasure); // Utilise protectionMeasure ?
    // await fillTextField(outputForm, 'S-capacite souscripteur_autre 3', data.capacite_juridique_autre); // Clé manquante
    selectRadioOption(outputForm, 'S-residence', data.fiscalResidenceCountry); // Utilise fiscalResidenceCountry
    // await fillTextField(outputForm, 'S-residence souscripteur_autre 4', data.residence_fiscale_autre); // Clé manquante
    // selectRadioOption(outputForm, 'S-regime fiscal', data.regime_fiscal); // Clé manquante
    selectRadioOption(outputForm, 'S-citoyen US', data.isUSPerson === 'Non' ? 'US non' : (data.isUSPerson === 'Oui' ? 'US oui' : '')); // Gère Oui/Non
    selectRadioOption(outputForm, 'S-esxpose LCT', data.isPPE === 'Non' ? 'LCB non' : (data.isPPE === 'Oui' ? 'LCB oui' : '')); // Gère Oui/Non
    selectRadioOption(outputForm, 'QPP-SPR-activite', data.socioProfessionalCategory); // Utilise socioProfessionalCategory
    await fillTextField(outputForm, 'QPP-SPR-profession souscripteur', data.profession);
    // await fillTextField(outputForm, 'QPP-SPR-secteur activite Co_sous', data.secteur_activite); // Clé manquante

    // Co-souscripteur - Logique simplifiée/supprimée car non gérée par JSON plat actuel

    // Souscription (mappée depuis clés plates)
    // await fillTextField(outputForm, 'S-nb-part', data.nombre_parts); // Clé manquante
    // await fillTextField(outputForm, 'S-total-souscription', data.montant_total); // Clé manquante
    // await fillTextField(outputForm, 'S-somme-reglee', data.reglement_montant); // Clé manquante
    // await fillTextField(outputForm, 'S-nom-prenom-cheque', data.nom_titulaire_compte); // Clé manquante
    // await fillTextField(outputForm, 'S-pays-fonds', data.pays_provenance_fonds); // Clé manquante
    // await fillTextField(outputForm, 'S-montant-financement', data.financement_montant); // Clé manquante
    // await fillTextField(outputForm, 'S-banque', data.financement_banque); // Clé manquante
    // Origine des fonds - Clés manquantes dans JSON IA
    // setCheckboxValue(outputForm, 'fond epargne', data.origine_fonds?.epargne);
    // ... etc ...

    // Versements Programmés - Clés manquantes dans JSON IA
    // if (data.versements_programmes_activer === true || ...) { ... }

    // Réinvestissement - Clés manquantes dans JSON IA
    // if (data.reinvestissement_activer === true || ...) { ... }
    // await fillTextField(outputForm, 'S-Fait à', data.reinvestissement_signature_lieu); // Page 7
    // await fillDateFields(outputForm, data.reinvestissement_signature_date, 'Date1_af_date.0', 'Date1_af_date.1', 'Date1_af_date.2', 2); // Page 7

    // Préférences Communication - Clés manquantes dans JSON IA
    // selectRadioOption(outputForm, 'Convoc assemblees', data.pref_convocation_ag_demat ? 'oui' : 'non ');
    // selectRadioOption(outputForm, 'bordereau fiscal', data.pref_bordereau_fiscal_demat ? 'oui' : 'non ');
    // await fillTextField(outputForm, 'S-fait-a', data.pref_signature_lieu); // Page 8
    // await fillDateFields(outputForm, data.pref_signature_date, 'S-fait-a-date-jj#BS SIGNAT', 'S-fait-a-date-mm#BS SIGNAT', 'S-fait-a-date-yyyy#BS SIGNAT', 4); // Page 8

    // SEPA - Clés manquantes dans JSON IA
    // if (data.sepa_activer === true || ...) { ... }

    // Remplissage des champs financiers et fiscaux qui SONT dans le JSON IA
    await fillTextField(outputForm, 'S-nb-part', ''); // Placeholder, clé manquante
    await fillTextField(outputForm, 'S-total-souscription', ''); // Placeholder, clé manquante
    await fillTextField(outputForm, 'S-somme-reglee', ''); // Placeholder, clé manquante

    // Utilisation des valeurs financières extraites
    // Note: Le PDF modèle attend peut-être des chaînes formatées (€, etc.)
    // Les fonctions helper convertissent en String, donc ça devrait aller.
    await fillTextField(outputForm, 'QPP-SPR-revenus annuels', data.totalIncome); // Exemple, trouver le bon champ PDF
    await fillTextField(outputForm, 'QPP-SPR-patrimoine', data.assetsTotal); // Exemple, trouver le bon champ PDF

    // Champs fiscaux
    await fillTextField(outputForm, 'Annee N', data.taxYear); // Exemple, trouver le bon champ PDF
    await fillTextField(outputForm, 'Revenu brut global', data.grossIncome); // Exemple, trouver le bon champ PDF
    await fillTextField(outputForm, 'Revenu fiscal de reference', data.referenceIncome); // Souvent vide
    await fillTextField(outputForm, 'Revenu imposable', data.taxableIncome); // Souvent vide
    await fillTextField(outputForm, 'Impot net avant credit impot', data.netTaxBeforeAdjustment); // Souvent vide
    await fillTextField(outputForm, 'Impot sur le revenu net', data.netTaxAmount); // Exemple, trouver le bon champ PDF
    await fillTextField(outputForm, 'Tranche marginale imposition', data.marginalTaxRate * 100 + '%'); // Formatage TMI

    console.log("Remplissage partiel du PDF modèle terminé (basé sur JSON plat).");
}
// --- Fin Fonction de Remplissage ---


// --- Endpoints ---

// Endpoint principal (reçoit JSON plat de l'IA)
app.post('/fill', async (req, res) => {
  console.log("Requête reçue sur /fill (JSON plat attendu)");
  const data = req.body; // Le JSON plat envoyé par n8n (provenant de l'IA)

  if (!data || typeof data !== 'object' || Array.isArray(data)) { // Vérifie que c'est un objet simple
    console.error("Données JSON invalides reçues sur /fill. Attendu: objet plat.");
    return res.status(400).send('Corps de la requête invalide ou manquant (doit être un objet JSON plat)');
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
    // form.flatten(); // Décommenter pour aplatir si besoin
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

// Ancienne route /fill_from_pdf (peut être supprimée ou laissée si utile pour autre chose)
// ... (code de la route /fill_from_pdf omis pour la clarté, mais il est toujours dans le fichier original)


// Endpoint de test simple
app.get('/', (req, res) => {
  res.send('PDF Filler Service is running. Use POST /fill (JSON).');
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`PDF Filler Service démarré sur le port ${PORT}`);
  console.log(`Modèle PDF attendu à : ${pdfTemplatePath}`);
});
