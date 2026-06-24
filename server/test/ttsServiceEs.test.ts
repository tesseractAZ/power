import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verbalizeForTtsEs, buildAlertMessageEs, priorityAnnouncementPrefixEs } from '../src/ttsService.js';
import { socAlarmMessageEs, socAlarmAdvisoryEs } from '../src/batterySocAlarm.js';
import { runwayAlarmMessageEs } from '../src/runwayAlarm.js';
import type { Alert } from '../src/alerts.js';
import type { RunwayAlarmInput } from '../src/runwayAlarm.js';

/* v0.62.0 — Spanish (Latin American) bilingual second pass. These pin the
 * Spanish wording + the structure (framing fully Spanish; unknown alert
 * families fall back to the English title; numbers interpolate correctly). */

const mkAlert = (o: Partial<Alert> & { id: string; severity: Alert['severity']; category: Alert['category'] }): Alert =>
  ({ device: 'GBC0314', title: '', detail: '', ...o } as Alert);

const runway = (o: Partial<RunwayAlarmInput>): RunwayAlarmInput =>
  ({ generatedAt: 0, hoursToReserve: null, hoursToEmpty: null, unavailable: null, ...o });

test('verbalizeForTtsEs — symbols/percent → Spanish words, and IDEMPOTENT', () => {
  assert.equal(verbalizeForTtsEs('al 20%'), 'al 20 por ciento');
  assert.equal(verbalizeForTtsEs('≥ 70'), 'mayor o igual a 70');
  assert.equal(verbalizeForTtsEs('86°F'), '86 grados Fahrenheit');
  const once = verbalizeForTtsEs('reserva al 4% ≤ 5');
  assert.equal(verbalizeForTtsEs(once), once, 'running twice changes nothing');
});

test('priorityAnnouncementPrefixEs — critical doubles for emphasis (like the English)', () => {
  assert.equal(priorityAnnouncementPrefixEs('critical'), 'Alarma crítica. Alarma crítica.');
  assert.equal(priorityAnnouncementPrefixEs('high'), 'Alarma de alta prioridad.');
  assert.equal(priorityAnnouncementPrefixEs('medium'), 'Alarma de prioridad media.');
  assert.equal(priorityAnnouncementPrefixEs('low'), 'Aviso de baja prioridad.');
});

test('buildAlertMessageEs — green is the Spanish all-clear', () => {
  assert.equal(buildAlertMessageEs('green', []), 'Todo despejado. Todas las estaciones reportan normalidad.');
});

test('buildAlertMessageEs — known family: Spanish framing + Spanish title + Spanish location/ack/repeat', () => {
  const a = mkAlert({
    id: 'soh-crit-GBC0314-2', severity: 'critical', category: 'Battery', priority: 'critical',
    title: 'Pack health critical', detail: 'Pack S O H is 68 percent, below 70 percent floor.',
    coreNum: 3, packNum: 2,
  });
  const es = buildAlertMessageEs('red', [a]);
  assert.match(es, /^Alarma crítica\. Alarma crítica\./, 'critical prefix doubled');
  assert.match(es, /Sistema de baterías/, 'category in Spanish');
  assert.match(es, /Core tres batería dos/, 'location in Spanish (Core kept, numbers/pack Spanish)');
  assert.match(es, /Salud de batería crítica/, 'title translated via the id-prefix map');
  assert.match(es, /Confirme en la consola\./, 'Spanish acknowledge (critical)');
  assert.match(es, /Repito\./, 'Spanish repeat');
});

test('buildAlertMessageEs — unknown family: Spanish framing, English TITLE fallback (no mistranslation)', () => {
  const a = mkAlert({
    id: 'totally-new-condition-xyz', severity: 'warning', category: 'Solar',
    title: 'Brand new warning', detail: 'Something at 5 percent.',
  });
  const es = buildAlertMessageEs('yellow', [a]);
  assert.match(es, /Sistema solar/, 'category still Spanish');
  assert.match(es, /Brand new warning/, 'untranslated family keeps the English title');
});

test('socAlarmMessageEs — interpolates the percent in Spanish; critical adds the restore action', () => {
  assert.equal(socAlarmMessageEs({ pct: 20, priority: 'medium' }),
    'Alarma de prioridad media. Reserva de respaldo al 20 por ciento.');
  assert.match(socAlarmMessageEs({ pct: 2, priority: 'critical' }), /Restablezca la carga de inmediato\./);
  assert.match(socAlarmAdvisoryEs(40), /Reserva de respaldo al 40 por ciento\. Ahora se está tomando energía de la red; no se requiere acción\./);
});

test('runwayAlarmMessageEs — Spanish projection text with correct hour pluralization', () => {
  const crit = runwayAlarmMessageEs(runway({ hoursToEmpty: 1 }), 'critical');
  assert.match(crit, /^Alarma crítica\. Alarma crítica\./);
  assert.match(crit, /\b1 hora\b/, 'singular "1 hora", not "1 horas"');
  assert.match(crit, /Reduzca la carga de inmediato/);

  const med = runwayAlarmMessageEs(runway({ hoursToReserve: 5 }), 'medium');
  assert.match(med, /^Alarma de prioridad media\./);
  assert.match(med, /\b5 horas\b/, 'plural for >1');
  assert.match(med, /nivel mínimo/);

  // At/below the floor WITH the grid backstopping → calm advisory, no shed call.
  const onGrid = runwayAlarmMessageEs(
    runway({ backupRemainingKwh: 5, backupReserveKwh: 9 }), 'critical', { backstopping: true } as any);
  assert.match(onGrid, /^Aviso\./);
  assert.match(onGrid, /no se requiere acción/);
});
