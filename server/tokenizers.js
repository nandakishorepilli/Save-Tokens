// Optional local tokenizers: exact counts with no network call and no key, when a tokenizer package is installed.
// None is a dependency. If a package is missing the tokenizer is simply not offered; counting falls back to estimates.
// A tokenizer is { id, label, note, count(text) -> integer }.
export async function loadLocalTokenizers({ importer = (name) => import(name), extra = [] } = {}) {
  const found = [...extra];
  try {
    const m = await importer('gpt-tokenizer'); // optional: npm install gpt-tokenizer
    if (typeof m.encode === 'function')
      found.push({ id: 'openai-o200k', label: 'OpenAI o200k_base (gpt-tokenizer)', note: 'Counts under the o200k_base encoding used by recent OpenAI models. Text only; not valid for other vendors.', count: (t) => m.encode(t).length });
  } catch { /* not installed */ }
  return found.filter((t) => t && typeof t.id === 'string' && typeof t.count === 'function');
}
