/**
 * Seed the Finanstilsynet database with sample provisions for testing.
 *
 * Inserts representative provisions from FTNET_Bekendtgorelser, FTNET_Vejledninger,
 * and FTNET_Retningslinjer sourcebooks so MCP tools can be tested
 * without running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["FTNET_DB_PATH"] ?? "data/ftnet.db";
const force = process.argv.includes("--force");

// -- Bootstrap database --

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// -- Sourcebooks --

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "FTNET_BEKENDTGORELSER",
    name: "Finanstilsynet Bekendtgorelser (Executive Orders)",
    description:
      "Binding executive orders (bekendtgorelser) issued by the Danish FSA under authority delegated from Danish financial legislation. Covers governance, capital adequacy, reporting obligations, consumer protection, and AML/CFT requirements for credit institutions, investment firms, insurance companies, and payment service providers.",
  },
  {
    id: "FTNET_VEJLEDNINGER",
    name: "Finanstilsynet Vejledninger (Guidance)",
    description:
      "Non-binding supervisory guidance issued by Finanstilsynet explaining the interpretation and application of Danish financial regulation. Covers operational resilience, IT security, outsourcing, risk management, and supervisory expectations for regulated entities.",
  },
  {
    id: "FTNET_RETNINGSLINJER",
    name: "Finanstilsynet Retningslinjer (Guidelines)",
    description:
      "Finanstilsynet guidelines implementing EBA, ESMA, and EIOPA guidelines into Danish supervisory practice. Also includes sector-specific guidelines on cyber resilience, recovery planning, and remuneration.",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// -- Sample provisions --

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // -- FTNET_Bekendtgorelser -- Executive Orders --
  {
    sourcebook_id: "FTNET_BEKENDTGORELSER",
    reference: "BEK nr 1242 af 17/11/2017",
    title: "Bekendtgorelse om ledelse og styring af pengeinstitutter m.fl.",
    text: "Denne bekendtgorelse fastsaetter krav til ledelse og styring af pengeinstitutter, realkreditinstitutter og fondsmaeglerselskabers bestyrelse og direktion. Bestyrelsen skal fastlaegge virksomhedens overordnede strategi og paase, at virksomheden drives forsvarligt. Bestyrelsen skal vaere sammensat saledes, at den kan varetage sine ledelsesmaessige og kontrolmaessige opgaver. Hvert bestyrelsesmedlem skal have tilstraekkelig viden, faglig kompetence og erfaring til at forsta virksomhedens aktiviteter og de dermed forbundne risici. Virksomheden skal have en lederrekrutteringspolitik og interne governance-procedurer for valg og vurdering af ledelsesmedlemmers egnethed og hederlighedsstandard (fit and proper).",
    type: "bekendtgorelse",
    status: "in_force",
    effective_date: "2017-12-01",
    chapter: "1",
    section: "1",
  },
  {
    sourcebook_id: "FTNET_BEKENDTGORELSER",
    reference: "BEK nr 1242 af 17/11/2017, kap. 3",
    title: "Risikostyring og intern kontrol",
    text: "Virksomheden skal have en velfungerende organisation med klar ansvarsfordeling, effektive processer til at identificere, styre, overvaage og rapportere de risici, som virksomheden er eller kan blive udsat for, og passende interne kontrolmekanismer. Virksomheden skal have tre uafhaengige forsvarslinjer: forretningsenhederne, risikostyringsfunktionen og compliancefunktionen samt intern revision. Risikostyringsfunktionen skal vaere uafhaengig af forretningsenhederne og skal have adgang til alle relevante oplysninger. Bestyrelsen godkender og overvager regelmaessigt virksomhedens risikoprofil og risikoappetit.",
    type: "bekendtgorelse",
    status: "in_force",
    effective_date: "2017-12-01",
    chapter: "3",
    section: "3.1",
  },
  {
    sourcebook_id: "FTNET_BEKENDTGORELSER",
    reference: "BEK nr 567 af 02/06/2020",
    title: "Bekendtgorelse om forebyggende foranstaltninger mod hvidvask og finansiering af terrorisme for finansielle virksomheder",
    text: "Finansielle virksomheder skal implementere effektive systemer og kontroller til forebyggelse af hvidvask og finansiering af terrorisme i overensstemmelse med hvidvaskloven. Virksomheden skal foretage en risikovurdering af sin eksponering for risici for hvidvask og terrorfinansiering under hensyntagen til faktorer som produkter, tjenesteydelser, transaktioner, leveringskanaler og kunder. Virksomheden skal have skriftlige politikker og procedurer for kundekendskab (KYC), skarpet kundekendskab (EDD) for politisk udsatte personer (PEP) og hoejrisikokunder, loebende overvaagning af kundeforhold og indberetning af mistanke til Haervaerk Financial Intelligence Unit (HFIU).",
    type: "bekendtgorelse",
    status: "in_force",
    effective_date: "2020-07-01",
    chapter: "1",
    section: "1",
  },
  {
    sourcebook_id: "FTNET_BEKENDTGORELSER",
    reference: "BEK nr 1306 af 27/11/2019",
    title: "Bekendtgorelse om outsourcing for finansielle virksomheder",
    text: "Finansielle virksomheder, der outsourcer kritiske eller vaesentlige funktioner, skal traeffe alle rimelige foranstaltninger til at undga yderligere operationel risiko. Outsourcing maa ikke forringere kvaliteten af virksomhedens interne kontrol eller Finanstilsynets mulighed for at kontrollere, at virksomheden overholder sine forpligtelser. Virksomheden forbliver fuldt ansvarlig for opfyldelse af alle lovgivningsmaessige krav. Virksomheden skal udfoere tilstraekkelig due diligence paa tjenesteudbydere og sikre, at serviceaftaler indeholder bestemmelser om adgang til og revisionsrettigheder, databehandling, forretningskontinuitet og exitstrategier.",
    type: "bekendtgorelse",
    status: "in_force",
    effective_date: "2020-01-01",
    chapter: "1",
    section: "1",
  },
  // -- FTNET_Vejledninger -- Guidance --
  {
    sourcebook_id: "FTNET_VEJLEDNINGER",
    reference: "VEJ nr 9771 af 02/12/2020",
    title: "Vejledning om operationel modstandsdygtighed i den finansielle sektor",
    text: "Denne vejledning beskriver Finanstilsynets forventninger til finansielle virksomheders operationelle modstandsdygtighed. Finanstilsynet forventer, at virksomheder kortlaegger deres kritiske forretningsservices og de IT-systemer og infrastrukturkomponenter, der understotter dem. Virksomheder skal definere tolerancegranser for afbrydelser af kritiske tjenester og regelmassigt teste modstandsdygtighed gennem scenarietests, herunder cyberangreb og systemfejl. Finanstilsynet laegger vaegt paa, at ledelsen har klart ejerskab over operationel modstandsdygtighed, og at der foreligger effektive havaerilosninger og katastrofeplaner.",
    type: "vejledning",
    status: "in_force",
    effective_date: "2020-12-15",
    chapter: "1",
    section: "1",
  },
  {
    sourcebook_id: "FTNET_VEJLEDNINGER",
    reference: "VEJ nr 9152 af 07/08/2019",
    title: "Vejledning om IT-sikkerhed i finansielle virksomheder",
    text: "Finanstilsynet forventer, at finansielle virksomheder etablerer og vedligeholder et tilstraekkelig IT-sikkerhedsniveau, der star i et rimeligt forhold til virksomhedens storrelse, kompleksitet og risikoprofil. Virksomheden skal have en IT-sikkerhedspolitik godkendt af bestyrelsen, en IT-risikovurderingsproces, adgangskontrolprocedurer, kryptering af folsomme data, og procedurer for haandtering af IT-sikkerhedshendelser. Virksomheden skal have en beredskabsplan for IT-sikkerhedshendelser og afholde regelmassige ovelsestraeninger. Penetrationstest og saarbarhedsscanning skal udfoeres regelmaessigt paa kritiske systemer.",
    type: "vejledning",
    status: "in_force",
    effective_date: "2019-09-01",
    chapter: "1",
    section: "2",
  },
  {
    sourcebook_id: "FTNET_VEJLEDNINGER",
    reference: "VEJ nr 9330 af 22/04/2021",
    title: "Vejledning om kapitalplanlaegning og ICAAP for kreditinstitutter",
    text: "Denne vejledning beskriver Finanstilsynets forventninger til kreditinstitutters interne kapitalvurderingsproces (ICAAP). Instituttet skal foretage en samlet vurdering af dets samlede kapitalbehovsopgoerelse, der daekker alle vasentlige risici, herunder kreditrisiko, markedsrisiko, operationel risiko, koncentrationsrisiko, rentebindingsrisiko i bankbogen og likviditetsrisiko. ICAAP-dokumentationen skal indeholde stresstest, som identificerer kapitalmassige konsekvenser af alvorlige men sandsynlige negative scenarier. Finanstilsynet forventer, at kapitalplaner daekker en tidshorisont paa mindst tre aar og tager haejde for fremtidige kapitalbehovsaendringer.",
    type: "vejledning",
    status: "in_force",
    effective_date: "2021-05-01",
    chapter: "1",
    section: "1",
  },
  // -- FTNET_Retningslinjer -- Guidelines --
  {
    sourcebook_id: "FTNET_RETNINGSLINJER",
    reference: "GL FTNET 2022/DORA",
    title: "Retningslinjer for digital operationel modstandsdygtighed (DORA)",
    text: "Disse retningslinjer implementerer kravene i Europa-Parlamentets og Raadets forordning (EU) 2022/2554 om digital operationel modstandsdygtighed i den finansielle sektor (DORA) i dansk tilsynspraksis. Finansielle enheder skal etablere et ICT-risikostyringssystem med klart definerede roller og ansvar, mapning af ICT-aktiver og kritiske funktioner, krav til forretningskontinuitet og katastrofeopretning, og periodisk test af digital modstandsdygtighed. Udbydere af kritiske tredjepartstjenester er underlagt direktetilsyn af europaeiske tilsynsmyndigheder. Finanstilsynet forventer, at finansielle enheder forbereder sig paa fuld DORA-compliance inden januar 2025.",
    type: "retningslinje",
    status: "in_force",
    effective_date: "2023-01-16",
    chapter: "1",
    section: "1",
  },
  {
    sourcebook_id: "FTNET_RETNINGSLINJER",
    reference: "GL FTNET 2021/ESG",
    title: "Retningslinjer for haandtering af baredygtigheds- og klimarisici",
    text: "Disse retningslinjer beskriver Finanstilsynets forventninger til haandtering af baredygtigheds- og klimarisici i finansielle virksomheder. Virksomheder skal integrere miljomaessige, sociale og ledelsesmaessige (ESG) risici i deres overordnede risikoramme og ICAAP/ILAAP. Finanstilsynet forventer, at virksomheder kortlaegger eksponering mod fysiske og omstillingsrisici forbundet med klimaforandringer, og at klimascenarier inddrages i stresstests. Disclosure-forpligtelser i henhold til forordning (EU) 2019/2088 (SFDR) og (EU) 2020/852 (taksonomiforordningen) skal overholdes. Finanstilsynet vil overvage virksomhedernes fremskridt og inddrage ESG-risici i den loebende tilsynsproces.",
    type: "retningslinje",
    status: "in_force",
    effective_date: "2021-11-01",
    chapter: "1",
    section: "1",
  },
  {
    sourcebook_id: "FTNET_RETNINGSLINJER",
    reference: "GL FTNET 2023/AI",
    title: "Retningslinjer for anvendelse af kunstig intelligens i finansielle virksomheder",
    text: "Finanstilsynet forventer, at finansielle virksomheder, der anvender kunstig intelligens (AI) og maskinlaering i kritiske forretningsprocesser, sikrer tilstraekkelig styring, gennemsigtighed og forklarbarhed. Virksomhedens ledelse er ansvarlig for at forsta og overvage AI-systemers beslutninger og risici. Virksomheder skal foretage en risikovurdering af AI-systemer inden anvendelse, herunder vurdere risici for bias, datatab, og utilsigtede konsekvenser for kunder og finansiel stabilitet. AI-modeller skal valideres og overvages loebende for modelskift og performance-forringelse. Kravene er i overensstemmelse med den kommende EU AI-forordning og EBA-retningslinjer for intern styring.",
    type: "retningslinje",
    status: "in_force",
    effective_date: "2023-09-01",
    chapter: "1",
    section: "1",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

// -- Sample enforcement actions --

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "Danske Bank A/S",
    reference_number: "FTNET/2022/001",
    action_type: "fine",
    amount: 50_000_000,
    date: "2022-05-12",
    summary:
      "Finanstilsynet paabod Danske Bank A/S at betale en bode paa 50 mio. kr. for alvorlige mangler i bankens AML/CFT-styringssystem. Finanstilsynet konstaterede, at banken i en lang periode ikke havde haft tilstraekkelige procedurer for kundekendskab, loebende overvaagning og indberetning af mistankefulde transaktioner i filialnetvaerket i Estland. Banken havde endvidere ikke reageret adaekvaet paa interne advarsler om mistankefuld aktivitet. Boden afspejler overtraedelsernes alvor, varighed og de betydelige risici for den finansielle sektors integritet.",
    sourcebook_references: "BEK nr 567 af 02/06/2020",
  },
  {
    firm_name: "Finanshuset Nord A/S",
    reference_number: "FTNET/2023/007",
    action_type: "restriction",
    amount: 0,
    date: "2023-08-21",
    summary:
      "Finanstilsynet udstedte et paabud til Finanshuset Nord A/S om at bringe IT-sikkerhedsniveauet i overensstemmelse med kravene i vejledningen om IT-sikkerhed inden for seks maaneder. Finanstilsynet konstaterede ved inspektion alvorlige mangler i virksomhedens adgangskontrol, krypteringspraksis, og manglende penetrationstest af kritiske systemer. Virksomheden fik forbud mod at lancere nye digitale produkter, indtil de paakraevede IT-sikkerhedsforbedrings er dokumenteret implementeret og godkendt af Finanstilsynet.",
    sourcebook_references: "VEJ nr 9152 af 07/08/2019",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// -- Summary --

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
