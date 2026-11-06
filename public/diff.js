// Word-level diff (longest common subsequence). Local, deterministic, no dependency.
// Returns [{ type: 'eq' | 'del' | 'add', text }] such that eq+del rebuilds `a` and eq+add rebuilds `b`.
export function diffWords(a, b) {
  const A = String(a ?? '').match(/\s+|\S+/g) || [], B = String(b ?? '').match(/\s+|\S+/g) || [];
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const x = A.slice(s, ea), y = B.slice(s, eb), n = x.length, m = y.length;
  const out = [];
  const push = (type, text) => { if (!text) return; const last = out[out.length - 1]; if (last && last.type === type) last.text += text; else out.push({ type, text }); };
  push('eq', A.slice(0, s).join(''));
  if (n * m > 2_000_000) { push('del', x.join('')); push('add', y.join('')); } // huge edit: coarse but still correct
  else {
    const w = m + 1, L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { push('eq', x[i]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push('del', x[i++]);
      else push('add', y[j++]);
    }
    while (i < n) push('del', x[i++]);
    while (j < m) push('add', y[j++]);
  }
  push('eq', A.slice(ea).join(''));
  return out;
}
