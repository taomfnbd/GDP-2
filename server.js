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
     const foundOption = options.find(opt => opt.trim().toLowerCase() === valueToSelect.toLowerCase());

     if (foundOption) {
         field.select(foundOption);
     } else {
         // Tente de trouver une correspondance partielle ou une valeur standard (ex: "Non" vs "US non")
         let fallbackOption = null;
         if (valueToSelect.toLowerCase() === 'non') {
             fallbackOption = options.find(opt => opt.toLowerCase().includes('non') || opt.toLowerCase().includes('no'));
         } else if (valueToSelect.toLowerCase() === 'oui') {
              fallbackOption = options.find(opt => opt.toLowerCase().includes('oui') || opt.toLowerCase().includes('yes'));
         }
         // Ajoutez d'autres logiques de fallback si nécessaire

         if(fallbackOption) {
            console.warn(`Radio ${fieldName}: option "${valueToSelect}" non trouvée exactement. Utilisation du fallback "${fallbackOption}". Options PDF: [${options.join(', ')}]`);
            field.select(fallbackOption);
         } else {
            console.warn(`Radio ${fieldName}: option "${valueToSelect}" non trouvée parmi [${options.join(', ')}]. Tentative avec la valeur brute échouée.`);
            // Optionnellement, ne rien faire ou logger une erreur plus grave
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
    // Accepte "non" comme false également
    if (['false', '0', 'no', 'non', ''].includes(lowerValue)) {
        shouldCheck = false;
    } else if (['true', '1', 'yes', 'on', 'oui'].includes(lowerValue)) {
        shouldCheck = true;
    } else {
        return; // Ne coche/décoche pas si valeur non reconnue
    }
  } else if (typeof value === 'number') {
    shouldCheck = value === 1;
  } else {
    return; // Ne fait rien si type non reconnu
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
    // Regex plus flexible pour séparateurs et format AAAA-MM-JJ
    const match = dateString.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$|^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (!match) return;

    let day, month, fullYear;
    if (match[1]) { // Format JJ/MM/AAAA ou JJ-MM-AAAA
        [day, month, fullYear] = [match[1], match[2], match[3]];
    } else { // Format AAAA-MM-JJ ou AAAA/MM/JJ
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
        const fieldName = `${baseFieldName}-${i + 1}`; // Ex: S-IBAN-1, S-IBAN-2...
        const start = i * segmentLength;
        const end = start + segmentLength;
        const segment = cleanedIban.substring(start, end);
        await fillTextField(form, fieldName, segment);
    }
}
// --- Fin Fonctions Helper ---


// --- Fonction de Remplissage du PDF Modèle (Utilisant les noms de champs PDF confirmés) ---
async function fillOutputPdf(outputForm, data) {
    console.log("Remplissage PDF avec noms de champs confirmés...");

    // --- Section Souscripteur ---
    selectRadioOption(outputForm, 'S-proprietaire', data.housingStatus);
    selectRadioOption(outputForm, 'S-titre', data.civility); // Vide si IA ne trouve pas

    const nameParts = (data.fullName || "").split(' ');
    const prenom = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : data.fullName;
    const nom = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
    await fillTextField(outputForm, 'S-prenom souscripteur 2', prenom); // Vide si IA ne trouve pas
    await fillTextField(outputForm, 'S-nom souscripteur 2', nom); // Vide si IA ne trouve pas
    await fillTextField(outputForm, 'S-nom-fille souscripteur 2', data.birthName); // Vide si IA ne trouve pas
    await fillDateFields(outputForm, data.birthDate, 'S-jour souscripteur 2', 'S-mois souscripteur 3', 'S-annee souscripteur 2'); // Vide si IA ne trouve pas
    await fillTextField(outputForm, 'S-nationalite souscripteur 2', data.nationality); // Vide si IA ne trouve pas
    await fillTextField(outputForm, 'S-commune-naissance souscripteur 2', ''); // Clé manquante: data.lieu_naissance
    await fillTextField(outputForm, 'S-departement-naissance souscripteur 2', ''); // Clé manquante: data.departement_naissance
    await fillTextField(outputForm, 'S-pays-naissance souscripteur 2', ''); // Clé manquante: data.pays_naissance

    // Adresse - Remplissage basique du champ principal
    const firstLineAddress = (data.address || "").split('\n')[0];
    await fillTextField(outputForm, 'S-adresse souscripteur 2', firstLineAddress); // Vide si IA ne trouve pas
    // Les champs CP, Ville ne sont pas remplis car l'IA ne les structure pas
    await fillTextField(outputForm, 'S-pays souscripteur 2', data.fiscalResidenceCountry);

    // Adresse Fiscale - Non gérée car dépend de la logique "si différente" non extraite
    // await fillTextField(outputForm, 'S-no-adresse fiscal', ...);
    // await fillTextField(outputForm, 'S-adresse fiscal', ...);
    // await fillTextField(outputForm, 'S-code-postal fiscal', ...);
    // await fillTextField(outputForm, 'S-ville fiscal', ...);

    await fillTextField(outputForm, 'S-telephone souscripteur 2', data.phoneMobile); // Utilise Mobile
    await fillTextField(outputForm, 'S-mail souscripteur 2', data.email); // Vide si IA ne trouve pas
    selectRadioOption(outputForm, 'S-situation-famille', data.maritalStatus);
    selectRadioOption(outputForm, 'S-regime-matrimonial', data.maritalRegime); // Clé manquante
    // selectRadioOption(outputForm, 'S-associe', data.deja_associe ? 'oui' : 'non'); // Clé manquante
    // await fillTextField(outputForm, 'code associe', data.code_associe); // Clé manquante
    selectRadioOption(outputForm, 'S-capacite', data.protectionMeasure);
    // await fillTextField(outputForm, 'S-capacite souscripteur_autre 3', data.capacite_juridique_autre); // Clé manquante
    selectRadioOption(outputForm, 'S-residence', data.fiscalResidenceCountry);
    // await fillTextField(outputForm, 'S-residence souscripteur_autre 4', data.residence_fiscale_autre); // Clé manquante
    selectRadioOption(outputForm, 'S-regime fiscal', ''); // Clé manquante: data.regime_fiscal

    // Conversion Oui/Non pour US Person et PPE
    const isUSPersonValue = data.isUSPerson === 'Non' ? 'US non' : (data.isUSPerson === 'Oui' ? 'US oui' : null);
    if (isUSPersonValue) selectRadioOption(outputForm, 'S-citoyen US', isUSPersonValue);
    const isPPEValue = data.isPPE === 'Non' ? 'LCB non' : (data.isPPE === 'Oui' ? 'LCB oui' : null);
    if (isPPEValue) selectRadioOption(outputForm, 'S-esxpose LCT', isPPEValue);

    selectRadioOption(outputForm, 'QPP-SPR-activite', data.socioProfessionalCategory); // Vide si IA ne trouve pas
    await fillTextField(outputForm, 'QPP-SPR-profession souscripteur', data.profession); // Vide si IA ne trouve pas
    // await fillTextField(outputForm, 'QPP-SPR-secteur activite Co_sous', data.secteur_activite); // Clé manquante

    // --- Co-souscripteur ---
    // Ignoré

    // --- Souscription ---
    await fillTextField(outputForm, 'S-nb-part', ''); // Clé manquante
    await fillTextField(outputForm, 'S-total-souscription', ''); // Clé manquante
    await fillTextField(outputForm, 'S-somme-reglee', ''); // Clé manquante
    await fillTextField(outputForm, 'S-nom-prenom-cheque', ''); // Clé manquante
    await fillTextField(outputForm, 'S-pays-fonds', ''); // Clé manquante
    await fillTextField(outputForm, 'S-montant-financement', ''); // Clé manquante
    await fillTextField(outputForm, 'S-banque', ''); // Clé manquante

    // --- Origine des Fonds ---
    // Utilise setCheckboxValue avec les noms de champs PDF confirmés
    setCheckboxValue(outputForm, 'fond epargne', data.epargne); // Clé manquante
    await fillTextField(outputForm, 'S-pourcent-epargne', data.epargne_pct); // Clé manquante
    setCheckboxValue(outputForm, 'fond heritage', data.heritage); // Clé manquante
    await fillTextField(outputForm, 'S-pourcent-heritage', data.heritage_pct); // Clé manquante
    setCheckboxValue(outputForm, 'fond donation', data.donation); // Clé manquante
    await fillTextField(outputForm, 'S-pourcent-donation', data.donation_pct); // Clé manquante
    setCheckboxValue(outputForm, 'fond credit', data.credit); // Clé manquante
    await fillTextField(outputForm, 'S-pourcent-credit', data.credit_pct); // Clé manquante
    setCheckboxValue(outputForm, 'fond cession activite', data.cession_activite); // Clé manquante
    await fillTextField(outputForm, 'S-pourcent-cessation', data.cession_activite_pct); // Clé manquante
    setCheckboxValue(outputForm, 'fond idemnites', data.prestations); // Clé manquante
    await fillTextField(outputForm, 'S-pourcent-indemnites', data.prestations_pct); // Clé manquante
    setCheckboxValue(outputForm, 'fond autre', data.autres); // Clé manquante
    await fillTextField(outputForm, 'S-pourcent-autres', data.autres_pct); // Clé manquante
    await fillTextField(outputForm, 'fond autre quid', data.autres_details); // Clé manquante

    // --- Versements Programmés ---
    // selectRadioOption(outputForm, 'S-souscrip-vers prog', data.frequence); // Clé manquante
    // await fillTextField(outputForm, 'S-somme investie 2', data.montant); // Clé manquante
    // await fillTextField(outputForm, 'S-versement fait a', data.signature_lieu); // Clé manquante
    // await fillDateFields(outputForm, data.signature_date, 'S-versement le', 'S-versement mois', 'S-versement annee', 4); // Clé manquante

    // --- Réinvestissement ---
    // selectRadioOption(outputForm, 'S-Somme reinvestie ', data.reinvestissement_option); // Clé manquante
    // await fillTextField(outputForm, 'S-% somme re-investie', data.reinvestissement_taux); // Clé manquante
    await fillTextField(outputForm, 'S-Fait à', ''); // Clé manquante: data.reinvestissement_signature_lieu
    await fillDateFields(outputForm, '', 'Date1_af_date.0', 'Date1_af_date.1', 'Date1_af_date.2', 2); // Clé manquante: data.reinvestissement_signature_date

    // --- Préférences Communication ---
    // selectRadioOption(outputForm, 'Convoc assemblees', data.convocation_ag_demat ? 'oui' : 'non '); // Clé manquante
    // selectRadioOption(outputForm, 'bordereau fiscal', data.bordereau_fiscal_demat ? 'oui' : 'non '); // Clé manquante
    await fillTextField(outputForm, 'S-fait-a', ''); // Clé manquante: data.pref_signature_lieu
    await fillDateFields(outputForm, '', 'S-fait-a-date-jj#BS SIGNAT', 'S-fait-a-date-mm#BS SIGNAT', 'S-fait-a-date-yyyy#BS SIGNAT', 4); // Clé manquante: data.pref_signature_date

    // --- SEPA ---
    // await fillTextField(outputForm, 'S-nom 6', data.nom_titulaire); // Clé manquante
    // await fillTextField(outputForm, 'S-no-adresse 5', data.adresse_no); // Clé manquante
    // await fillTextField(outputForm, 'S-adresse7', data.adresse_rue); // Clé manquante
    // await fillTextField(outputForm, 'S-code-postal 5', data.cp); // Clé manquante
    // await fillTextField(outputForm, 'S-ville 5', data.ville); // Clé manquante
    // await fillTextField(outputForm, 'S-pays 5', data.pays); // Clé manquante
    // await fillIbanFields(outputForm, data.iban, 'S-IBAN', 7); // Clé manquante
    // await fillTextField(outputForm, 'S-BIC', data.bic); // Clé manquante
    // setCheckboxValue(outputForm, 'paiement ponctuel', data.type_paiement_ponctuel); // Clé manquante
    // setCheckboxValue(outputForm, 'paiement recurrent', data.type_paiement_recurrent); // Clé manquante
    // await fillTextField(outputForm, 'S-fait a 5', data.signature_lieu); // Clé manquante
    // await fillDateFields(outputForm, data.signature_date, 'S-fait-a-date-jj', 'S-fait-a-date-mm', 'S-fait-a-date-yyyy', 4); // Clé manquante

    // --- Champs Financiers et Fiscaux (Utilisation des clés présentes et noms PDF potentiels) ---
    // !! Les noms de champs PDF ici sont des SUPPOSITIONS basées sur les libellés !!
    // !! Il FAUT les vérifier dans le PDF réel !!
    await fillTextField(outputForm, 'Epargne Precaution Souhaitee', data.precautionSavings); // Nom PDF ?
    await fillTextField(outputForm, 'Total Actifs Bruts', data.assetsTotal); // Nom PDF ?
    await fillTextField(outputForm, 'Total Passifs', data.liabilitiesTotal); // Nom PDF ?
    await fillTextField(outputForm, 'Total Revenus', data.totalIncome); // Nom PDF ?
    await fillTextField(outputForm, 'Total Charges', data.totalExpenses); // Nom PDF ?
    await fillTextField(outputForm, 'Annee N', data.taxYear); // Nom PDF ? ('IR acquitté en' ?)
    await fillTextField(outputForm, 'Total Salaires Assimiles', data.grossSalary); // Nom PDF ?
    await fillTextField(outputForm, 'TMI IR', data.marginalTaxRate ? (data.marginalTaxRate * 100).toFixed(2) + ' %' : ''); // Nom PDF ?
    await fillTextField(outputForm, 'Revenu brut global', data.grossIncome); // Nom PDF ?
    await fillTextField(outputForm, 'Impot sur le revenu net', data.netTaxAmount); // Nom PDF ?

    // Champs liés à l'épargne (Noms PDF inconnus)
    // await fillTextField(outputForm, '???', data.savingsTotal);
    // await fillTextField(outputForm, '???', data.shortTermSavings);
    // await fillTextField(outputForm, '???', data.livretA);
    // await fillTextField(outputForm, '???', data.currentAccount);
    // await fillTextField(outputForm, '???', data.longTermSavings);
    // await fillTextField(outputForm, '???', data.lifeInsurance);

    console.log("Remplissage PDF terminé avec les noms de champs connus.");
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
  if (Object.keys(data).length === 0 && data.constructor === Object) {
     console.error("Données JSON reçues vides sur /fill.");
     // Continue pour générer un PDF quasi-vide
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

// Endpoint de test simple
app.get('/', (req, res) => {
  res.send('PDF Filler Service is running. Use POST /fill (JSON).');
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`PDF Filler Service démarré sur le port ${PORT}`);
  console.log(`Modèle PDF attendu à : ${pdfTemplatePath}`);
});
