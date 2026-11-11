// Compact index for the pinned E5 Unigram vocabulary. No vocabulary pruning or truncation.
import { Tokenizer } from '@huggingface/tokenizers';

export class CompactPrefixIndex {
  constructor(vocabulary) {
    this.words = [...vocabulary].sort();
  }

  *common_prefix_search(chars, begin) {
    let low = 0, high = this.words.length, prefix = '';
    for (let index = begin; index < chars.length; index++) {
      prefix += chars[index];
      let left = low, right = high;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (this.words[middle] < prefix) left = middle + 1;
        else right = middle;
      }
      low = left;
      if (low === high || !this.words[low].startsWith(prefix)) return;
      left = low; right = high;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (this.words[middle].slice(0, prefix.length) <= prefix) left = middle + 1;
        else right = middle;
      }
      high = left;
      if (this.words[low] === prefix) yield prefix;
    }
  }
}

function precompiledNormalizer(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const size = bytes.readUInt32LE(0);
  if (!size || size % 4 || size + 4 >= bytes.length) throw Error('SEMANTIC_TOKENIZER_INVALID');
  // Decode explicitly: the model stores little-endian Darts units, regardless of host endianness.
  const trie = new Uint32Array(size / 4);
  for (let i = 0; i < trie.length; i++) trie[i] = bytes.readUInt32LE(4 + i * 4);
  const strings = bytes.subarray(4 + size);
  const offset = unit => (unit >>> 10) << ((unit & 512) >>> 6);
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  const transform = text => {
    let node = offset(trie[0]);
    for (const byte of Buffer.from(text)) {
      if (byte === 0) break;
      node ^= byte;
      const unit = trie[node];
      if (unit === undefined || (unit & 0x800000ff) !== byte) break;
      node ^= offset(unit);
      if (unit & 256) {
        const start = trie[node] & 0x7fffffff;
        return strings.subarray(start, strings.indexOf(0, start)).toString('utf8');
      }
    }
    return null;
  };
  // HF tokenizers 0.23.2 uses the FIRST matching prefix, with this grapheme boundary rule.
  // Generic NFKC or SentencePiece's longest-prefix rule changes combining marks and Hangul.
  // https://github.com/huggingface/tokenizers/blob/v0.23.2/tokenizers/src/normalizers/precompiled.rs
  // https://github.com/huggingface/spm_precompiled/blob/master/src/lib.rs
  return text => {
    let normalized = '';
    for (const { segment } of segmenter.segment(text)) {
      const mapped = Buffer.byteLength(segment) < 6 ? transform(segment) : null;
      if (mapped !== null) normalized += mapped;
      else for (const char of segment) normalized += transform(char) ?? char;
    }
    return normalized.replace(/ {2,}/g, ' ');
  };
}

export function createCompactTokenizer(config) {
  const normalizers = config.normalizer?.normalizers;
  if (config.model?.type !== 'Unigram' || config.model.unk_id !== 3
    || config.normalizer?.type !== 'Sequence' || normalizers?.length !== 2
    || normalizers[0].type !== 'Precompiled' || normalizers[1].type !== 'Replace'
    || normalizers[1].pattern?.Regex !== ' {2,}' || normalizers[1].content !== ' ') {
    throw Error('SEMANTIC_TOKENIZER_INVALID');
  }
  const full = config.model.vocab;
  // Construct the library's Unigram lattice/postprocessor without its per-character object trie.
  // Keep this dependency pinned: the index replaces a model interface tested against native HF.
  const tokenizer = new Tokenizer({ ...config, model: { ...config.model, vocab: full.slice(0, 4) } },
    { eos_token: '</s>' });
  const model = tokenizer.model;
  model.vocab = full.map(entry => entry[0]);
  model.scores = Float64Array.from(full, entry => entry[1]);
  model.tokens_to_ids = new Map();
  model.min_score = Infinity;
  for (let id = 0; id < model.vocab.length; id++) {
    model.tokens_to_ids.set(model.vocab[id], id);
    model.min_score = Math.min(model.min_score, model.scores[id]);
  }
  model.unk_score = model.min_score - 10;
  model.scores[model.unk_token_id] = model.unk_score;
  model.trie = new CompactPrefixIndex(model.vocab);
  tokenizer.normalizer = precompiledNormalizer(normalizers[0].precompiled_charsmap);
  return text => {
    // Native N-API input replaces unpaired UTF-16 surrogates with U+FFFD.
    const encoded = tokenizer.encode(text.toWellFormed(), { add_special_tokens: true, return_token_type_ids: true });
    return { ids: encoded.ids, mask: encoded.attention_mask, types: encoded.token_type_ids };
  };
}
