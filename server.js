import express from 'express';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url'; // Pour obtenir le chemin du répertoire actuel avec ES Modules

// Configuration
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pdfTemplatePath = path.join(__dirname, 'Bulletin_template.pdf'); // Assurez-vous que ce fichier existe !

const app = express();
app.use(express.json({ limit: '10mb' })); // Pour parser le JSON dans le corps des requêtes, augmenter la limite si nécessaire

// --- Fonctions Helper (adaptées pour le service) ---
// Pas besoin de passer pdfDoc ici car on n'essaie plus de modifier la police
async function fillTextField(form, fieldName, text) {
  if (text === null || typeof text === 'undefined' || text === '') return;
  let textToSet = String(text);
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
   if (!optionValue) return;
   try {
     const field = form.getRadioGroup(fieldName);
     field.select(optionValue);
   } catch (e) {
     try {
        const options = form.getRadioGroup(fieldName).getOptions();
        console.warn(`Radio ${fieldName}: option "${optionValue}" invalide. Options: [${options.join(', ')}]. Err: ${e.message}`);
     } catch (innerErr) { console.warn(`Radio ${fieldName} non trouvé/erreur: ${e.message}`); }
   }
}

function setCheckboxValue(form, fieldName, shouldCheck) {
  if (typeof shouldCheck !== 'boolean') return;
  try {
    const field = form.getCheckBox(fieldName);
    if (shouldCheck) field.check();
    else field.uncheck();
  } catch (e) { if (!e.message.toLowerCase().includes('no field')) console.warn(`Checkbox ${fieldName} non trouvé/erreur: ${e.message}`); }
}

async function fillDateFields(form, dateString, dayField, monthField, yearField, yearLength = 4) {
    if (!dateString || !dateString.includes('/')) return;
    const parts = dateString.split('/');
    if (parts.length !== 3) return; // Vérifie le format
    const [day, month, fullYear] = parts;
    const year = yearLength === 2 ? fullYear.slice(-2) : fullYear;
    await fillTextField(form, dayField, day);
    await fillTextField(form, monthField, month);
    await fillTextField(form, yearField, year);
}

async function fillIbanFields(form, ibanString, baseFieldName, numFields) {
    if (!ibanString) return;
    const cleanedIban = String(ibanString).replace(/\s/g, '');
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

// Endpoint pour remplir le PDF
app.post('/fill', async (req, res) => {
  console.log("Requête reçue sur /fill");
  const data = req.body; // Les données JSON envoyées par n8n

  if (!data || typeof data !== 'object') {
    console.error("Données invalides reçues.");
    return res.status(400).send('Corps de la requête invalide ou manquant (doit être JSON)');
  }

  try {
    // Lire le modèle PDF
    console.log(`Lecture du modèle PDF depuis : ${pdfTemplatePath}`);
    const pdfBytes = await readFile(pdfTemplatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    console.log("Modèle PDF chargé.");

    // --- Remplissage des champs (logique identique à fill-pdf.js) ---
    console.log("Début du remplissage des champs...");
    const s = data.souscripteur || {}; // Utiliser objet vide si non fourni
    selectRadioOption(form, 'S-proprietaire', s.propriete);
    selectRadioOption(form, 'S-titre', s.civilite);
    await fillTextField(form, 'S-prenom souscripteur 2', s.prenom);
    await fillTextField(form, 'S-nom-fille souscripteur 2', s.nom_naissance);
    await fillTextField(form, 'S-nom souscripteur 2', s.nom);
    await fillDateFields(form, s.date_naissance, 'S-jour souscripteur 2', 'S-mois souscripteur 3', 'S-annee souscripteur 2');
    await fillTextField(form, 'S-commune-naissance souscripteur 2', s.lieu_naissance);
    await fillTextField(form, 'S-departement-naissance souscripteur 2', s.departement_naissance);
    await fillTextField(form, 'S-pays-naissance souscripteur 2', s.pays_naissance);
    await fillTextField(form, 'S-nationalite souscripteur 2', s.nationalite);
    await fillTextField(form, 'S-representant souscripteur 2', s.representant_pm);
    await fillTextField(form, 'S-forme_juridique souscripteur 2', s.forme_juridique_pm);
    await fillTextField(form, 'S-siret souscripteur 2', s.siret_pm);
    await fillTextField(form, 'S-no-adresse souscripteur 2', s.adresse_no);
    await fillTextField(form, 'S-adresse souscripteur 2', s.adresse_rue);
    await fillTextField(form, 'S-code-postal souscripteur 2', s.adresse_cp);
    await fillTextField(form, 'S-ville souscripteur 2', s.adresse_ville);
    await fillTextField(form, 'S-pays souscripteur 2', s.adresse_pays);
    if (s.adresse_fiscale_identique === false) { // Remplir seulement si explicitement non identique
        await fillTextField(form, 'S-no-adresse fiscal', s.adresse_fiscale_no);
        await fillTextField(form, 'S-adresse fiscal', s.adresse_fiscale_rue);
        await fillTextField(form, 'S-code-postal fiscal', s.adresse_fiscale_cp);
        await fillTextField(form, 'S-ville fiscal', s.adresse_fiscale_ville);
    }
    await fillTextField(form, 'S-telephone souscripteur 2', s.telephone);
    await fillTextField(form, 'S-mail souscripteur 2', s.email);
    selectRadioOption(form, 'S-situation-famille', s.situation_familiale);
    selectRadioOption(form, 'S-regime-matrimonial', s.regime_matrimonial);
    selectRadioOption(form, 'S-associe', s.deja_associe ? 'oui' : 'non');
    await fillTextField(form, 'code associe', s.code_associe);
    selectRadioOption(form, 'S-capacite', s.capacite_juridique);
    await fillTextField(form, 'S-capacite souscripteur_autre 3', s.capacite_juridique_autre);
    selectRadioOption(form, 'S-residence', s.residence_fiscale);
    await fillTextField(form, 'S-residence souscripteur_autre 4', s.residence_fiscale_autre);
    selectRadioOption(form, 'S-regime fiscal', s.regime_fiscal);
    selectRadioOption(form, 'S-citoyen US', s.us_person ? 'US oui' : 'US non');
    selectRadioOption(form, 'S-esxpose LCT', s.ppe ? 'LCB oui' : 'LCB non');
    selectRadioOption(form, 'QPP-SPR-activite', s.situation_pro);
    await fillTextField(form, 'QPP-SPR-profession souscripteur', s.profession);
    await fillTextField(form, 'QPP-SPR-secteur activite Co_sous', s.secteur_activite);

    // Co-souscripteur
    const cs = data.co_souscripteur || {};
    if (cs.present === true) {
        selectRadioOption(form, 'CS-titre', cs.civilite);
        await fillTextField(form, 'S-prenom Co-souscripteur 4', cs.prenom);
        await fillTextField(form, 'S-nom-fille Co-souscripteur 8', cs.nom_naissance);
        await fillTextField(form, 'S-nom Co-souscripteur 4', cs.nom);
        await fillDateFields(form, cs.date_naissance, 'S-jour Co-souscripteur 4', 'S-mois Co-souscripteur 7', 'S-annee Co-souscripteur 4');
        await fillTextField(form, 'S-commune-naissance Co-souscripteur 4', cs.lieu_naissance);
        await fillTextField(form, 'S-departement-naissance Co-souscripteur 4', cs.departement_naissance);
        await fillTextField(form, 'S-pays-naissance Co-souscripteur 4', cs.pays_naissance);
        await fillTextField(form, 'S-Nationalite Co-souscripteur 8', cs.nationalite);
        if (cs.adresse_identique === false) {
            await fillTextField(form, 'S-no-adresse Co-souscripteur 3', cs.adresse_no);
            await fillTextField(form, 'S-adresse Co-souscripteur 4', cs.adresse_rue);
            await fillTextField(form, 'S-code-postal Co-souscripteur 3', cs.adresse_cp);
            await fillTextField(form, 'S-ville Co-souscripteur 3', cs.adresse_ville);
            await fillTextField(form, 'S-pays Co-souscripteur 3', cs.adresse_pays);
        }
         if (cs.adresse_fiscale_identique === false) {
            await fillTextField(form, 'S-no-adresse fiscale Co-souscripteur 3', cs.adresse_fiscale_no);
            await fillTextField(form, 'S-adresse Co-souscripteur  fiscal', cs.adresse_fiscale_rue);
            await fillTextField(form, 'S-code-postal Co-souscripteur fiscal', cs.adresse_fiscale_cp);
            await fillTextField(form, 'S-ville Co-souscripteur fiscal', cs.adresse_fiscale_ville);
        }
        await fillTextField(form, 'S-telephone Co-souscripteur 3', cs.telephone);
        await fillTextField(form, 'S-mail Co-souscripteur 3', cs.email);
        selectRadioOption(form, 'CS-situation-famille', cs.situation_familiale);
        selectRadioOption(form, 'CS-capacite', cs.capacite_juridique);
        await fillTextField(form, 'S-capacite_autre 5 Co-sous', cs.capacite_juridique_autre);
        selectRadioOption(form, 'CS-residence', cs.residence_fiscale);
        await fillTextField(form, 'S-residence_Co-Sous autre 6', cs.residence_fiscale_autre);
        selectRadioOption(form, 'CS-fiscal-impot', cs.regime_fiscal);
        selectRadioOption(form, 'CS-national-us', cs.us_person ? 'oui' : 'non ');
        selectRadioOption(form, 'CS-expose', cs.ppe ? 'oui' : 'non ');
        selectRadioOption(form, 'CS-QPP-SPR-activite', cs.situation_pro);
        await fillTextField(form, 'QPP-SPR-secteur activite Co_sous', cs.secteur_activite);
    }

    // Souscription
    const sub = data.souscription || {};
    await fillTextField(form, 'S-nb-part', sub.nombre_parts);
    await fillTextField(form, 'S-total-souscription', sub.montant_total);
    await fillTextField(form, 'S-somme-reglee', sub.reglement_montant);
    await fillTextField(form, 'S-nom-prenom-cheque', sub.nom_titulaire_compte);
    await fillTextField(form, 'S-pays-fonds', sub.pays_provenance_fonds);
    await fillTextField(form, 'S-montant-financement', sub.financement_montant);
    await fillTextField(form, 'S-banque', sub.financement_banque);
    const of = sub.origine_fonds || {};
    setCheckboxValue(form, 'fond epargne', of.epargne);
    await fillTextField(form, 'S-pourcent-epargne', of.epargne_pct);
    setCheckboxValue(form, 'fond heritage', of.heritage);
    await fillTextField(form, 'S-pourcent-heritage', of.heritage_pct);
    setCheckboxValue(form, 'fond donation', of.donation);
    await fillTextField(form, 'S-pourcent-donation', of.donation_pct);
    setCheckboxValue(form, 'fond credit', of.credit);
    await fillTextField(form, 'S-pourcent-credit', of.credit_pct);
    setCheckboxValue(form, 'fond cession activite', of.cession_activite);
    await fillTextField(form, 'S-pourcent-cessation', of.cession_activite_pct);
    setCheckboxValue(form, 'fond idemnites', of.prestations);
    await fillTextField(form, 'S-pourcent-indemnites', of.prestations_pct);
    setCheckboxValue(form, 'fond autre', of.autres);
    await fillTextField(form, 'S-pourcent-autres', of.autres_pct);
    await fillTextField(form, 'fond autre quid', of.autres_details);

    // Versements Programmés
    const vp = data.versements_programmes || {};
    if (vp.activer === true) {
        selectRadioOption(form, 'S-souscrip-vers prog', vp.frequence);
        await fillTextField(form, 'S-somme investie 2', vp.montant);
        await fillTextField(form, 'S-versement fait a', vp.signature_lieu);
        await fillDateFields(form, vp.signature_date, 'S-versement le', 'S-versement mois', 'S-versement annee', 4);
    }

    // Réinvestissement
    const rd = data.reinvestissement_dividendes || {};
    if (rd.activer === true) {
        selectRadioOption(form, 'S-Somme reinvestie ', rd.reinvestissement_option);
        if (rd.reinvestissement_option === 'En partie') {
             await fillTextField(form, 'S-% somme re-investie', rd.reinvestissement_taux);
        }
    }
    await fillTextField(form, 'S-Fait à', rd.signature_lieu); // Page 7
    await fillDateFields(form, rd.signature_date, 'Date1_af_date.0', 'Date1_af_date.1', 'Date1_af_date.2', 2); // Page 7

    // Préférences
    const pc = data.preferences_communication || {};
    selectRadioOption(form, 'Convoc assemblees', pc.convocation_ag_demat ? 'oui' : 'non ');
    selectRadioOption(form, 'bordereau fiscal', pc.bordereau_fiscal_demat ? 'oui' : 'non ');
    await fillTextField(form, 'S-fait-a', pc.signature_lieu); // Page 8
    await fillDateFields(form, pc.signature_date, 'S-fait-a-date-jj#BS SIGNAT', 'S-fait-a-date-mm#BS SIGNAT', 'S-fait-a-date-yyyy#BS SIGNAT', 4); // Page 8

    // SEPA
    const sepa = data.mandat_sepa || {};
    if (sepa.activer === true) {
        await fillTextField(form, 'S-nom 6', sepa.nom_titulaire);
        await fillTextField(form, 'S-no-adresse 5', sepa.adresse_no);
        await fillTextField(form, 'S-adresse7', sepa.adresse_rue);
        await fillTextField(form, 'S-code-postal 5', sepa.cp);
        await fillTextField(form, 'S-ville 5', sepa.ville);
        await fillTextField(form, 'S-pays 5', sepa.pays);
        await fillIbanFields(form, sepa.iban, 'S-IBAN', 7);
        await fillTextField(form, 'S-BIC', sepa.bic);
        setCheckboxValue(form, 'paiement ponctuel', sepa.type_paiement_ponctuel);
        setCheckboxValue(form, 'paiement recurrent', sepa.type_paiement_recurrent);
        await fillDateFields(form, sepa.signature_date, 'S-fait-a-date-jj', 'S-fait-a-date-mm', 'S-fait-a-date-yyyy', 4); // Page 9
    }
    console.log("Remplissage des champs terminé.");

    // Sauvegarder le PDF modifié en mémoire (buffer)
    // form.flatten(); // Décommenter pour aplatir si besoin
    const pdfResultBytes = await pdfDoc.save();
    console.log("PDF modifié sauvegardé en mémoire.");

    // Envoyer le PDF rempli en réponse
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=bulletin-rempli.pdf'); // Suggère un nom de fichier au client
    res.send(Buffer.from(pdfResultBytes)); // Envoyer les données binaires
    console.log("PDF rempli envoyé en réponse.");

  } catch (error) {
    console.error("Erreur lors du traitement de la requête /fill:", error);
    // Vérifier si le modèle PDF existe
    if (error.code === 'ENOENT' && error.path === pdfTemplatePath) {
         console.error(`ERREUR CRITIQUE : Le fichier modèle PDF '${path.basename(pdfTemplatePath)}' est introuvable dans le dossier du service.`);
         return res.status(500).send(`Erreur serveur: Fichier modèle PDF manquant.`);
    }
    res.status(500).send(`Erreur serveur lors du remplissage du PDF: ${error.message}`);
  }
});

// Endpoint de test simple
app.get('/', (req, res) => {
  res.send('PDF Filler Service is running. Use POST /fill to process data.');
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`PDF Filler Service démarré sur le port ${PORT}`);
});
