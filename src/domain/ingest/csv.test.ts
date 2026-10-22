import { describe, expect, it } from 'vitest';
import { batches, BATCH_SIZE, lineBatches, buildPayload, checkRows, duplicateTargets, MAX_IMPORT_ROWS, parseCsv, rejectsCsvRows, suggestMapping, summarize } from './csv';
import { mapPayload } from './mapPayload';

describe('lecture du fichier', () => {
  it('séparateur « ; » (Excel français), BOM et fins de ligne Windows', () => {
    const p = parseCsv('﻿Nom;Téléphone;Email\r\nDupont;06 12 34 56 78;jean@x.fr\r\nMartin;0611111111;\r\n');
    expect(p.delimiter).toBe(';');
    expect(p.headers).toEqual(['Nom', 'Téléphone', 'Email']);
    expect(p.rows).toEqual([['Dupont', '06 12 34 56 78', 'jean@x.fr'], ['Martin', '0611111111', '']]);
  });
  it('séparateur « , » et tabulation détectés', () => {
    expect(parseCsv('a,b,c\n1,2,3').delimiter).toBe(',');
    expect(parseCsv('a\tb\tc\n1\t2\t3').delimiter).toBe('\t');
    expect(parseCsv('a\tb\tc\n1\t2\t3').rows).toEqual([['1', '2', '3']]);
  });
  it('guillemets : séparateur, guillemets doublés et retour à la ligne dans une cellule', () => {
    const p = parseCsv('Nom;Adresse\n"Dupont; Jean";"12 rue ""des Lilas""\n69003 Lyon"');
    expect(p.rows).toEqual([['Dupont; Jean', '12 rue "des Lilas"\n69003 Lyon']]);
  });
  it('le séparateur d’une cellule entre guillemets ne compte pas dans la détection', () => {
    expect(parseCsv('"a,b,c,d";e;f\n1;2;3').delimiter).toBe(';');
  });
  it('lignes vides ignorées et comptées ; espaces autour des cellules retirés', () => {
    const p = parseCsv('a;b\n\n 1 ; 2 \n;;\n3;4');
    expect(p.rows).toEqual([['1', '2'], ['3', '4']]);
    expect(p.skippedEmpty).toBe(2);
  });
  it('en-têtes vides ou en double : rendus uniques', () => {
    expect(parseCsv('Nom;;Nom\n1;2;3').headers).toEqual(['Nom', 'Colonne 2', 'Nom (2)']);
  });
  it('plafond de lignes : le surplus est annoncé', () => {
    const body = Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, i) => `n${i}`).join('\n');
    const p = parseCsv(`Nom\n${body}`);
    expect(p.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(p.truncated).toBe(5);
  });
  it('fichier vide : aucun en-tête, aucune ligne', () => {
    expect(parseCsv('')).toMatchObject({ headers: [], rows: [] });
    expect(parseCsv('\n\n')).toMatchObject({ headers: [], rows: [] });
  });
  it('dernière ligne sans retour à la ligne finale', () => {
    expect(parseCsv('a;b\n1;2').rows).toEqual([['1', '2']]);
  });
});

describe('rapprochement des colonnes', () => {
  it('reconnaît les en-têtes usuels, accents et casse ignorés', () => {
    expect(suggestMapping(['Prénom', 'NOM', 'Téléphone', 'E-mail', 'Adresse', 'Code postal', 'Ville', 'Produit', 'Campagne', 'Consentement'])).toEqual(['firstName', 'lastName', 'phone', 'email', 'addressLine', 'postalCode', 'city', 'productCode', 'campaignName', 'consent']);
  });
  it('synonymes de la réception (Pabbly, Meta) et variantes courantes', () => {
    expect(suggestMapping(['full_name', 'phone_number', 'email_address', 'zip', 'leadgen_id', 'portable'])).toEqual(['fullName', 'phone', 'email', 'postalCode', 'externalId', '']);
  });
  it('colonne inconnue : ignorée ; un champ n’est proposé qu’une fois', () => {
    expect(suggestMapping(['Commentaire', 'Téléphone', 'Mobile'])).toEqual(['', 'phone', '']);
  });
  it('champs choisis plusieurs fois', () => {
    expect(duplicateTargets(['phone', 'email', 'phone', ''])).toEqual(['phone']);
    expect(duplicateTargets(['phone', 'email', ''])).toEqual([]);
  });
});

describe('payload d’une ligne', () => {
  const mapping = ['firstName', 'lastName', 'phone', 'email', '', 'campaignName'];
  it('les champs choisis, avec les noms que lit la réception', () => {
    const p = buildPayload(['Jean', 'Dupont', '06 12 34 56 78', 'jean@x.fr', 'ignoré', 'PAC IDF'], mapping);
    expect(p).toEqual({ firstName: 'Jean', lastName: 'Dupont', phone: '06 12 34 56 78', email: 'jean@x.fr', campaign: 'PAC IDF' });
    const m = mapPayload(p, {});
    expect(m.fullName).toBe('Jean Dupont');
    expect(m.phone).toBe('+33612345678');
    expect(m.campaign.name).toBe('PAC IDF');
  });
  it('cellules vides non transmises', () => {
    expect(buildPayload(['', 'Dupont', '', 'a@x.fr', '', ''], mapping)).toEqual({ lastName: 'Dupont', email: 'a@x.fr' });
  });
  it('campagne et produit par défaut : jamais au détriment d’une cellule renseignée', () => {
    expect(buildPayload(['J', 'D', '0611111111', '', '', ''], mapping, { campaignId: 'c1', productCode: 'PAC' })).toMatchObject({ campaignId: 'c1', productCode: 'PAC' });
    const own = buildPayload(['J', 'D', '0611111111', '', '', 'Ma campagne'], mapping, { campaignId: 'c1' });
    expect(own.campaign).toBe('Ma campagne');
    expect(own.campaignId).toBeUndefined();
  });
});

describe('contrôle avant envoi (mêmes règles que la réception)', () => {
  const rows: Record<string, string>[] = [
    { firstName: 'Jean', lastName: 'Dupont', phone: '06 12 34 56 78', email: 'jean@x.fr' },
    { firstName: 'Anne', lastName: 'Martin' },
    { firstName: 'Paul', lastName: 'Roux', phone: '12345' },
    { firstName: 'Luc', lastName: 'Petit', phone: '0612345678' },
    { phone: '0699999999' },
    { firstName: 'Zoé', lastName: 'Blanc', phone: '123', email: 'zoe@x.fr' },
  ];
  const c = checkRows(rows);
  it('ligne complète : correcte, numérotée à partir de la ligne 2 (l’en-tête est la ligne 1)', () => {
    expect(c[0]).toMatchObject({ line: 2, status: 'ok', phone: '+33612345678', email: 'jean@x.fr', name: 'Jean Dupont' });
  });
  it('ni téléphone ni email : erreur, la ligne ne sera pas envoyée', () => {
    expect(c[1]).toMatchObject({ line: 3, status: 'error' });
    expect(c[1].problems[0]).toMatch(/Aucun téléphone ni email/);
  });
  it('téléphone illisible sans email : erreur, avec la valeur lue', () => {
    expect(c[2].status).toBe('error');
    expect(c[2].problems[0]).toMatch(/Ni téléphone ni email exploitable/);
  });
  it('même téléphone qu’une ligne précédente : avertissement qui nomme la ligne', () => {
    expect(c[3].status).toBe('warning');
    expect(c[3].problems.join(' ')).toMatch(/Même téléphone que la ligne 2/);
  });
  it('nom manquant : avertissement seulement', () => {
    expect(c[4]).toMatchObject({ status: 'warning', line: 6 });
    expect(c[4].problems.join(' ')).toMatch(/Nom manquant/);
  });
  it('téléphone illisible mais email valide : avertissement, la ligne passe', () => {
    expect(c[5].status).toBe('warning');
    expect(c[5].problems.join(' ')).toMatch(/Téléphone illisible/);
  });
  it('même email que la ligne précédente', () => {
    const d = checkRows([{ firstName: 'A', lastName: 'B', email: 'x@y.fr' }, { firstName: 'C', lastName: 'D', email: 'X@Y.fr' }]);
    expect(d[1].problems.join(' ')).toMatch(/Même email que la ligne 2/);
  });
  it('synthèse', () => expect(summarize(c)).toEqual({ total: 6, ok: 1, warning: 3, error: 2 }));
});

describe('lots et refus', () => {
  it('lots de taille fixe, dernier lot plus court', () => {
    const b = batches(Array.from({ length: BATCH_SIZE * 2 + 3 }, (_, i) => i));
    expect(b.map((x) => x.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 3]);
    expect(batches([])).toEqual([]);
  });
  it('lots de lignes consécutives : un trou (ligne en erreur) démarre un nouveau lot', () => {
    const items = [2, 3, 4, 6, 7, 10].map((line) => ({ line }));
    expect(lineBatches(items).map((l) => l.map((x) => x.line))).toEqual([[2, 3, 4], [6, 7], [10]]);
    expect(lineBatches(Array.from({ length: BATCH_SIZE + 2 }, (_, i) => ({ line: i + 2 }))).map((l) => l.length)).toEqual([BATCH_SIZE, 2]);
    expect(lineBatches([])).toEqual([]);
  });
  it('fichier des refus : mêmes colonnes, numéro de ligne et motif', () => {
    const out = rejectsCsvRows(['Nom', 'Tél'], [['A', '1'], ['B', '2'], ['C', '3']], [{ line: 3, reason: 'Aucun téléphone ni email.' }, { line: 4, reason: 'Source inconnue' }]);
    expect(out[0]).toEqual(['Nom', 'Tél', 'Ligne', 'Motif du refus']);
    expect(out[1]).toEqual(['B', '2', 3, 'Aucun téléphone ni email.']);
    expect(out[2]).toEqual(['C', '3', 4, 'Source inconnue']);
  });
});
