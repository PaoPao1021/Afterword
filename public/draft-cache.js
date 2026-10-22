const storageKey = 'afterword.import-draft.v1';
const lifetime = 7 * 86400000;
const maximumLength = 2500000;

export function hasDraftContent(draft) {
  return !!(draft && (draft.text?.trim() || draft.modelText?.trim() || draft.preview?.rows?.length));
}

function text(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('无效草稿字段');
  return value;
}

function snapshot(draft) {
  const rows = draft.preview?.rows ?? null;
  if (rows !== null && (!Array.isArray(rows) || rows.length > 10000)) throw new Error('无效草稿词条');
  return {
    paperId: text(draft.paperId, 100),
    text: text(draft.text, 2000000),
    modelText: text(draft.modelText || '', 20000),
    rows: rows?.map((row, index) => ({
      line: Number.isInteger(row.line) && row.line > 0 ? row.line : index + 1,
      english: text(row.english, 2000000), meaning: text(row.meaning, 2000000),
      raw: text(row.raw || '', 2000000), error: text(row.error || '', 5000),
      excluded: row.excluded === true, strategy: row.strategy === 'replace' ? 'replace' : 'merge',
    })) ?? null,
    generatedBy: draft.preview?.generatedBy === 'model' ? 'model' : null,
  };
}

export function createDraftCache(storage, clock = Date.now) {
  function save(draft) {
    try {
      if (!hasDraftContent(draft)) { storage().removeItem(storageKey); return true; }
      const value = JSON.stringify({ version: 1, savedAt: clock(), draft: snapshot(draft) });
      if (value.length > maximumLength) return false;
      storage().setItem(storageKey, value);
      return true;
    } catch { return false; }
  }
  function load() {
    let value;
    try { value = storage().getItem(storageKey); }
    catch { return { draft: null, state: 'unavailable' }; }
    if (value === null) return { draft: null, state: 'empty' };
    try {
      if (value.length > maximumLength) throw new Error();
      const envelope = JSON.parse(value);
      if (envelope.version !== 1 || !Number.isFinite(envelope.savedAt) || envelope.savedAt > clock() + 60000) throw new Error();
      if (clock() - envelope.savedAt >= lifetime) { storage().removeItem(storageKey); return { draft: null, state: 'expired' }; }
      const source = envelope.draft;
      const clean = snapshot({ ...source, preview: source.rows === null ? null : { rows: source.rows, generatedBy: source.generatedBy } });
      const preview = clean.rows === null ? null : {
        rows: clean.rows.map(row => ({ ...row, kind: 'unchecked', previous: [] })),
        counts: { added: 0, duplicate: 0, conflict: 0, invalid: clean.rows.filter(row => !row.excluded).length, excluded: clean.rows.filter(row => row.excluded).length },
        ignored: 0,
        ...(clean.generatedBy ? { generatedBy: clean.generatedBy } : {}),
      };
      const draft = { paperId: clean.paperId, text: clean.text, modelText: clean.modelText, preview, dirty: !!preview, requestId: null };
      return { draft: hasDraftContent(draft) ? draft : null, state: hasDraftContent(draft) ? 'restored' : 'empty' };
    } catch { return { draft: null, state: 'invalid' }; }
  }
  return { save, load };
}
