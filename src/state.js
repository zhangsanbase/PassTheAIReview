const { randomUUID } = require('node:crypto');

// ASR sentence identities remain stable when provisional text becomes final.
class Questions {
  constructor() { this.items = []; this.current = null; this.keys = new Map(); this.deleted = []; }
  sentence(session, s, manualQuestions = false) {
    if (s.heartbeat || !s.text?.trim()) return null;
    const key = `${session}:${s.sentence_id ?? s.begin_time}`;
    let q = this.keys.get(key);
    if (q?.deleted) return null; // Late ASR results must not resurrect deleted questions.
    if (!q) {
      if (this.current && !this.current.text && !this.current.submitted && this.current.source === 'manual') {
        this.current.source = 'audio';
        q = this.current;
      } else {
        q = manualQuestions
          ? this.current?.source === 'audio' ? this.current : this.create('', 'audio')
          : this.current && !this.current.submitted && this.current.source === 'audio' ? this.current : this.create('', 'audio');
      }
      q.parts ||= new Map();
      this.keys.set(key, q);
    }
    const previous = q.parts.get(key);
    if (previous?.final) return null; // Duplicate or late provisional results.
    const nextText = s.text.trim();
    const hadPrevious = !!previous;
    q.parts.set(key, { text: nextText, final: !!s.sentence_end });
    if (!q.edited) {
      q.text = [...q.parts.values()].map(p => p.text).join(' ');
    } else if (manualQuestions) {
      if (!hadPrevious && q.baseText === undefined) q.baseText = q.text;
      const trailing = [...q.parts.entries()]
        .filter(([partKey]) => !q.frozenParts?.has(partKey))
        .map(([, part]) => part.text)
        .join(' ');
      q.text = [q.baseText ?? q.text, trailing].filter(Boolean).join(' ');
    }
    q.revision++;
    q.final = [...q.parts.values()].every(p => p.final);
    if (q.final) q.endedAt = s.endedAt || Date.now();
    if (manualQuestions && q.submitted) {
      q.submitted = false;
      if (q.status === 'done' || q.status === 'interrupted') q.status = 'draft';
    }
    return q;
  }
  create(text, source = 'manual') {
    const q = { id: randomUUID(), text, source, revision: 0, submitted: false, final: false, answer: '', status: 'draft', language: 'auto' };
    this.items.push(q); this.current = q; return q;
  }
  edit(id, text, language) {
    let q = this.items.find(x => x.id === id);
    if (id && !q) throw new Error('该问题已不存在，请选择其他问题');
    if (!q && this.current && !this.current.text && !this.current.submitted) q = this.current;
    if (!q) q = this.create(text);
    if (q.text !== text || q.language !== language) {
      q.text = text; q.language = language; q.revision++; q.edited = true; q.submitted = false;
      if (q.parts) q.frozenParts = new Set(q.parts.keys());
      q.baseText = text;
    }
    this.current = q; return q;
  }
  claim(q, force = false) {
    if (!q.text.trim() || (q.submitted && !force)) return false;
    q.submitted = true; q.status = 'generating'; return true;
  }
  merge(id) {
    const index = this.items.findIndex(q => q.id === id);
    const q = this.items[index];
    if (!q) throw new Error('请先选择要合并的问题');
    const included = new Set(q.mergedIds || [q.id]);
    const previous = this.items.slice(0, index).reverse().find(x => x.text.trim() && !(x.mergedIds || [x.id]).some(id => included.has(id)));
    if (!previous) throw new Error('没有可合并的上一题');
    const merged = this.create(`${previous.text}\n${q.text}`, 'manual');
    merged.language = q.language;
    merged.mergedIds = [...(previous.mergedIds || [previous.id]), ...included];
    return merged;
  }
  remove(id) {
    const index = this.items.findIndex(q => q.id === id);
    if (index < 0) throw new Error('该问题已不存在');
    const [q] = this.items.splice(index, 1); q.deleted = true;
    this.deleted.push({ q, index });
    if (this.current?.id === id) this.current = this.items[Math.min(index, this.items.length - 1)] || null;
    return q;
  }
  undo() {
    const removed = this.deleted.pop();
    if (!removed) throw new Error('没有可撤销的删除');
    delete removed.q.deleted;
    this.items.splice(Math.min(removed.index, this.items.length), 0, removed.q);
    this.current = removed.q; return removed.q;
  }
  snapshot() { return this.items.map(({ parts, ...q }) => ({ ...q })); }
}

function languageOf(text, override = 'auto') {
  if (override === 'zh' || override === 'en') return override;
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const words = (text.match(/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*/g) || []).filter(w => /[A-Za-z]/.test(w)).length;
  return han > 0 && han * 3 >= words ? 'zh' : 'en';
}
module.exports = { Questions, languageOf };
