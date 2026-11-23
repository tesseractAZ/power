#!/usr/bin/env node
/**
 * mutate-on-fate.mjs — committed harness for v1.209.0 (part D): the ledger records whether the force-charge ON took.
 *
 * Until this release a ledger row kept only that an ON was sent (force_charge_on_at_ms). A night whose ON never took on any
 * slot and a night that force-charged read the same. Six raw stamps of the night's record now sit beside force_charge_mode
 * (force_charge_on_failed_at_ms, force_charge_on_failed_slots, force_charge_on_left_out, force_charge_on_retries,
 * force_charge_on_slots, force_charge_on_verified_at_ms), one pure derivation gives them (nightForceCharge.ts
 * forceChargeOnFateColumns), a second gives the ON's own two columns again beside every fate stamp
 * (forceChargeOnStampColumns), a third reads a row's verdict (forceChargeOnFateOf), and one helper of index.ts
 * (stampForceChargeOnFate) writes them from six places. Each mutant below removes or moves one rule of that record.
 *
 * (S) THE SLOT TEXT (slotColumnText): a list only; whole numbers only; 1 to the panel's slot count, each end; each slot
 *     once; ascending; joined by a bare comma; NULL for none, never an empty string.
 * (C) THE SIX COLUMNS (forceChargeOnFateColumns): nothing at all with no ON; each column from its own field of the record;
 *     a time only when it is a finite number; the failed slots only beside a failure time; the re-issue count a whole number
 *     of 0 or more and never NULL; 'write' names all six and is the default, 'omit' leaves out every NULL and nothing else.
 * (P) THE ON'S OWN TWO COLUMNS AGAIN (forceChargeOnStampColumns): nothing without a finite ON time (0 is a time); the mode
 *     only when it is 'cost' or 'line', as the record holds it, and its key absent otherwise; the ON time beside it.
 * (V) THE VERDICT (forceChargeOnFateOf): 'none' needs BOTH the ON time and the count NULL; an ON time with no count is
 *     'notRecorded'; a count with no ON time is judged by its fate; verified wins over failed; a count of 0 and a time of 0
 *     are values; a key that is absent reads as NULL.
 * (R) THE SCHEMA (recorder.ts CHARGE_CYCLE_LEDGER_SCHEMA): each of the six entries present, with its type, in its place
 *     directly after force_charge_mode.
 * (H) THE HELPER (index.ts stampForceChargeOnFate): the record is this leg's only with the same night AND the same window;
 *     a record that moved on is skipped, except at a final stamp, where the leg's own copy is stamped; the live record while
 *     it holds the leg; the ON's two columns and the fate both from that one record, to the leg's own row; `nulls` handed
 *     on; nothing thrown into the tick, and a failure said. And the two rules of stampLegOutcome the helper leans on: a
 *     stamp with no column never reaches the recorder (a bare upsert makes a row), and a leg stamps its own role's columns
 *     (a backup leg has none of these).
 * (X) THE SIX CALL SITES (index.ts runForceChargeTick, runTrailingLegTick): each present; 'write' at the ON and 'omit' at the
 *     other five; the live record handed over, never the copy the tick read at its start; the ON's fate a write of its own
 *     after the ON's own stamp; the verify and the failure stamped after the record persist, the failure before anything is
 *     awaited; the re-issue stamped after the hand-back and never final; the two first OFFs final, and stamped as the leg the
 *     tick read.
 * (N) THE PLAN ROW names no fate column (index.ts recordNightPlanRow): a re-issued plan leaves the fate as it was.
 * (D) THE READERS the release leaves alone still key on the ON stamp alone: forceChargeStateAt (index.ts), the readiness
 *     gate (nightChargeGate.ts) and the mid-day hour mask (nightLedgerScoring.ts) read no fate column.
 *
 *   node scripts/mutate-on-fate.mjs [--only <id prefix>]
 *
 * ★ Every id starts OFT- (no other harness uses it). Anchor-asserted (each anchor matches exactly once); every mutant must
 *   TYPECHECK (one that does not is reported INVALID and fails the run); the subset alone decides (no full-suite step), and
 *   the failing tests of each mutant are named. Run with MUTATE_CONCURRENCY=3, on a GREEN tree.
 *
 * index.ts starts a server when imported, so no test can import it. The helper (H) is nevertheless RUN: the test file takes
 * the code of stampLegOutcome and stampForceChargeOnFate from the source and executes it over a real recorder. The call
 * sites (X) and the plan row (N) are held by the source checks of test/ledgerOnFate.test.ts.
 *
 * Not written, because no input tells them apart:
 *  - slotColumnText: the `slots == null` half beside Array.isArray (Array.isArray(null) is false); a sort with no
 *    comparator (the valid slots are single digits, so the text order is the number order).
 *  - forceChargeOnFateColumns: `typeof v === 'number'` beside Number.isFinite in the time reader and in the count
 *    (Number.isFinite is false for everything that is not a number); `retries > 0` against `retries >= 0` (floor(0) is 0,
 *    the fallback); `failedAtMs != null` against `!== null` (the time reader gives a number or null); `v != null` against
 *    `v !== null` in the 'omit' filter (no column is ever undefined).
 *  - forceChargeOnStampColumns: `typeof at !== 'number'` beside Number.isFinite, for the same reason.
 *
 * Not written, because the row is the same either way (the test file's checks of the source text and of the order of the
 * keys would fail on each of them all the same; what they hold is the form, not what a reader of the ledger is told):
 *  - stampForceChargeOnFate: the order of the two spreads (they name no column in common, and the recorder sorts the
 *    columns it is given); `if (leg.day == null) return;` (stampLegOutcome returns on the same test, and
 *    runForceChargeTick never works a record with no night).
 *  - The call sites: `final` at the ON (the copy the tick read holds no ON, so the leg's own copy stamps nothing), at the
 *    verify and at the failure (nothing is awaited between the tick's read of the record and the stamp, so the record
 *    cannot have moved on); the live record against the tick's copy at the two first OFFs (no ON handler ran on that
 *    tick, so the two hold the same fate).
 * One mutant of that kind IS written, X-on-v (the fate stamped ahead of the ON's own stamp): the release states that order.
 *
 * Not written, and NOT equivalent: the no-ON test of forceChargeOnFateColumns made the finite test forceChargeOnStampColumns
 * has. The two differ as specified (the fate asks that the ON time is not NULL, as the record's own status does; the ON's
 * two columns ask for a finite ON time), and only an ON time that is set and is no finite number tells them apart. No path
 * gives a record one (the field is the clock's, and a damaged one is NULL after a load), and test/ledgerOnFate.test.ts
 * leaves that input unasserted on purpose, so such a mutant survives. A decision either way belongs in that file first.
 *
 * Written, though no record of the add-on's tells them apart (each time is the clock's, never 0): C-ii(b), C-iii(b) and
 * C-vii(b) (a time of 0 read as no time by the six columns), held by the time-of-0 case of the test file beside P-iii
 * and V-vii, V-viii, V-xiv, V-xv (the same rule in the other derivation and in the verdict). And C-ii, C-iii, C-xii to
 * C-xv, P-i, P-ii, P-vi, S-i to S-iii and S-v (a field that is damaged or of another kind), held by its hostile-record cases.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(REPO, 'server');
const NFC = resolve(SERVER, 'src/nightForceCharge.ts');
const REC = resolve(SERVER, 'src/recorder.ts');
const IDX = resolve(SERVER, 'src/index.ts');
const GATE = resolve(SERVER, 'src/nightChargeGate.ts');
const SCORING = resolve(SERVER, 'src/nightLedgerScoring.ts');

const SUBSET = [
  'test/ledgerOnFate.test.ts',
];

// ── anchors more than one mutant changes ──

// nightForceCharge.ts slotColumnText
const SLOT_VALID = '  const valid = slots.filter((n) => Number.isInteger(n) && n >= 1 && n <= SHP2_SOURCE_SLOTS);';
const SLOT_TEXT = "  const text = [...new Set(valid)].sort((a, b) => a - b).join(',');";
const SLOT_NONE = '  return text.length > 0 ? text : null;';
// nightForceCharge.ts forceChargeOnFateColumns
const FATE_NO_ON = '  if (s.forceChargeOnAtMs == null) return {};';
const FATE_TIME = "  const at = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);";
const FATE_FAILED_AT = '  const failedAtMs = at(s.forceChargeOnFailedAtMs);';
const FATE_FAILED_SLOTS = '    force_charge_on_failed_slots: failedAtMs != null ? slotColumnText(s.forceChargeOnFailedSlots) : null,';
const FATE_LEFT_OUT = '    force_charge_on_left_out: slotColumnText(s.forceChargeLeftOutSlots),';
const FATE_RETRIES = "    force_charge_on_retries: typeof retries === 'number' && Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0,";
const FATE_SLOTS = '    force_charge_on_slots: slotColumnText(s.forceChargeSlots),';
const FATE_VERIFIED_AT = '    force_charge_on_verified_at_ms: at(s.forceChargeOnVerifiedAtMs),';
const FATE_OMIT = '  return Object.fromEntries(Object.entries(all).filter(([, v]) => v != null)) as Partial<ForceChargeOnFateColumns>;';
// nightForceCharge.ts forceChargeOnStampColumns
const STAMP_FINITE = "  if (typeof at !== 'number' || !Number.isFinite(at)) return {};";
const STAMP_MODE_TEST = "  return s.forceChargeMode === 'cost' || s.forceChargeMode === 'line'";
const STAMP_MODE_COLS = '    ? { force_charge_on_at_ms: at, force_charge_mode: s.forceChargeMode } : { force_charge_on_at_ms: at };';
// nightForceCharge.ts forceChargeOnFateOf
const VERDICT_COUNT = "  if (row.force_charge_on_retries == null) return row.force_charge_on_at_ms == null ? 'none' : 'notRecorded';";
const VERDICT_VERIFIED = "  if (row.force_charge_on_verified_at_ms != null) return 'verified';";
const VERDICT_FAILED = "  if (row.force_charge_on_failed_at_ms != null) return 'failed';";
const VERDICT_BOTH = "  if (row.force_charge_on_verified_at_ms != null) return 'verified';\n" +
  "  if (row.force_charge_on_failed_at_ms != null) return 'failed';";
// recorder.ts CHARGE_CYCLE_LEDGER_SCHEMA
const SCHEMA_MODE = "  ['force_charge_mode', 'TEXT'],\n" +
  "  // v1.209.0 — the ON's fate, six raw stamps of the night's record: see NightLedgerRow.force_charge_on_retries.\n";
const SCHEMA_L1 = "  ['force_charge_on_failed_at_ms', 'INTEGER'], ['force_charge_on_failed_slots', 'TEXT'], ['force_charge_on_left_out', 'TEXT'],\n";
const SCHEMA_L2 = "  ['force_charge_on_retries', 'INTEGER'], ['force_charge_on_slots', 'TEXT'], ['force_charge_on_verified_at_ms', 'INTEGER'],\n";
const SCHEMA_L3 = "  ['chg_max_soc_pct', 'REAL'], ['pack_accept_kw', 'REAL'],";
const SCHEMA_FAILED_AT = "['force_charge_on_failed_at_ms', 'INTEGER'],";
const SCHEMA_FAILED_SLOTS = "['force_charge_on_failed_slots', 'TEXT'],";
const SCHEMA_LEFT_OUT = "['force_charge_on_left_out', 'TEXT'],";
const SCHEMA_RETRIES = "['force_charge_on_retries', 'INTEGER'],";
const SCHEMA_SLOTS = "['force_charge_on_slots', 'TEXT'],";
const SCHEMA_VERIFIED_AT = "['force_charge_on_verified_at_ms', 'INTEGER'],";
// index.ts stampForceChargeOnFate
const HELPER_HELD = '    const held = live.day === leg.day && live.windowStartMs === leg.windowStartMs;';
const HELPER_SKIP = '    if (!held && !final) {';
const HELPER_FROM = '    const from = held ? live : leg;';
const HELPER_WRITE = '    stampLegOutcome(leg, { ...forceChargeOnStampColumns(from), ...forceChargeOnFateColumns(from, nulls) });';
const HELPER_CATCH = "  } catch (e: any) {\n" +
  "    app.log.warn(`night-charge: ledger stamp of the force-charge ON's fate failed for ${leg.day} (${e?.message ?? e})`);";
// index.ts runForceChargeTick, the ON
const ON_OWN = '    stampLegOutcome(state, { force_charge_on_at_ms: nowMs, force_charge_mode: onMode });';
const ON_NOTE = " // v1.189.0 — the ledger's force-charge stamps; v1.200.0 — and its mode\n" +
  "    // v1.209.0 — and the ON's fate as it stands at the ON: the slots it was sent to, the slots left out, the re-issue count\n" +
  "    // (0, the mark that the fate was recorded) and NULL for a verdict not yet reached. A write of ITS OWN, after the stamp\n" +
  "    // above: one failed upsert must not take force_charge_on_at_ms with it (the readiness gate reads that as \"never\n" +
  "    // switched on\"). From the live record, which holds the ON since the write-ahead persist; `state` was read before it.\n";
const ON_FATE = "    stampForceChargeOnFate(state, nightActuationMem, 'write');";
// index.ts runForceChargeTick, the verify
const VERIFY_PERSIST = '    persistNightActuation({ ...nightActuationMem, forceChargeOnVerifiedAtMs: nowMs });\n' +
  "    // v1.209.0 — the ledger's row learns the ON took, directly after the record does (a verify after the failure warning\n";
const VERIFY_FATE = "    // keeps the failure's time beside it: verified wins when the row is read).\n" +
  "    stampForceChargeOnFate(state, nightActuationMem, 'omit');";
// index.ts runForceChargeTick, the re-issue
const RETRY_HANDBACK = '    persistNightActuation({\n' +
  '      ...nightActuationMem,\n' +
  '      forceChargeOnLastAttemptMs: Date.now(),\n' +
  '      ...(unspent ? { forceChargeOnRetries: Math.max(0, nightActuationMem.forceChargeOnRetries - 1) } : {}),\n' +
  '    });\n';
const RETRY_NOTE = "    // v1.209.0 — the ledger's re-issue count, AFTER the hand-back above: the record's own figure as it now stands (this\n" +
  '    // handler can run again, and its count goes down as well as up), never an increment and never the count the tick read\n';
const RETRY_FATE = '    // at its start. From the live record of this same leg.\n' +
  "    stampForceChargeOnFate(state, nightActuationMem, 'omit');";
// index.ts runForceChargeTick, the failure verdict
const FAILED_PERSIST = '    persistNightActuation({ ...nightActuationMem, forceChargeOnFailedAtMs: nowMs, forceChargeOnFailedSlots: [...action.slots] });\n';
const FAILED_ALL = '    const all = partialForceChargeOnFailureSlots({ forceChargeSlots: state.forceChargeSlots, forceChargeOnFailedSlots: action.slots }) == null;\n' +
  "    // v1.209.0 — the ledger's row learns the failure verdict and its slots from the record just persisted, BEFORE the\n";
const FAILED_FATE = '    // awaited push below: a restart during the push would lose a stamp placed after it, and this handler never runs again.\n' +
  "    stampForceChargeOnFate(state, nightActuationMem, 'omit');";
// index.ts, the two first OFFs
const OFF_FATE = "      stampForceChargeOnFate(state, nightActuationMem, 'omit', true);";
const TRAIL_FATE = "      stampForceChargeOnFate(t, cur(), 'omit', true);";

/** The six schema entries as recorder.ts lists them, and the list's fate block with one of them moved to the END of the
 *  list (after pack_accept_kw), away from force_charge_mode. */
const FATE_ENTRIES = [
  "['force_charge_on_failed_at_ms', 'INTEGER']", "['force_charge_on_failed_slots', 'TEXT']", "['force_charge_on_left_out', 'TEXT']",
  "['force_charge_on_retries', 'INTEGER']", "['force_charge_on_slots', 'TEXT']", "['force_charge_on_verified_at_ms', 'INTEGER']",
];
const fateEntryLast = (k) => `  ${FATE_ENTRIES.filter((_, i) => i !== k).join(', ')},\n  ['chg_max_soc_pct', 'REAL'], ['pack_accept_kw', 'REAL'], ${FATE_ENTRIES[k]}, /* MUTANT */`;

const MUTANTS = [
  // ══ (S) the slot text ══
  {
    id: 'OFT-S-i. ★★★ a slot list that is no list is read',
    file: NFC,
    find: '  if (slots == null || !Array.isArray(slots)) return null;',
    to: '  if (slots == null) return null; /* MUTANT */',
    why: 'A record whose slot field is no list throws inside the derivation: the whole fate stamp is lost and the row reads "not recorded" for an ON whose fate was known.',
  },
  {
    id: 'OFT-S-ii. ★★★ a slot need not be a whole number',
    file: NFC,
    find: SLOT_VALID,
    to: '  const valid = slots.filter((n) => n >= 1 && n <= SHP2_SOURCE_SLOTS); /* MUTANT */',
    why: 'The slot text carries "1.5" or a quoted "2": a value that is no slot number reaches a column the status route serves.',
  },
  {
    id: 'OFT-S-iii. ★★★ the range has no lower end',
    file: NFC,
    find: SLOT_VALID,
    to: '  const valid = slots.filter((n) => Number.isInteger(n) && n <= SHP2_SOURCE_SLOTS); /* MUTANT */',
    why: 'The row names slot 0 or slot -2 among the slots the ON was sent to: slots the panel does not have.',
  },
  {
    id: 'OFT-S-iv. ★★★ the range starts above slot 1',
    file: NFC,
    find: SLOT_VALID,
    to: '  const valid = slots.filter((n) => Number.isInteger(n) && n > 1 && n <= SHP2_SOURCE_SLOTS); /* MUTANT */',
    why: 'An ON sent to slots 1, 2 and 3 is recorded as sent to "2,3": slot 1 reads as never switched on.',
  },
  {
    id: 'OFT-S-v. ★★★ the range has no upper end',
    file: NFC,
    find: SLOT_VALID,
    to: '  const valid = slots.filter((n) => Number.isInteger(n) && n >= 1); /* MUTANT */',
    why: 'The row names slot 4 or slot 9: any whole number in a damaged record is served as a slot.',
  },
  {
    id: 'OFT-S-vi. ★★★ the range stops short of the last slot',
    file: NFC,
    find: SLOT_VALID,
    to: '  const valid = slots.filter((n) => Number.isInteger(n) && n >= 1 && n < SHP2_SOURCE_SLOTS); /* MUTANT */',
    why: 'An ON sent to slots 1, 2 and 3 is recorded as sent to "1,2", and a failure on slot 3 names no slot.',
  },
  {
    id: 'OFT-S-vii. ★★ a slot held twice is written twice',
    file: NFC,
    find: SLOT_TEXT,
    to: "  const text = [...valid].sort((a, b) => a - b).join(','); /* MUTANT */",
    why: 'The row reads "1,1,3,3": four entries for an ON sent to two slots.',
  },
  {
    id: 'OFT-S-viii. ★★ the slots are written in the record\'s order',
    file: NFC,
    find: SLOT_TEXT,
    to: "  const text = [...new Set(valid)].join(','); /* MUTANT */",
    why: 'The same three slots read "3,1,2" on one row and "1,2,3" on the next: two rows of the same ON do not compare equal.',
  },
  {
    id: 'OFT-S-ix. ★★ the slots are written descending',
    file: NFC,
    find: SLOT_TEXT,
    to: "  const text = [...new Set(valid)].sort((a, b) => b - a).join(','); /* MUTANT */",
    why: 'Every row reads "3,2,1" where the documented text is "1,2,3".',
  },
  {
    id: 'OFT-S-x. ★★ the slots are joined with a space after the comma',
    file: NFC,
    find: SLOT_TEXT,
    to: "  const text = [...new Set(valid)].sort((a, b) => a - b).join(', '); /* MUTANT */",
    why: 'The row reads "1, 2, 3": a query for the documented text "1,2,3" finds no night.',
  },
  {
    id: 'OFT-S-xi. ★★★ no slot is an empty string',
    file: NFC,
    find: SLOT_NONE,
    to: '  return text; /* MUTANT */',
    why: 'A night with no slot left out holds an empty string where the column is documented NULL: "IS NULL" misses it, and \'omit\' writes it over what the row held.',
  },
  {
    id: 'OFT-S-xii. ★★★ a single slot is no slot',
    file: NFC,
    find: SLOT_NONE,
    to: '  return text.length > 1 ? text : null; /* MUTANT */',
    why: 'One slot left out, or one slot failed, is recorded as NULL: the row says none was.',
  },

  // ══ (C) the six columns ══
  {
    id: 'OFT-C-i. ★★★ a record with no ON has a fate',
    file: NFC,
    find: FATE_NO_ON,
    to: '  /* MUTANT */',
    why: 'A night whose force-charge never started is stamped with a count of 0 and reads "unconfirmed": an ON that was never sent reads as one sent and not confirmed.',
  },
  {
    id: 'OFT-C-ii. ★★ the no-ON test misses a record from before the field',
    file: NFC,
    find: FATE_NO_ON,
    to: '  if (s.forceChargeOnAtMs === null) return {}; /* MUTANT */',
    why: 'A record with no ON-time field at all is stamped with a fate: the row reads "unconfirmed" for a night with no ON.',
  },
  {
    id: 'OFT-C-ii(b). ★★ an ON time of 0 is no ON',
    file: NFC,
    find: FATE_NO_ON,
    to: '  if (!s.forceChargeOnAtMs) return {}; /* MUTANT */',
    why: 'A record whose ON time is 0 gets no fate while its ON time is restored: "set" means not NULL in one derivation and truthy in the other, and the row reads "not recorded".',
  },
  {
    id: 'OFT-C-iii. ★★ a time that is not finite is written',
    file: NFC,
    find: FATE_TIME,
    to: "  const at = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : null); /* MUTANT */",
    why: 'A damaged verified time that is no instant is handed to the row as a time: the night reads "verified" with no moment a readback showed it.',
  },
  {
    id: 'OFT-C-iii(b). ★★ a time of 0 is no time',
    file: NFC,
    find: FATE_TIME,
    to: '  const at = (v: number | null | undefined): number | null => (v && Number.isFinite(v) ? v : null); /* MUTANT */',
    why: 'A verified time or a failure time of 0 is written as NULL: the verdict the record holds is not on the row, which reads "unconfirmed".',
  },
  {
    id: 'OFT-C-iv. ★★★ the failure time is the verified time',
    file: NFC,
    find: FATE_FAILED_AT,
    to: '  const failedAtMs = at(s.forceChargeOnVerifiedAtMs); /* MUTANT */',
    why: 'A verified ON carries a failure time, and an ON judged not applied carries none: the failed night reads "unconfirmed".',
  },
  {
    id: 'OFT-C-v. ★★★ the failure time is the ON time',
    file: NFC,
    find: FATE_FAILED_AT,
    to: '  const failedAtMs = at(s.forceChargeOnAtMs); /* MUTANT */',
    why: 'Every ON is stamped as judged not applied at the instant it was sent: every night never verified reads "failed".',
  },
  {
    id: 'OFT-C-vi. ★★★ the failure time is never written',
    file: NFC,
    find: '    force_charge_on_failed_at_ms: failedAtMs,',
    to: '    force_charge_on_failed_at_ms: null, /* MUTANT */',
    why: 'A night whose ON never took reads "unconfirmed": the verdict the record reached is not on the row.',
  },
  {
    id: 'OFT-C-vii. ★★★ the failed slots are written with no failure time',
    file: NFC,
    find: FATE_FAILED_SLOTS,
    to: '    force_charge_on_failed_slots: slotColumnText(s.forceChargeOnFailedSlots), /* MUTANT */',
    why: 'A row with no failure verdict names failed slots: slots are read as failed on a night no failure was judged.',
  },
  {
    id: 'OFT-C-vii(b). ★★ a failure time of 0 names no failed slot',
    file: NFC,
    find: FATE_FAILED_SLOTS,
    to: '    force_charge_on_failed_slots: failedAtMs ? slotColumnText(s.forceChargeOnFailedSlots) : null, /* MUTANT */',
    why: 'A failure stamped at 0 carries its time and no slot: the row reads "failed" and does not say on which slots.',
  },
  {
    id: 'OFT-C-viii. ★★★ the failed slots are the slots the ON was sent to',
    file: NFC,
    find: FATE_FAILED_SLOTS,
    to: '    force_charge_on_failed_slots: failedAtMs != null ? slotColumnText(s.forceChargeSlots) : null, /* MUTANT */',
    why: 'A failure on slot 2 alone is recorded as a failure on "1,2,3": a partial failure reads as the ON taking on no slot.',
  },
  {
    id: 'OFT-C-ix. ★★★ the failed slots are never written',
    file: NFC,
    find: FATE_FAILED_SLOTS,
    to: '    force_charge_on_failed_slots: null, /* MUTANT */',
    why: 'A failed night names no slot: which slots were still off at the verdict is not on the row.',
  },
  {
    id: 'OFT-C-x. ★★★ the slots left out are never written',
    file: NFC,
    find: FATE_LEFT_OUT,
    to: '    force_charge_on_left_out: null, /* MUTANT */',
    why: 'A night whose ON skipped slot 1 for the pool alarm reads as one that left no slot out.',
  },
  {
    id: 'OFT-C-xi. ★★★ the slots left out are the failed slots',
    file: NFC,
    find: FATE_LEFT_OUT,
    to: '    force_charge_on_left_out: slotColumnText(s.forceChargeOnFailedSlots), /* MUTANT */',
    why: 'Slots the ON was sent to and that failed are recorded as never sent ON, and the slot the pool alarm kept out is not named.',
  },
  {
    id: 'OFT-C-xii. ★★ the re-issue count is not floored',
    file: NFC,
    find: FATE_RETRIES,
    to: "    force_charge_on_retries: typeof retries === 'number' && Number.isFinite(retries) && retries > 0 ? retries : 0, /* MUTANT */",
    why: 'A damaged count of 1.5 is written as 1.5 re-issues.',
  },
  {
    id: 'OFT-C-xiii. ★★ the re-issue count is rounded up',
    file: NFC,
    find: FATE_RETRIES,
    to: "    force_charge_on_retries: typeof retries === 'number' && Number.isFinite(retries) && retries > 0 ? Math.ceil(retries) : 0, /* MUTANT */",
    why: 'A damaged count of 0.4 is written as one re-issue: the row claims a re-issue the record does not hold.',
  },
  {
    id: 'OFT-C-xiii(b). ★★ the re-issue count is rounded to the nearest',
    file: NFC,
    find: FATE_RETRIES,
    to: "    force_charge_on_retries: typeof retries === 'number' && Number.isFinite(retries) && retries > 0 ? Math.round(retries) : 0, /* MUTANT */",
    why: 'A damaged count of 1.5 is written as two re-issues: more than the record holds.',
  },
  {
    id: 'OFT-C-xiv. ★★ the re-issue count may be negative',
    file: NFC,
    find: FATE_RETRIES,
    to: "    force_charge_on_retries: typeof retries === 'number' && Number.isFinite(retries) ? Math.floor(retries) : 0, /* MUTANT */",
    why: 'A damaged count of -1 is written as -1 re-issues.',
  },
  {
    id: 'OFT-C-xv. ★★ the re-issue count may be infinite',
    file: NFC,
    find: FATE_RETRIES,
    to: "    force_charge_on_retries: typeof retries === 'number' && retries > 0 ? Math.floor(retries) : 0, /* MUTANT */",
    why: 'A count that is no finite number is handed to an INTEGER column as the count of re-issues.',
  },
  {
    id: 'OFT-C-xvi. ★★★ the re-issue count is NULL where no re-issue was made',
    file: NFC,
    find: FATE_RETRIES,
    to: "    force_charge_on_retries: typeof retries === 'number' && Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : null, /* MUTANT */",
    why: 'Every ON with no re-issue has a NULL count: the row reads "not recorded", the same as a row older than the columns.',
  },
  {
    id: 'OFT-C-xvii. ★★★ the re-issue count is always 0',
    file: NFC,
    find: FATE_RETRIES,
    to: '    force_charge_on_retries: 0, /* MUTANT */',
    why: 'An ON that was re-issued reads as taken or failed with no re-issue.',
  },
  {
    id: 'OFT-C-xviii. ★★★ the slots the ON was sent to are never written',
    file: NFC,
    find: FATE_SLOTS,
    to: '    force_charge_on_slots: null, /* MUTANT */',
    why: 'The row does not say which slots the ON went to: failed slots cannot be read against them.',
  },
  {
    id: 'OFT-C-xix. ★★★ the slots the ON was sent to are the slots left out',
    file: NFC,
    find: FATE_SLOTS,
    to: '    force_charge_on_slots: slotColumnText(s.forceChargeLeftOutSlots), /* MUTANT */',
    why: 'The row says the ON went to the one slot it was withheld from, and to no slot on a night that left none out.',
  },
  {
    id: 'OFT-C-xx. ★★★ the verified time is never written',
    file: NFC,
    find: FATE_VERIFIED_AT,
    to: '    force_charge_on_verified_at_ms: null, /* MUTANT */',
    why: 'A night whose ON was read back as applied reads "unconfirmed", and a late apply after a failure reads "failed".',
  },
  {
    id: 'OFT-C-xxi. ★★★ the verified time is the failure time',
    file: NFC,
    find: FATE_VERIFIED_AT,
    to: '    force_charge_on_verified_at_ms: failedAtMs, /* MUTANT */',
    why: 'A night whose ON was judged not applied reads "verified" (verified wins over failed), and a verified night reads "unconfirmed".',
  },
  {
    id: 'OFT-C-xxii. ★★★ the verified time is the ON time',
    file: NFC,
    find: FATE_VERIFIED_AT,
    to: '    force_charge_on_verified_at_ms: at(s.forceChargeOnAtMs), /* MUTANT */',
    why: 'Every ON reads "verified" from the instant it was sent, the night whose ON never took included.',
  },
  {
    id: "OFT-C-xxiii. ★★★ 'omit' and 'write' are exchanged",
    file: NFC,
    find: "  if (nulls !== 'omit') return all;",
    to: "  if (nulls === 'omit') return all; /* MUTANT */",
    why: 'Every later stamp writes its NULLs over what the row holds, and the stamp at the ON names no NULL: a verification the row heard is erased by a record that lost it.',
  },
  {
    id: "OFT-C-xxiv. ★★★ the default is 'omit'",
    file: NFC,
    find: "  nulls: 'write' | 'omit' = 'write',",
    to: "  nulls: 'write' | 'omit' = 'omit', /* MUTANT */",
    why: 'A caller that names no form gets the fate less its NULLs: a fresh ON no longer starts the row\'s fate again.',
  },
  {
    id: "OFT-C-xxv. ★★★ 'omit' keeps every NULL",
    file: NFC,
    find: FATE_OMIT,
    to: '  return Object.fromEntries(Object.entries(all).filter(() => true)) as Partial<ForceChargeOnFateColumns>; /* MUTANT */',
    why: 'The first OFF\'s re-stamp blanks the verified time of a row whose record lost it: a night read back as applied reads "unconfirmed".',
  },
  {
    id: "OFT-C-xxvi. ★★★ 'omit' leaves out a count of 0",
    file: NFC,
    find: FATE_OMIT,
    to: '  return Object.fromEntries(Object.entries(all).filter(([, v]) => v)) as Partial<ForceChargeOnFateColumns>; /* MUTANT */',
    why: 'A later stamp of an ON with no re-issue carries no count: a row whose ON stamp was lost stays "not recorded", and a count handed back to 0 stays at 1.',
  },

  // ══ (P) the ON's own two columns again ══
  {
    id: 'OFT-P-i. ★★★ an ON time that is not finite is written',
    file: NFC,
    find: STAMP_FINITE,
    to: "  if (typeof at !== 'number') return {}; /* MUTANT */",
    why: 'A damaged ON time that is no instant is written over the ON time the row holds: the readers no longer find the hours the force-charge ran.',
  },
  {
    id: 'OFT-P-ii. ★★ only a not-a-number ON time is refused',
    file: NFC,
    find: STAMP_FINITE,
    to: "  if (typeof at !== 'number' || Number.isNaN(at)) return {}; /* MUTANT */",
    why: 'An infinite ON time is handed to the row as the instant the ON was sent.',
  },
  {
    id: 'OFT-P-iii. ★★ an ON time of 0 is no time',
    file: NFC,
    find: STAMP_FINITE,
    to: '  if (!at || !Number.isFinite(at)) return {}; /* MUTANT */',
    why: 'A record whose ON time is 0 restores nothing: the row keeps reading no ON for a night the record says was switched on.',
  },
  {
    id: 'OFT-P-iv. ★★★ the mode is written only for a cost night',
    file: NFC,
    find: STAMP_MODE_TEST,
    to: "  return s.forceChargeMode === 'cost' /* MUTANT */",
    why: 'A line night whose ON stamp was lost gets its ON time back with no mode: the row does not say it charged for the outage line.',
  },
  {
    id: 'OFT-P-v. ★★★ the mode is written only for a line night',
    file: NFC,
    find: STAMP_MODE_TEST,
    to: "  return s.forceChargeMode === 'line' /* MUTANT */",
    why: 'A cost night whose ON stamp was lost gets its ON time back with no mode.',
  },
  {
    id: 'OFT-P-vi. ★★★ any mode the record holds is written',
    file: NFC,
    find: STAMP_MODE_TEST,
    to: '  return s.forceChargeMode != null /* MUTANT */',
    why: 'A damaged mode that is neither "cost" nor "line" is written to a column the status route serves, over the mode the row held.',
  },
  {
    id: 'OFT-P-vii. ★★★ the mode is never written',
    file: NFC,
    find: STAMP_MODE_COLS,
    to: '    ? { force_charge_on_at_ms: at } : { force_charge_on_at_ms: at }; /* MUTANT */',
    why: 'A row whose ON stamp was lost gets its ON time back and never its mode: a cost night and a line night read the same.',
  },
  {
    id: 'OFT-P-viii. ★★★ a record with no mode writes what it holds for one',
    file: NFC,
    find: STAMP_MODE_COLS,
    to: '    ? { force_charge_on_at_ms: at, force_charge_mode: s.forceChargeMode } : { force_charge_on_at_ms: at, force_charge_mode: s.forceChargeMode as never }; /* MUTANT */',
    why: 'A stamp from a record that lost its mode writes NULL over the mode the row holds: a line night no longer says it charged for the outage line.',
  },
  {
    id: 'OFT-P-ix. ★★★ the ON time is left out beside the mode',
    file: NFC,
    find: STAMP_MODE_COLS,
    to: '    ? { force_charge_mode: s.forceChargeMode } : { force_charge_on_at_ms: at }; /* MUTANT */',
    why: 'A row whose ON stamp was lost gets a mode and no ON time: the readiness gate, the hour mask and the status still read a night never switched on.',
  },
  {
    id: "OFT-P-x. ★★★ the mode written is always 'cost'",
    file: NFC,
    find: STAMP_MODE_COLS,
    to: "    ? { force_charge_on_at_ms: at, force_charge_mode: 'cost' } : { force_charge_on_at_ms: at }; /* MUTANT */",
    why: 'Every fate stamp of a line night rewrites its mode to "cost": the row says the night charged for cost.',
  },

  // ══ (V) the verdict ══
  {
    id: "OFT-V-i. ★★★ 'none' needs only the ON time NULL",
    file: NFC,
    find: VERDICT_COUNT,
    to: "  if (row.force_charge_on_at_ms == null) return 'none'; /* MUTANT */\n  if (row.force_charge_on_retries == null) return 'notRecorded';",
    why: 'A row with a fate and no ON time (its ON stamp lost to a restart) reads "none": a verified or failed ON reads as no ON at all.',
  },
  {
    id: "OFT-V-ii. ★★★ no count is always 'none'",
    file: NFC,
    find: VERDICT_COUNT,
    to: "  if (row.force_charge_on_retries == null) return 'none'; /* MUTANT */",
    why: 'A row older than the columns that force-charged reads "none": every night before the release reads as no ON.',
  },
  {
    id: "OFT-V-iii. ★★★ no count is always 'notRecorded'",
    file: NFC,
    find: VERDICT_COUNT,
    to: "  if (row.force_charge_on_retries == null) return 'notRecorded'; /* MUTANT */",
    why: 'A night with no force-charge reads "not recorded": an ON is implied where none was sent.',
  },
  {
    id: "OFT-V-iv. ★★★ 'none' and 'notRecorded' are exchanged",
    file: NFC,
    find: VERDICT_COUNT,
    to: "  if (row.force_charge_on_retries == null) return row.force_charge_on_at_ms == null ? 'notRecorded' : 'none'; /* MUTANT */",
    why: 'A night with no ON reads "not recorded" and an old night that force-charged reads "none".',
  },
  {
    id: 'OFT-V-v. ★★ an absent count is not a NULL count',
    file: NFC,
    find: VERDICT_COUNT,
    to: "  if (row.force_charge_on_retries === null) return row.force_charge_on_at_ms == null ? 'none' : 'notRecorded'; /* MUTANT */",
    why: 'A row object with no count key reads "unconfirmed": a night with no ON reads as one sent and never confirmed.',
  },
  {
    id: 'OFT-V-vi. ★★ an absent ON time is not a NULL ON time',
    file: NFC,
    find: VERDICT_COUNT,
    to: "  if (row.force_charge_on_retries == null) return row.force_charge_on_at_ms === null ? 'none' : 'notRecorded'; /* MUTANT */",
    why: 'A row object with neither key reads "not recorded": an ON is implied where none was sent.',
  },
  {
    id: 'OFT-V-vii. ★★★ a count of 0 is no count',
    file: NFC,
    find: VERDICT_COUNT,
    to: "  if (!row.force_charge_on_retries) return row.force_charge_on_at_ms == null ? 'none' : 'notRecorded'; /* MUTANT */",
    why: 'Every ON with no re-issue reads "not recorded", whatever its fate: the mark that the fate was recorded is not read.',
  },
  {
    id: 'OFT-V-viii. ★★ an ON time of 0 is no ON time',
    file: NFC,
    find: VERDICT_COUNT,
    to: "  if (row.force_charge_on_retries == null) return !row.force_charge_on_at_ms ? 'none' : 'notRecorded'; /* MUTANT */",
    why: 'A row whose ON time is 0 and whose fate was never stamped reads "none".',
  },
  {
    id: 'OFT-V-ix. ★★★ failed wins over verified',
    file: NFC,
    find: VERDICT_BOTH,
    to: "  if (row.force_charge_on_failed_at_ms != null) return 'failed'; /* MUTANT */\n  if (row.force_charge_on_verified_at_ms != null) return 'verified';",
    why: 'An ON that applied late, after the failure warning, reads "failed": a night that force-charged reads as one whose ON never took.',
  },
  {
    id: 'OFT-V-x. ★★★ a verified time is not read',
    file: NFC,
    find: VERDICT_VERIFIED,
    to: '  /* MUTANT */',
    why: 'A verified ON reads "unconfirmed", and a late apply reads "failed".',
  },
  {
    id: 'OFT-V-xi. ★★★ a failure time is not read',
    file: NFC,
    find: VERDICT_FAILED,
    to: '  /* MUTANT */',
    why: 'A night whose ON was judged not applied reads "unconfirmed".',
  },
  {
    id: 'OFT-V-xii. ★★ an absent verified time reads as verified',
    file: NFC,
    find: VERDICT_VERIFIED,
    to: "  if (row.force_charge_on_verified_at_ms !== null) return 'verified'; /* MUTANT */",
    why: 'A row object with a count and no verified key reads "verified": an ON never confirmed reads as applied.',
  },
  {
    id: 'OFT-V-xiii. ★★ an absent failure time reads as failed',
    file: NFC,
    find: VERDICT_FAILED,
    to: "  if (row.force_charge_on_failed_at_ms !== null) return 'failed'; /* MUTANT */",
    why: 'A row object with a count and no failure key reads "failed": an ON never judged reads as not applied.',
  },
  {
    id: 'OFT-V-xiv. ★★ a verified time of 0 is no verification',
    file: NFC,
    find: VERDICT_VERIFIED,
    to: "  if (row.force_charge_on_verified_at_ms) return 'verified'; /* MUTANT */",
    why: 'A row whose verified time is 0 reads "unconfirmed" or "failed".',
  },
  {
    id: 'OFT-V-xv. ★★ a failure time of 0 is no failure',
    file: NFC,
    find: VERDICT_FAILED,
    to: "  if (row.force_charge_on_failed_at_ms) return 'failed'; /* MUTANT */",
    why: 'A row whose failure time is 0 reads "unconfirmed".',
  },
  {
    id: 'OFT-V-xvi. ★★★ an ON with neither verdict reads verified',
    file: NFC,
    find: "  return 'unconfirmed';",
    to: "  return 'verified'; /* MUTANT */",
    why: 'An ON sent and never read back reads "verified": the night the release was written for reads as one that force-charged.',
  },
  {
    id: 'OFT-V-xvii. ★★★ a verified time counts only beside an ON time',
    file: NFC,
    find: VERDICT_VERIFIED,
    to: "  if (row.force_charge_on_verified_at_ms != null && row.force_charge_on_at_ms != null) return 'verified'; /* MUTANT */",
    why: 'A row whose ON stamp was lost and whose verify was stamped reads "unconfirmed": the fate does not decide once the count is set.',
  },
  {
    id: 'OFT-V-xviii. ★★★ a failure time counts only beside an ON time',
    file: NFC,
    find: VERDICT_FAILED,
    to: "  if (row.force_charge_on_failed_at_ms != null && row.force_charge_on_at_ms != null) return 'failed'; /* MUTANT */",
    why: 'A row whose ON stamp was lost and whose failure was stamped reads "unconfirmed".',
  },

  // ══ (R) the schema ══
  {
    id: 'OFT-R-i. ★★★ force_charge_on_failed_at_ms is not in the schema list',
    file: REC,
    find: SCHEMA_FAILED_AT,
    to: '/* MUTANT */',
    why: 'The column is neither added nor in the allowlist: the failure time is dropped from every write in silence and no night reads "failed".',
  },
  {
    id: 'OFT-R-ii. ★★★ force_charge_on_failed_slots is not in the schema list',
    file: REC,
    find: SCHEMA_FAILED_SLOTS,
    to: '/* MUTANT */',
    why: 'The failed slots are dropped from every write in silence: a failed night names no slot.',
  },
  {
    id: 'OFT-R-iii. ★★★ force_charge_on_left_out is not in the schema list',
    file: REC,
    find: SCHEMA_LEFT_OUT,
    to: '/* MUTANT */',
    why: 'The slots left out are dropped from every write in silence: no row says a slot was withheld from the ON.',
  },
  {
    id: 'OFT-R-iv. ★★★ force_charge_on_retries is not in the schema list',
    file: REC,
    find: SCHEMA_RETRIES,
    to: '/* MUTANT */',
    why: 'The count is dropped from every write in silence: every ON reads "not recorded" for good.',
  },
  {
    id: 'OFT-R-v. ★★★ force_charge_on_slots is not in the schema list',
    file: REC,
    find: SCHEMA_SLOTS,
    to: '/* MUTANT */',
    why: 'The slots the ON was sent to are dropped from every write in silence.',
  },
  {
    id: 'OFT-R-vi. ★★★ force_charge_on_verified_at_ms is not in the schema list',
    file: REC,
    find: SCHEMA_VERIFIED_AT,
    to: '/* MUTANT */',
    why: 'The verified time is dropped from every write in silence: no night reads "verified".',
  },
  {
    id: 'OFT-R-vii. ★★ force_charge_on_failed_at_ms is declared REAL',
    file: REC,
    find: SCHEMA_FAILED_AT,
    to: "['force_charge_on_failed_at_ms', 'REAL'], /* MUTANT */",
    why: 'A new database holds the failure instant in a column of another declared type than every other instant of the row and than the documented schema.',
  },
  {
    id: 'OFT-R-viii. ★★ force_charge_on_failed_slots is declared INTEGER',
    file: REC,
    find: SCHEMA_FAILED_SLOTS,
    to: "['force_charge_on_failed_slots', 'INTEGER'], /* MUTANT */",
    why: 'A single failed slot is stored as the number 2 and a pair as the text "2,3": one column reads back as two kinds of value.',
  },
  {
    id: 'OFT-R-ix. ★★ force_charge_on_left_out is declared INTEGER',
    file: REC,
    find: SCHEMA_LEFT_OUT,
    to: "['force_charge_on_left_out', 'INTEGER'], /* MUTANT */",
    why: 'The one slot left out reads back as the number 1 where the documented value is the text "1".',
  },
  {
    id: 'OFT-R-x. ★★ force_charge_on_retries is declared REAL',
    file: REC,
    find: SCHEMA_RETRIES,
    to: "['force_charge_on_retries', 'REAL'], /* MUTANT */",
    why: 'A new database holds the count of re-issues as a REAL: the schema a reader is given does not match the table.',
  },
  {
    id: 'OFT-R-xi. ★★ force_charge_on_slots is declared INTEGER',
    file: REC,
    find: SCHEMA_SLOTS,
    to: "['force_charge_on_slots', 'INTEGER'], /* MUTANT */",
    why: 'An ON sent to one slot reads back as the number 3 and one sent to three as the text "1,2,3".',
  },
  {
    id: 'OFT-R-xii. ★★ force_charge_on_verified_at_ms is declared REAL',
    file: REC,
    find: SCHEMA_VERIFIED_AT,
    to: "['force_charge_on_verified_at_ms', 'REAL'], /* MUTANT */",
    why: 'A new database holds the verified instant in a column of another declared type than the documented schema.',
  },
  {
    id: 'OFT-R-xiii. ★ force_charge_on_failed_at_ms is listed at the end, away from force_charge_mode',
    file: REC,
    find: SCHEMA_L1 + SCHEMA_L2 + SCHEMA_L3,
    to: fateEntryLast(0),
    why: 'A new database gains the six columns in another order than the documented one: the fate columns no longer sit together beside force_charge_mode.',
  },
  {
    id: 'OFT-R-xiv. ★ force_charge_on_failed_slots is listed at the end, away from force_charge_mode',
    file: REC,
    find: SCHEMA_L1 + SCHEMA_L2 + SCHEMA_L3,
    to: fateEntryLast(1),
    why: 'A new database gains the six columns in another order than the documented one.',
  },
  {
    id: 'OFT-R-xv. ★ force_charge_on_left_out is listed at the end, away from force_charge_mode',
    file: REC,
    find: SCHEMA_L1 + SCHEMA_L2 + SCHEMA_L3,
    to: fateEntryLast(2),
    why: 'A new database gains the six columns in another order than the documented one.',
  },
  {
    id: 'OFT-R-xvi. ★ force_charge_on_retries is listed at the end, away from force_charge_mode',
    file: REC,
    find: SCHEMA_L1 + SCHEMA_L2 + SCHEMA_L3,
    to: fateEntryLast(3),
    why: 'A new database gains the six columns in another order than the documented one.',
  },
  {
    id: 'OFT-R-xvii. ★ force_charge_on_slots is listed at the end, away from force_charge_mode',
    file: REC,
    find: SCHEMA_L1 + SCHEMA_L2 + SCHEMA_L3,
    to: fateEntryLast(4),
    why: 'A new database gains the six columns in another order than the documented one.',
  },
  {
    id: 'OFT-R-xviii. ★ force_charge_on_verified_at_ms is listed at the end, away from force_charge_mode',
    file: REC,
    find: SCHEMA_L1 + SCHEMA_L2 + SCHEMA_L3,
    to: fateEntryLast(5),
    why: 'A new database gains the six columns in another order than the documented one.',
  },
  {
    id: 'OFT-R-xix. ★ the six are listed ahead of force_charge_mode',
    file: REC,
    find: SCHEMA_MODE + SCHEMA_L1 + SCHEMA_L2,
    to: SCHEMA_L1 + SCHEMA_L2 + "  ['force_charge_mode', 'TEXT'], /* MUTANT */\n",
    why: 'The fate columns precede the mode they are documented to follow.',
  },

  // ══ (H) the helper ══
  {
    id: 'OFT-H-i. ★★★ every stamp is final unless a caller says otherwise',
    file: IDX,
    find: "function stampForceChargeOnFate(leg: NightActuationState & { leg?: ChargeLegRole }, live: NightActuationState, nulls: 'write' | 'omit', final = false): void {",
    to: "function stampForceChargeOnFate(leg: NightActuationState & { leg?: ChargeLegRole }, live: NightActuationState, nulls: 'write' | 'omit', final = true): void { /* MUTANT */",
    why: 'A re-issue whose record moved on under its writes stamps the copy the tick read at its start: the row takes a count the hand-back had already changed.',
  },
  {
    id: 'OFT-H-ii. ★★★ the record is this leg\'s by its window alone',
    file: IDX,
    find: HELPER_HELD,
    to: '    const held = live.windowStartMs === leg.windowStartMs; /* MUTANT */',
    why: 'Another night armed for the same window is taken for this leg: its ON time, its mode and its verification are written to this night\'s row.',
  },
  {
    id: 'OFT-H-iii. ★★★ the record is this leg\'s by its night alone',
    file: IDX,
    find: HELPER_HELD,
    to: '    const held = live.day === leg.day; /* MUTANT */',
    why: 'The other leg of the same night is taken for this one: the row is stamped with a fate that is not this leg\'s.',
  },
  {
    id: 'OFT-H-iv. ★★★ the same night OR the same window is enough',
    file: IDX,
    find: HELPER_HELD,
    to: '    const held = live.day === leg.day || live.windowStartMs === leg.windowStartMs; /* MUTANT */',
    why: 'A record that shares only the night or only the window is stamped as this leg\'s: another night\'s verified ON reaches a row never confirmed.',
  },
  {
    id: 'OFT-H-v. ★★★ a final stamp is skipped when the record moved on',
    file: IDX,
    find: HELPER_SKIP,
    to: '    if (!held) { /* MUTANT */',
    why: 'The first OFF\'s stamp, the leg\'s last, is lost when the cycle moved the record under the OFF\'s writes: a failure whose own stamp was lost leaves the row "unconfirmed" for good.',
  },
  {
    id: 'OFT-H-vi. ★★★ every stamp that is not final is skipped',
    file: IDX,
    find: HELPER_SKIP,
    to: '    if (!final) { /* MUTANT */',
    why: 'The ON, the verify, the re-issue and the failure stamp nothing: until the first OFF the row reads no fate, and a night still running reads "not recorded".',
  },
  {
    id: 'OFT-H-vii. ★★★ a skipped stamp is made all the same',
    file: IDX,
    find: "      app.log.debug(`night-charge: ledger stamp of the force-charge ON's fate skipped for ${leg.day}: the record no longer holds that leg.`);\n      return;",
    to: "      app.log.debug(`night-charge: ledger stamp of the force-charge ON's fate skipped for ${leg.day}: the record no longer holds that leg.`);\n      /* MUTANT */",
    why: 'A stamp that is not the leg\'s last is made from the copy the tick read at its start: a count or a time the handler had just changed is written as it was before.',
  },
  {
    id: 'OFT-H-viii. ★★★ the record stamped is always the one in memory',
    file: IDX,
    find: HELPER_FROM,
    to: '    const from = live; /* MUTANT */',
    why: 'At the first OFF of a leg whose record moved on, the other night\'s ON time, mode and verification are written to this night\'s row: a night never confirmed reads "verified".',
  },
  {
    id: 'OFT-H-ix. ★★★ the record stamped is always the tick\'s copy',
    file: IDX,
    find: HELPER_FROM,
    to: '    const from = leg; /* MUTANT */',
    why: 'The verify, the re-issue and the failure stamp the record as it was before their handler changed it: the row hears of none of them until the first OFF.',
  },
  {
    id: 'OFT-H-x. ★★★ the two records are exchanged',
    file: IDX,
    find: HELPER_FROM,
    to: '    const from = held ? leg : live; /* MUTANT */',
    why: 'A held record stamps the stale copy, and a final stamp of a record that moved on writes the other night\'s fate to this row.',
  },
  {
    id: 'OFT-H-xi. ★★★ the ON\'s own two columns are not written again',
    file: IDX,
    find: HELPER_WRITE,
    to: '    stampLegOutcome(leg, { ...forceChargeOnFateColumns(from, nulls) }); /* MUTANT */',
    why: 'A row whose ON stamp was lost to a restart keeps no ON time: the readiness gate, the status and the hour mask read a night that was switched on as one that never was.',
  },
  {
    id: 'OFT-H-xii. ★★★ the ON\'s two columns come from the tick\'s copy',
    file: IDX,
    find: HELPER_WRITE,
    to: '    stampLegOutcome(leg, { ...forceChargeOnStampColumns(leg), ...forceChargeOnFateColumns(from, nulls) }); /* MUTANT */',
    why: 'The ON time and the mode written are not the live record\'s: a record that no longer holds an ON still writes one to the row.',
  },
  {
    id: 'OFT-H-xiii. ★★★ the ON\'s two columns come from the record in memory',
    file: IDX,
    find: HELPER_WRITE,
    to: '    stampLegOutcome(leg, { ...forceChargeOnStampColumns(live), ...forceChargeOnFateColumns(from, nulls) }); /* MUTANT */',
    why: 'At the first OFF of a leg whose record moved on, this night\'s row takes the other night\'s ON time and mode: the hours the force-charge ran are read a day out.',
  },
  {
    id: 'OFT-H-xiv. ★★★ the fate comes from the record in memory',
    file: IDX,
    find: HELPER_WRITE,
    to: '    stampLegOutcome(leg, { ...forceChargeOnStampColumns(from), ...forceChargeOnFateColumns(live, nulls) }); /* MUTANT */',
    why: 'At the first OFF of a leg whose record moved on, this night\'s row takes the other night\'s fate: a night never confirmed reads "verified".',
  },
  {
    id: 'OFT-H-xv. ★★★ the fate comes from the tick\'s copy',
    file: IDX,
    find: HELPER_WRITE,
    to: '    stampLegOutcome(leg, { ...forceChargeOnStampColumns(from), ...forceChargeOnFateColumns(leg, nulls) }); /* MUTANT */',
    why: 'The verify and the failure stamp the fate as the tick read it, before the handler recorded them: the row reads "unconfirmed" until the first OFF.',
  },
  {
    id: "OFT-H-xvi. ★★★ every stamp is a 'write'",
    file: IDX,
    find: HELPER_WRITE,
    to: '    stampLegOutcome(leg, { ...forceChargeOnStampColumns(from), ...forceChargeOnFateColumns(from) }); /* MUTANT */',
    why: 'Every later stamp writes its NULLs: a verification the row heard is erased by a record that lost it to a restart.',
  },
  {
    id: "OFT-H-xvii. ★★★ every stamp is an 'omit'",
    file: IDX,
    find: HELPER_WRITE,
    to: "    stampLegOutcome(leg, { ...forceChargeOnStampColumns(from), ...forceChargeOnFateColumns(from, 'omit') }); /* MUTANT */",
    why: 'The ON\'s stamp names no NULL: a second ON on the row keeps the first one\'s verified time and reads "verified" before any readback.',
  },
  {
    id: 'OFT-H-xviii. ★★★ the fate is not written',
    file: IDX,
    find: HELPER_WRITE,
    to: '    stampLegOutcome(leg, { ...forceChargeOnStampColumns(from) }); /* MUTANT */',
    why: 'No fate column is ever stamped: every ON reads "not recorded".',
  },
  {
    id: 'OFT-H-xix. ★★★ the row stamped is the row of the record in memory',
    file: IDX,
    find: HELPER_WRITE,
    to: '    stampLegOutcome(live, { ...forceChargeOnStampColumns(from), ...forceChargeOnFateColumns(from, nulls) }); /* MUTANT */',
    why: 'At the first OFF of a leg whose record moved on, this leg\'s fate is written to the other night\'s row, and this night\'s row gets nothing.',
  },
  {
    id: 'OFT-H-xx. ★★★ a failed stamp throws into the tick',
    file: IDX,
    find: HELPER_CATCH,
    to: '  } catch (e: any) {\n    throw e; /* MUTANT */',
    why: 'A record the derivation cannot read ends the tick at the stamp: the handler\'s log line and its push are lost with the ledger write.',
  },
  {
    id: 'OFT-H-xxi. ★★ a failed stamp leaves no line',
    file: IDX,
    find: HELPER_CATCH,
    to: '  } catch (e: any) {\n    void e; /* MUTANT */',
    why: 'A row left "not recorded" by a stamp that failed cannot be told from one whose stamp was never made: nothing in the log says the write was tried.',
  },
  {
    id: 'OFT-H-xxii. ★★★ a stamp with no column still reaches the recorder (stampLegOutcome)',
    file: IDX,
    find: '  if (Object.keys(cols).length === 0) return;',
    to: '  /* MUTANT */',
    why: 'A final stamp from a record that holds no ON makes a bare upsert: a row appears for a night that has none, and a backup leg\'s stamp makes a row of nothing.',
  },
  {
    id: 'OFT-H-xxiii. ★★★ a backup leg\'s fate is written to the cost leg\'s columns (stampLegOutcome)',
    file: IDX,
    find: '  const cols = legLedgerFields(legRoleOf(leg), fields as Record<string, unknown>) as Partial<NightLedgerRow>;',
    to: "  const cols = legLedgerFields('cost', fields as Record<string, unknown>) as Partial<NightLedgerRow>; /* MUTANT */",
    why: 'A backup leg, which never force-charges for cost, stamps an ON time and a fate on the night\'s row: the row reads a force-charge the cost leg never had.',
  },

  // ══ (X) the six call sites ══
  // ── the ON ──
  {
    id: 'OFT-X-on-i. ★★★ the ON stamps no fate',
    file: IDX,
    find: ON_FATE,
    to: '    /* MUTANT */',
    why: 'A night still charging reads "not recorded", and the slots left out reach the row only with a later stamp.',
  },
  {
    id: "OFT-X-on-ii. ★★★ the ON's fate is an 'omit'",
    file: IDX,
    find: ON_FATE,
    to: "    stampForceChargeOnFate(state, nightActuationMem, 'omit'); /* MUTANT */",
    why: 'A fresh ON does not start the row\'s fate again: an earlier ON\'s verified time on the same row stands, and the new ON reads "verified" before any readback.',
  },
  {
    id: 'OFT-X-on-iii. ★★★ the ON stamps the copy the tick read',
    file: IDX,
    find: ON_FATE,
    to: "    stampForceChargeOnFate(state, state, 'write'); /* MUTANT */",
    why: 'The copy read before the ON holds no ON, so nothing is stamped: the row reads "not recorded" until a later handler runs.',
  },
  {
    id: 'OFT-X-on-iv. ★★★ the fate is folded into the ON\'s own stamp',
    file: IDX,
    find: ON_OWN,
    to: "    stampLegOutcome(state, { force_charge_on_at_ms: nowMs, force_charge_mode: onMode, ...forceChargeOnFateColumns(nightActuationMem, 'write') }); /* MUTANT */",
    why: 'One upsert that fails on a fate column takes the ON time with it: the readiness gate reads a night that was switched on as never switched on.',
  },
  {
    id: 'OFT-X-on-v. ★★ the fate is stamped ahead of the ON\'s own stamp',
    file: IDX,
    find: ON_OWN + ON_NOTE + ON_FATE,
    to: `${ON_FATE} /* MUTANT */\n${ON_OWN}`,
    why: 'The larger upsert, the one that can fail on a missing fate column, is tried ahead of the write the readiness gate reads: the ON time no longer reaches the row first, as the release states it does.',
  },
  // ── the verify ──
  {
    id: 'OFT-X-verify-i. ★★★ the verify stamps no fate',
    file: IDX,
    find: VERIFY_FATE,
    to: '    /* MUTANT */',
    why: 'A night read back as applied reads "unconfirmed" until its first OFF, and for good if that stamp is lost.',
  },
  {
    id: "OFT-X-verify-ii. ★★★ the verify's stamp is a 'write'",
    file: IDX,
    find: VERIFY_FATE,
    to: "    stampForceChargeOnFate(state, nightActuationMem, 'write'); /* MUTANT */",
    why: 'The verify writes NULL over what the row holds: slots left out, or a failure time, that the record lost to a restart are erased.',
  },
  {
    id: 'OFT-X-verify-iii. ★★★ the verify stamps the copy the tick read',
    file: IDX,
    find: VERIFY_FATE,
    to: "    stampForceChargeOnFate(state, state, 'omit'); /* MUTANT */",
    why: 'The copy read before the handler holds no verified time: the row reads "unconfirmed" on a night a readback showed applied.',
  },
  {
    id: 'OFT-X-verify-iv. ★★★ the verify stamps ahead of the record persist',
    file: IDX,
    find: VERIFY_PERSIST + VERIFY_FATE,
    to: "    stampForceChargeOnFate(state, nightActuationMem, 'omit'); /* MUTANT */\n    persistNightActuation({ ...nightActuationMem, forceChargeOnVerifiedAtMs: nowMs });",
    why: 'The record does not hold the verification when it is stamped: the row reads "unconfirmed" on a night a readback showed applied.',
  },
  // ── the re-issue ──
  {
    id: 'OFT-X-retry-i. ★★★ the re-issue stamps no fate',
    file: IDX,
    find: RETRY_FATE,
    to: '    /* MUTANT */',
    why: 'A re-issued ON reads as one with no re-issue until a later stamp.',
  },
  {
    id: "OFT-X-retry-ii. ★★★ the re-issue's stamp is a 'write'",
    file: IDX,
    find: RETRY_FATE,
    to: "    stampForceChargeOnFate(state, nightActuationMem, 'write'); /* MUTANT */",
    why: 'The re-issue writes NULL over what the row holds: slots left out that the record lost to a restart are erased.',
  },
  {
    id: 'OFT-X-retry-iii. ★★★ the re-issue\'s stamp is final',
    file: IDX,
    find: RETRY_FATE,
    to: "    stampForceChargeOnFate(state, nightActuationMem, 'omit', true); /* MUTANT */",
    why: 'A record that moved on under the re-issue\'s writes stamps the copy the tick read: the row takes the count from before the re-issue as if it were the count now.',
  },
  {
    id: 'OFT-X-retry-iv. ★★★ the re-issue stamps the copy the tick read',
    file: IDX,
    find: RETRY_FATE,
    to: "    stampForceChargeOnFate(state, state, 'omit'); /* MUTANT */",
    why: 'The count written is the one the tick read at its start: a re-issue that went out is not on the row.',
  },
  {
    id: 'OFT-X-retry-v. ★★★ the re-issue stamps ahead of the hand-back',
    file: IDX,
    find: RETRY_HANDBACK + RETRY_NOTE + RETRY_FATE,
    to: `    stampForceChargeOnFate(state, nightActuationMem, 'omit'); /* MUTANT */\n${RETRY_HANDBACK.slice(0, -1)}`,
    why: 'A re-issue whose every write was rate-limited and handed back is on the row as one made: the row claims a re-issue the panel never received.',
  },
  // ── the failure verdict ──
  {
    id: 'OFT-X-failed-i. ★★★ the failure stamps no fate',
    file: IDX,
    find: FAILED_FATE,
    to: '    /* MUTANT */',
    why: 'A night whose ON never took reads "unconfirmed" until its first OFF, and for good if that stamp is lost.',
  },
  {
    id: "OFT-X-failed-ii. ★★★ the failure's stamp is a 'write'",
    file: IDX,
    find: FAILED_FATE,
    to: "    stampForceChargeOnFate(state, nightActuationMem, 'write'); /* MUTANT */",
    why: 'The failure writes NULL over what the row holds: slots left out that the record lost to a restart are erased.',
  },
  {
    id: 'OFT-X-failed-iii. ★★★ the failure stamps the copy the tick read',
    file: IDX,
    find: FAILED_FATE,
    to: "    stampForceChargeOnFate(state, state, 'omit'); /* MUTANT */",
    why: 'The copy read before the handler holds no failure: the row reads "unconfirmed" on a night whose ON was judged not applied.',
  },
  {
    id: 'OFT-X-failed-iv. ★★★ an awaited step stands between the record persist and the failure\'s stamp',
    file: IDX,
    find: FAILED_FATE,
    to: "    await Promise.resolve(); /* MUTANT */\n    stampForceChargeOnFate(state, nightActuationMem, 'omit');",
    why: 'A restart during the awaited step loses the stamp, and the handler never runs again: the row reads "unconfirmed" on a night whose ON was judged not applied.',
  },
  {
    id: 'OFT-X-failed-v. ★★★ the failure stamps ahead of the record persist',
    file: IDX,
    find: FAILED_PERSIST + FAILED_ALL + FAILED_FATE,
    to: `    stampForceChargeOnFate(state, nightActuationMem, 'omit'); /* MUTANT */\n${FAILED_PERSIST}${FAILED_ALL.slice(0, FAILED_ALL.indexOf('\n'))}`,
    why: 'The record does not hold the failure when it is stamped: the row reads "unconfirmed" on a night whose ON was judged not applied.',
  },
  // ── the active leg's first OFF ──
  {
    id: 'OFT-X-off-i. ★★★ the first OFF does not re-stamp the fate',
    file: IDX,
    find: OFF_FATE,
    to: '      /* MUTANT */',
    why: 'A stamp lost to a restart is never repaired: a verified night reads "unconfirmed", and a night judged before the upgrade reads "not recorded".',
  },
  {
    id: 'OFT-X-off-ii. ★★★ the first OFF\'s stamp is not final',
    file: IDX,
    find: OFF_FATE,
    to: "      stampForceChargeOnFate(state, nightActuationMem, 'omit'); /* MUTANT */",
    why: 'The leg\'s last stamp is skipped when the cycle moved the record under the OFF\'s writes: a failure whose own stamp was lost leaves the row "unconfirmed" for good.',
  },
  {
    id: "OFT-X-off-iii. ★★★ the first OFF's stamp is a 'write'",
    file: IDX,
    find: OFF_FATE,
    to: "      stampForceChargeOnFate(state, nightActuationMem, 'write', true); /* MUTANT */",
    why: 'The repair erases: a verified time the row heard is blanked by a record that lost it, and the night reads "unconfirmed".',
  },
  {
    id: 'OFT-X-off-iv. ★★★ the first OFF stamps whatever record is in memory, as its own leg',
    file: IDX,
    find: OFF_FATE,
    to: "      stampForceChargeOnFate(nightActuationMem, nightActuationMem, 'omit', true); /* MUTANT */",
    why: 'When the cycle moved the record under the OFF\'s writes, the other night\'s row is stamped and this leg\'s row gets no final stamp.',
  },
  // ── the trailing leg's first OFF ──
  {
    id: 'OFT-X-trail-i. ★★★ the trailing leg\'s first OFF does not re-stamp the fate',
    file: IDX,
    find: TRAIL_FATE,
    to: '      /* MUTANT */',
    why: 'A leg that moved to the trailing slot before its OFF has no tick that repairs a lost stamp: a verified night reads "unconfirmed".',
  },
  {
    id: 'OFT-X-trail-ii. ★★★ the trailing leg\'s first OFF stamp is not final',
    file: IDX,
    find: TRAIL_FATE,
    to: "      stampForceChargeOnFate(t, cur(), 'omit'); /* MUTANT */",
    why: 'The trailing leg\'s last stamp is skipped when the slot was emptied or refilled under the OFF\'s writes: the lost stamp stays lost.',
  },
  {
    id: "OFT-X-trail-iii. ★★★ the trailing leg's first OFF stamp is a 'write'",
    file: IDX,
    find: TRAIL_FATE,
    to: "      stampForceChargeOnFate(t, cur(), 'write', true); /* MUTANT */",
    why: 'The repair erases: a verified time the row heard is blanked by a trailing record that lost it.',
  },
  {
    id: 'OFT-X-trail-iv. ★★★ the trailing leg\'s first OFF stamps whatever the slot holds, as its own leg',
    file: IDX,
    find: TRAIL_FATE,
    to: "      stampForceChargeOnFate(cur(), cur(), 'omit', true); /* MUTANT */",
    why: 'When the slot holds another leg after the OFF\'s writes, that leg\'s row is stamped and this leg\'s row gets no final stamp.',
  },

  // ══ (N) the plan row ══
  {
    id: 'OFT-N-i. ★★★ the plan row names a fate column',
    file: IDX,
    find: '  recorder.recordNightPlan(row);',
    to: '  row.force_charge_on_retries = null; /* MUTANT */\n  recorder.recordNightPlan(row);',
    why: 'A plan re-issued after the ON (the morning refresh, a later evening run) blanks the count: a night whose fate was recorded reads "not recorded".',
  },

  // ══ (D) the readers the release leaves alone ══
  {
    id: 'OFT-D-i. ★★★ forceChargeStateAt reads the failure verdict',
    file: IDX,
    find: "      if (covers(r.force_charge_on_at_ms, r.force_charge_off_at_ms, r.window_end_ms)) return 'on';",
    to: "      if (r.force_charge_on_failed_at_ms == null && covers(r.force_charge_on_at_ms, r.force_charge_off_at_ms, r.window_end_ms)) return 'on'; /* MUTANT */",
    why: 'One reader decides on the fate while the release says none does: the hours of a night whose ON failed are served "off" here and still read as force-charged by the readiness gate and the hour mask.',
  },
  {
    id: 'OFT-D-ii. ★★★ the readiness gate reads the failure verdict',
    file: GATE,
    find: '    if (asNum(r.cushion_line_force_charge_pct) == null || !(truthy(r.actuated) || lineWriteNeverHeld(r) || lineReserveStood(r)) || r.force_charge_on_at_ms != null) return false;',
    to: '    if (asNum(r.cushion_line_force_charge_pct) == null || !(truthy(r.actuated) || lineWriteNeverHeld(r) || lineReserveStood(r)) || (r.force_charge_on_at_ms != null && r.force_charge_on_failed_at_ms == null)) return false; /* MUTANT */',
    why: 'A night whose ON was sent and judged not applied is struck as one never switched on: the gate\'s rule moves on a column the release says it does not read, and rows before the release are graded by another rule than rows after it.',
  },
  {
    id: 'OFT-D-iii. ★★★ the mid-day hour mask reads the failure verdict',
    file: SCORING,
    find: "      || typeof r.actuation_applied_at_ms === 'number' || typeof r.force_charge_on_at_ms === 'number';",
    to: "      || typeof r.actuation_applied_at_ms === 'number' || (typeof r.force_charge_on_at_ms === 'number' && (r as { force_charge_on_failed_at_ms?: number | null }).force_charge_on_failed_at_ms == null); /* MUTANT */",
    why: 'The hours of a mid-day charge whose ON failed on some slots are handed back to the solar learners: a grid charge beside the sun is read as evidence about the arrays.',
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs). Each mutant runs the whole
// subset, with its failing tests named; the subset alone decides.
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({
  name: 'mutate-on-fate', mutants: MUTANTS.map((m) => ({ ...m, tests: SUBSET })), subset: SUBSET, root: REPO,
  perMutantTests: true, typecheck: true, fullSuite: false,
});
