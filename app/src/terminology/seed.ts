/**
 * Seed terminology for the local provider (plan Step 4).
 *
 * Values marked "fixture" appear verbatim in the golden FLAT fixture, so a
 * round-trip through the form can reproduce the golden composition exactly.
 * The rest are plausible neighbours that make search feel real when judging C6.
 *
 * Replace `LocalTerminologyProvider` with a Snowstorm/Ontoserver client and
 * this file goes away — it exists only because Medblocks ships no terminology.
 */

import type { SearchResult } from './types';

/**
 * Terminology identifiers are the exact strings the golden fixture uses, not
 * the friendly names. EHRbase stores `|terminology` verbatim, so inventing
 * "SNOMED-CT" here would make every coded field differ from the golden
 * composition on read-back.
 */
export const TERMINOLOGY_SNOMED = 'http://www.snomed.org';
export const TERMINOLOGY_ATC = 'https://termgit.elga.gv.at/CodeSystem/atc-deutsch-wido';

/**
 * NOTE: no `text` field, deliberately.
 *
 * `mb-search._handleSelect` (search.js:11) checks `data.text` FIRST and, if
 * present, stores the result as a PLAIN STRING — discarding code and
 * terminology. Setting `text` therefore silently downgrades a DV_CODED_TEXT to
 * DV_TEXT, and the composition loses its coding.
 *
 * Omitting `text` takes the else branch, which keeps {code, value, terminology}
 * and emits all three FLAT attributes.
 */
const snomed = (code: string, value: string): SearchResult => ({
  code,
  value,
  terminology: TERMINOLOGY_SNOMED,
});

const atc = (code: string, value: string): SearchResult => ({
  code,
  value,
  terminology: TERMINOLOGY_ATC,
});

/** Allergy reaction manifestations (SNOMED CT clinical findings). */
export const SNOMED_MANIFESTATIONS: SearchResult[] = [
  snomed('4386001', 'Bronchospasm'), // fixture
  snomed('271807003', 'Skin rash'),
  snomed('126485001', 'Urticaria'),
  snomed('418290006', 'Itching'),
  snomed('267036007', 'Dyspnoea'),
  snomed('39579001', 'Anaphylaxis'),
  snomed('91175000', 'Seizure'),
  snomed('422587007', 'Nausea'),
  snomed('422400008', 'Vomiting'),
  snomed('62315008', 'Diarrhoea'),
  snomed('232353008', 'Periorbital oedema'),
  snomed('41291007', 'Angioedema'),
  snomed('76067001', 'Sneezing'),
  snomed('49727002', 'Cough'),
  snomed('386661006', 'Fever'),
  snomed('25064002', 'Headache'),
  snomed('162397003', 'Chest pain'),
  snomed('271594007', 'Syncope'),
  snomed('444814009', 'Viral sinusitis'),
  snomed('195967001', 'Asthma'),
];

/** Problem / diagnosis names (SNOMED CT). */
export const SNOMED_FINDINGS: SearchResult[] = [
  snomed('404684003', 'Clinical finding (finding)'), // fixture — incl. semantic tag
  snomed('73211009', 'Diabetes mellitus'),
  snomed('38341003', 'Hypertensive disorder'),
  snomed('195967001', 'Asthma'),
  snomed('13645005', 'Chronic obstructive lung disease'),
  snomed('84114007', 'Heart failure'),
  snomed('49436004', 'Atrial fibrillation'),
  snomed('35489007', 'Depressive disorder'),
  snomed('396275006', 'Osteoarthritis'),
  snomed('69896004', 'Rheumatoid arthritis'),
  snomed('432504007', 'Cerebrovascular accident'),
  snomed('53741008', 'Coronary arteriosclerosis'),
  snomed('709044004', 'Chronic kidney disease'),
  snomed('235595009', 'Gastro-oesophageal reflux disease'),
  snomed('370143000', 'Major depressive disorder'),
];

/** Body sites (SNOMED CT) — Problems' body_site is DV_CODED_TEXT (trap R4). */
export const SNOMED_BODY_SITES: SearchResult[] = [
  snomed('53075003', 'Distal phalanx of hallux'), // fixture
  snomed('80248007', 'Left upper arm'),
  snomed('368209003', 'Right upper arm'),
  snomed('61396006', 'Left thigh'),
  snomed('11207009', 'Right thigh'),
  snomed('51185008', 'Thoracic structure'),
  snomed('818983003', 'Abdomen'),
  snomed('69536005', 'Head'),
  snomed('45048000', 'Neck'),
  snomed('62175007', 'Left knee'),
];

/** Allergy substances (ATC). */
export const ATC_SUBSTANCES: SearchResult[] = [
  atc('A01AA', 'Caries prophylactic agents'), // fixture
  atc('J01CA04', 'Amoxicillin'),
  atc('J01CE02', 'Phenoxymethylpenicillin'),
  atc('J01FA09', 'Clarithromycin'),
  atc('N02BE01', 'Paracetamol'),
  atc('M01AE01', 'Ibuprofen'),
  atc('B01AC06', 'Acetylsalicylic acid'),
  atc('N05BA01', 'Diazepam'),
  atc('C09AA05', 'Ramipril'),
  atc('C07AB07', 'Bisoprolol'),
  atc('A10BA02', 'Metformin'),
  atc('R03AC02', 'Salbutamol'),
  atc('H02AB06', 'Prednisolone'),
  atc('J01MA02', 'Ciprofloxacin'),
  atc('N06AB03', 'Fluoxetine'),
];
