/**
 * Seeds demo data: FHIR Patients, each with a linked EHR and one composition.
 *
 * DEMO DATA. Everything this script writes is fictional and marked as such —
 * every patient carries the `demo` tag below, which is what the Settings view
 * uses to label them in the UI. Nothing here should ever be mistaken for a real
 * record, and the tag is the mechanism that keeps that true.
 *
 * The 41 EHRs already in this CDR are PoC leftovers with `PARTY_SELF` and no
 * external ref. They are deliberately left alone: inventing demographics for
 * them would produce exactly the kind of plausible-but-fake record this tag
 * exists to prevent.
 *
 *   npm run seed             create patients that do not exist yet
 *   npm run seed -- --force  create a fresh set even if names already match
 *
 * Requires the BFF (npm run dev:server) and both back ends.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BFF = process.env.BFF_BASE ?? 'http://localhost:3001';
const TEMPLATE_ID = process.env.TEMPLATE_ID ?? 'EPS Patient Summary';
const FORCE = process.argv.includes('--force');

/** Marks every seeded resource as fictional. */
const DEMO_TAG = {
  system: 'http://freshehr.nl/fhir/CodeSystem/data-origin',
  code: 'demo',
  display: 'Fictional demonstration data',
};

interface DemoPatient {
  family: string;
  given: string[];
  gender: 'male' | 'female' | 'other' | 'unknown';
  birthDate: string;
  /** Dutch citizen service number — fictional, from the reserved test range. */
  bsn: string;
}

/**
 * Anna de Vries comes from the mockup; the rest are plausible neighbours that
 * give the patient list a realistic spread of ages and both sexes.
 *
 * BSNs are from the 999-prefixed range reserved for testing, so none can
 * collide with a real Dutch citizen service number.
 */
const DEMO_PATIENTS: DemoPatient[] = [
  { family: 'de Vries', given: ['Anna'], gender: 'female', birthDate: '1974-03-12', bsn: '999900123' },
  { family: 'Jansen', given: ['Pieter'], gender: 'male', birthDate: '1958-11-02', bsn: '999900124' },
  { family: 'Bakker', given: ['Sofie', 'Marie'], gender: 'female', birthDate: '1992-06-25', bsn: '999900125' },
  { family: 'van Dijk', given: ['Mohammed'], gender: 'male', birthDate: '2001-01-30', bsn: '999900126' },
  { family: 'Visser', given: ['Johanna'], gender: 'female', birthDate: '1939-09-08', bsn: '999900127' },
  { family: 'Smit', given: ['Lars'], gender: 'male', birthDate: '1985-04-17', bsn: '999900128' },
];

function toFhirPatient(p: DemoPatient) {
  return {
    resourceType: 'Patient',
    meta: { tag: [DEMO_TAG] },
    identifier: [{ system: 'http://fhir.nl/fhir/NamingSystem/bsn', value: p.bsn }],
    name: [{ use: 'official', family: p.family, given: p.given }],
    gender: p.gender,
    birthDate: p.birthDate,
    active: true,
  };
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BFF}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * The golden fixture, personalised per patient.
 *
 * The composition's own start time is spread across recent weeks so the
 * Compositions browser has something meaningful to sort by, and the composer
 * names the seeding script rather than a clinician who never wrote it.
 */
async function compositionFor(index: number): Promise<Record<string, unknown>> {
  const file = resolve(here, '../../fixtures/eps.example.flat.json');
  const golden = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

  const startTime = new Date(Date.now() - index * 7 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 19);

  return {
    ...golden,
    'eps_patient_summary/context/start_time': startTime,
    'eps_patient_summary/composer|name': 'Demo seeding script',
    'eps_patient_summary/territory|code': 'NL',
    'eps_patient_summary/territory|terminology': 'ISO_3166-1',
  };
}

async function existingPatientIds(p: DemoPatient): Promise<string[]> {
  const bundle = await api(`/api/patients?name=${encodeURIComponent(p.family)}`);
  return (bundle.entry ?? [])
    .map((e: any) => e.resource)
    .filter(
      (r: any) =>
        r?.resourceType === 'Patient' &&
        r.birthDate === p.birthDate &&
        (r.name ?? []).some((n: any) => n.family === p.family),
    )
    .map((r: any) => r.id);
}

async function main(): Promise<void> {
  const health = await api('/api/health');
  if (health.ehrbase !== 'up' || health.fhir !== 'up') {
    throw new Error(
      `Both back ends must be up before seeding (ehrbase=${health.ehrbase}, fhir=${health.fhir}).`,
    );
  }
  if (!(health.templates ?? []).includes(TEMPLATE_ID)) {
    throw new Error(
      `Template ${JSON.stringify(TEMPLATE_ID)} is not uploaded. Available: ${JSON.stringify(health.templates)}`,
    );
  }

  console.log(`Seeding ${DEMO_PATIENTS.length} demo patients against ${BFF}\n`);

  let created = 0;
  let skipped = 0;

  for (const [index, demo] of DEMO_PATIENTS.entries()) {
    const label = `${demo.given.join(' ')} ${demo.family}`;

    if (!FORCE) {
      const existing = await existingPatientIds(demo);
      if (existing.length) {
        console.log(`  = ${label} — already present (${existing[0]}), skipping`);
        skipped += 1;
        continue;
      }
    }

    // Creates the Patient and its linked EHR in one BFF call — the EHR's
    // subject.external_ref is what makes patient → EHR resolution work at all.
    const { patientId, ehrId } = await api('/api/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toFhirPatient(demo)),
    });

    const flat = await compositionFor(index);
    const posted = await api(
      `/api/ehr/${encodeURIComponent(ehrId)}/composition?templateId=${encodeURIComponent(TEMPLATE_ID)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flat),
      },
    );

    const uid =
      posted?.uid?.value ??
      Object.entries(posted).find(([k]) => k.endsWith('/_uid'))?.[1] ??
      '(no uid)';

    console.log(`  + ${label}`);
    console.log(`      patient ${patientId}`);
    console.log(`      ehr     ${ehrId}`);
    console.log(`      comp    ${String(uid).split('::')[0]}`);
    created += 1;
  }

  // Prove the link resolves rather than assuming it — this is the P2 gate.
  console.log('\nVerifying patient → EHR resolution…');
  const bundle = await api('/api/patients');
  const patients = (bundle.entry ?? []).map((e: any) => e.resource).filter(Boolean);
  let resolved = 0;
  for (const p of patients) {
    const res = await fetch(`${BFF}/api/patients/${encodeURIComponent(p.id)}/ehr`);
    if (res.ok) resolved += 1;
  }

  console.log(
    `\nDone. ${created} created, ${skipped} skipped. ` +
      `${resolved}/${patients.length} patients resolve to an EHR.`,
  );

  if (resolved < patients.length) {
    console.warn('WARNING: some patients have no EHR — re-run with --force to recreate them.');
  }
}

main().catch((err) => {
  console.error(`\nSeeding failed: ${err.message}`);
  process.exit(1);
});
