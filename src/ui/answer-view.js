(function (root) {
  function blocks(text) {
    return text.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const heading = line.match(/^\s*【([^】]+)】\s*(.*)$/);
      if (heading) return { kind: 'heading', text: heading[1], tail: heading[2] };
      const paired = line.match(/^\s*(EN|ZH):\s*(.*)$/);
      if (paired) return { kind: paired[1] === 'EN' ? 'english' : 'translation', text: paired[2] };
      return { kind: 'paragraph', text: line };
    });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { blocks };
  else root.AnswerView = { blocks };
})(globalThis);
